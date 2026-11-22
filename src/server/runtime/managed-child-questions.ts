import { z } from "zod";

import type {
  AgentApprovalRequest,
  AgentInputQuestion,
  AgentInputRequest,
  Conversation,
} from "../../shared/contracts";
import { MAX_AGENT_INPUT_QUESTIONS } from "../../shared/contracts/client-command/agent";
import type { RuntimeStore } from "../database";
import type { ProviderHostToolDefinition, ProviderHostToolResult } from "../provider/contracts";
import { scrubSubagentSecrets } from "../provider/subagent-trace";
import { MULTILINE_PATTERN, idSchema, safeMultilineSchema } from "./managed-chat-schemas";
import {
  pendingInteractionForConversation,
  pendingInteractionForOwner,
} from "./pending-interaction-registry";
import type { TurnController } from "./turns/turn-controller";
import { neutralizeUntrustedAgentText, truncateUtf8 } from "./untrusted-agent-text";

export const ANSWER_QUESTION_TOOL_NAME = "inertia_answer_question";
/** The whole `pendingQuestions` list a status or wait result carries. */
export const MAX_PENDING_QUESTIONS_BYTES = 32_768;
/** Matches `agent.input.respond`: at most 20 values of up to 4,000 characters per question. */
export const MAX_ANSWER_VALUES = 20;
export const MAX_ANSWER_TEXT_CHARS = 4_000;

const MAX_HEADER_BYTES = 200;
/**
 * Field caps per projection level. Level 2 fits the largest request a
 * provider sends (4 questions of 20 options) in plain text under the 32 KiB
 * bound; text that JSON must escape heavily can still be left out.
 */
const PROJECTION_LEVELS = [
  { question: 8_000, label: 1_000, description: 2_000 },
  { question: 8_000, label: 1_000, description: 0 },
  { question: 1_000, label: 200, description: 0 },
] as const;
type ProjectionLevel = (typeof PROJECTION_LEVELS)[number];
const CARD_QUESTION_CHARS = 200;
const CARD_ANSWER_CHARS = 300;

/** Provider request ids are UUIDs; a malformed one simply is not pending. */
const REQUEST_ID_PATTERN = "^[0-9A-Fa-f-]{36}$";
const QUESTION_NOT_PENDING = "requestId: not a pending question of that chat; read inertia_get_conversation_status for its current questions.";
const QUESTION_GONE = "That question is no longer pending: it was answered or withdrawn, or its turn ended. Nothing was sent.";
const APPROVAL_REFUSED = "requestId: that is a permission approval; only the user can answer approvals, in that chat.";
const SECRET_REFUSED = "requestId: that asks for a secret; only the user can answer it, in that chat.";
const USER_ONLY_REFUSED = "requestId: only the user can answer that request, in that chat.";

const answerItemSchema = z.object({
  options: z.array(z.number().int().min(1).max(MAX_ANSWER_VALUES))
    .min(1)
    .max(MAX_ANSWER_VALUES)
    .refine((options) => new Set(options).size === options.length, "must not repeat an option")
    .optional(),
  text: safeMultilineSchema(MAX_ANSWER_TEXT_CHARS).optional(),
}).strict().refine((answer) => answer.options !== undefined || answer.text !== undefined, "give options, text, or both");
export const answerQuestionSchema = z.object({
  conversationId: idSchema,
  requestId: z.string().regex(new RegExp(REQUEST_ID_PATTERN, "u"), "expected a requestId from pendingQuestions"),
  answers: z.array(answerItemSchema).min(1).max(MAX_AGENT_INPUT_QUESTIONS),
}).strict();

export const ANSWER_QUESTION_TOOL_DEFINITION: ProviderHostToolDefinition = {
  name: ANSWER_QUESTION_TOOL_NAME,
  description: "Answer a pendingQuestions entry of a chat this chat created: one answer per question, in order, with option `number`s and/or `text` where freeText. Inertia asks the user first.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversationId: { type: "string", format: "uuid" },
      requestId: { type: "string", pattern: REQUEST_ID_PATTERN },
      answers: {
        type: "array",
        minItems: 1,
        maxItems: MAX_AGENT_INPUT_QUESTIONS,
        items: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            options: {
              type: "array",
              minItems: 1,
              maxItems: MAX_ANSWER_VALUES,
              uniqueItems: true,
              items: { type: "integer", minimum: 1, maximum: MAX_ANSWER_VALUES },
            },
            text: { type: "string", maxLength: MAX_ANSWER_TEXT_CHARS, pattern: MULTILINE_PATTERN },
          },
        },
      },
    },
    required: ["conversationId", "requestId", "answers"],
  },
  inputValidator: answerQuestionSchema,
  readOnly: false,
};

export const USER_ONLY_NEXT = "It waits on something only the user can answer here (an approval, a secret, or a question too long to show); ask the user to answer it in that chat.";

export interface QuestionAnswer {
  options?: number[] | undefined;
  text?: string | undefined;
}

/**
 * Whether another agent may see and answer this pending input. Only plain
 * provider questions qualify: never the host's chat chooser, a request whose
 * answer grants a permission (a Kimi plan approval), or one that asks for a
 * secret. Tool approvals and secret cards live outside the input map entirely.
 */
export function agentAnswerable(request: AgentInputRequest): boolean {
  return request.conversationContextRequest === undefined
    && request.grantsPermission !== true
    && request.questions.length > 0
    && request.questions.every((question) => !question.isSecret);
}

/** The answerable pending questions of one chat, oldest first. */
export function pendingQuestionRequests(
  pendingInputs: ReadonlyMap<string, AgentInputRequest> | undefined,
  conversationId: string,
): AgentInputRequest[] {
  if (!pendingInputs) return [];
  return [...pendingInputs.values()].filter((request) =>
    request.conversationId === conversationId && agentAnswerable(request));
}

function freeText(question: AgentInputQuestion): boolean {
  return question.isOther || question.options.length === 0;
}

function cleaned(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  // Another model wrote this text: scrub secrets, then neutralize before the
  // byte cap so the cap holds.
  return truncateUtf8(neutralizeUntrustedAgentText(scrubSubagentSecrets(value.replace(/\0/gu, ""))), maximumBytes);
}

function projectRequest(request: AgentInputRequest, level: ProjectionLevel): Record<string, unknown> {
  let truncated = level.description === 0 && request.questions.some((question) =>
    question.options.some((option) => option.description.length > 0));
  const field = (value: string, maximumBytes: number): string => {
    const result = cleaned(value, maximumBytes);
    truncated ||= result.truncated;
    return result.text;
  };
  const questions = request.questions.map((question) => ({
    header: field(question.header, MAX_HEADER_BYTES),
    question: field(question.question, level.question),
    options: question.options.map((option, index) => {
      const description = level.description > 0 ? field(option.description, level.description) : "";
      return {
        number: index + 1,
        label: field(option.label, level.label),
        ...(description ? { description } : {}),
      };
    }),
    multiSelect: question.allowMultiple,
    freeText: freeText(question),
  }));
  return { requestId: request.id, questions, ...(truncated ? { truncated: true } : {}) };
}

/**
 * The status fields that describe a chat's pending questions: each
 * answerable request with numbered options, within `budgetBytes`. A request
 * that does not fit drops its option descriptions, then shortens its question
 * and option text, and one that still does not fit is left out and counted.
 * `next` sends the parent to the user when the chat waits on something it
 * cannot answer.
 */
export function pendingQuestionStatus(
  pendingInputs: ReadonlyMap<string, AgentInputRequest> | undefined,
  conversationId: string,
  needsInput: boolean,
  budgetBytes = MAX_PENDING_QUESTIONS_BYTES,
): Record<string, unknown> {
  const shown: Record<string, unknown>[] = [];
  let omitted = 0;
  let bytes = 2;
  for (const request of pendingQuestionRequests(pendingInputs, conversationId)) {
    const candidate = PROJECTION_LEVELS
      .map((level) => projectRequest(request, level))
      .map((projected) => ({ projected, size: Buffer.byteLength(JSON.stringify(projected), "utf8") + 1 }))
      .find(({ size }) => bytes + size <= budgetBytes);
    if (!candidate) {
      omitted += 1;
      continue;
    }
    shown.push(candidate.projected);
    bytes += candidate.size;
  }
  return {
    ...(shown.length > 0 ? { pendingQuestions: shown } : {}),
    ...(omitted > 0 ? { omittedQuestions: omitted } : {}),
    ...((needsInput && shown.length === 0) || omitted > 0 ? { next: USER_ONLY_NEXT } : {}),
  };
}

function issue(path: Array<string | number>, message: string): z.core.$ZodIssue {
  return { code: "custom", path, message, input: undefined };
}

/**
 * Maps one answer per question to the option ids and free text that
 * `agent.input.respond` takes, with the same rules: every question answered,
 * a single-select question exactly one value, and free text only where the
 * question allows it. Problems surface as `invalid_arguments` lines.
 */
export function providerAnswers(
  questions: readonly AgentInputQuestion[],
  answers: readonly QuestionAnswer[],
): Record<string, string[]> {
  if (answers.length !== questions.length) {
    throw new z.ZodError([issue(["answers"], `expected ${questions.length} ${questions.length === 1 ? "answer" : "answers"}, one per question in order`)]);
  }
  const problems: z.core.$ZodIssue[] = [];
  const result: Record<string, string[]> = {};
  questions.forEach((question, index) => {
    const answer = answers[index]!;
    const label = `question ${index + 1}`;
    const values: string[] = [];
    for (const number of answer.options ?? []) {
      const option = question.options[number - 1];
      if (option) values.push(option.id);
      else {
        problems.push(issue(["answers", index, "options"], question.options.length === 0
          ? `${label} takes text only`
          : `${label} has options 1 to ${question.options.length}`));
        break;
      }
    }
    if (answer.text !== undefined) {
      if (freeText(question)) values.push(answer.text);
      else problems.push(issue(["answers", index, "text"], `${label} takes only its options`));
    }
    const count = (answer.options?.length ?? 0) + (answer.text === undefined ? 0 : 1);
    if (!question.allowMultiple && count > 1) {
      problems.push(issue(["answers", index], `${label} takes one option or text, not both or several`));
    } else if (count > MAX_ANSWER_VALUES) {
      problems.push(issue(["answers", index], `${label} takes at most ${MAX_ANSWER_VALUES} values`));
    }
    result[question.id] = values;
  });
  if (problems.length > 0) throw new z.ZodError(problems);
  return result;
}

function oneLine(value: string, maximum: number): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= maximum ? flat : `${flat.slice(0, maximum - 1)}…`;
}

/** The approval card's detail: each question with the answer the agent proposes. */
export function answerApprovalDetail(
  conversationId: string,
  questions: readonly AgentInputQuestion[],
  answers: readonly QuestionAnswer[],
): string {
  const lines = questions.map((question, index) => {
    const answer = answers[index] ?? {};
    const chosen = [
      ...(answer.options ?? []).map((number) => question.options[number - 1]?.label ?? `option ${number}`),
      ...(answer.text === undefined ? [] : [`“${answer.text}”`]),
    ].join(", ");
    return `${oneLine(question.question, CARD_QUESTION_CHARS)} → ${oneLine(chosen, CARD_ANSWER_CHARS)}`;
  });
  return [`Target ${conversationId}`, ...lines].join(" · ");
}

export interface ManagedQuestionDependencies {
  store: Pick<RuntimeStore, "transcriptRepository" | "agentThreadManagement">;
  turns: Pick<TurnController, "respondToInput">;
  /** Provider questions awaiting an answer, shared with the turn controller. */
  pendingInputs?: ReadonlyMap<string, AgentInputRequest>;
  /** Provider approvals awaiting the user, read only to refuse answering one. */
  pendingApprovals?: ReadonlyMap<string, AgentApprovalRequest>;
  broadcastSnapshot(): void;
  now(): string;
}

/**
 * The pending question `args` names on `target`, a chat the caller manages,
 * with its answers checked against the question. Approvals, secret requests,
 * the chat chooser and permission-granting questions are refused by name.
 */
export function findPendingQuestion(
  dependencies: ManagedQuestionDependencies,
  target: Conversation,
  args: unknown,
): AgentInputRequest {
  const input = answerQuestionSchema.parse(args);
  const request = dependencies.pendingInputs
    ? pendingInteractionForConversation(dependencies.pendingInputs, target.id, input.requestId)
    : undefined;
  if (!request) {
    if (
      dependencies.pendingApprovals
      && pendingInteractionForConversation(dependencies.pendingApprovals, target.id, input.requestId)
    ) throw new Error(APPROVAL_REFUSED);
    if (dependencies.store.transcriptRepository.secretRequests.find(input.requestId)?.conversationId === target.id) {
      throw new Error(SECRET_REFUSED);
    }
    throw new Error(QUESTION_NOT_PENDING);
  }
  if (!agentAnswerable(request)) {
    throw new Error(request.questions.some((question) => question.isSecret) ? SECRET_REFUSED : USER_ONLY_REFUSED);
  }
  providerAnswers(request.questions, input.answers);
  return request;
}

/**
 * Sends an approved answer, only while exactly the request the user saw on
 * the card is pending: same provider turn and identity, and not replaced.
 * The turn controller's `respondToInput` is where `agent.input.respond` ends.
 */
export function sendQuestionAnswer(
  dependencies: ManagedQuestionDependencies,
  target: Conversation,
  args: unknown,
  operationId: string,
  approved: AgentInputRequest,
): ProviderHostToolResult {
  const input = answerQuestionSchema.parse(args);
  const pending = dependencies.pendingInputs
    ? pendingInteractionForOwner(dependencies.pendingInputs, approved, approved.id)
    : undefined;
  if (pending !== approved || pending.conversationId !== target.id) throw new Error(QUESTION_GONE);
  const answers = providerAnswers(pending.questions, input.answers);
  dependencies.store.agentThreadManagement.transition(
    operationId,
    ["approved"],
    "dispatching",
    { childConversationId: target.id },
    dependencies.now(),
  );
  if (!dependencies.turns.respondToInput(target.id, pending.id, answers)) throw new Error(QUESTION_GONE);
  dependencies.broadcastSnapshot();
  return {
    success: true,
    text: JSON.stringify({ conversationId: target.id, requestId: pending.id, answered: true }),
  };
}
