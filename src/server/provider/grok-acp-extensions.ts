import type { AgentInputRequest } from "./interactions";
import {
  interactionDisplayIdentity,
  isSafeInteractionDisplayText,
} from "./approval-display";

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 20;
const MAX_ID_CHARS = 256;
const MAX_QUESTION_CHARS = 16_384;
const MAX_OPTION_LABEL_CHARS = 512;
const MAX_OPTION_DESCRIPTION_CHARS = 2_048;
const MAX_PLAN_CHARS = 256 * 1024;

export const GROK_QUESTION_METHODS = ["_x.ai/ask_user_question", "x.ai/ask_user_question"] as const;
export const GROK_EXIT_PLAN_METHODS = ["_x.ai/exit_plan_mode", "x.ai/exit_plan_mode"] as const;

export const GROK_PLAN_CAPTURED_RESPONSE = {
  outcome: "abandoned",
  feedback: "Inertia showed your proposed plan to the user. Stop here and wait for their feedback or an implementation request in a later turn.",
} as const;

export const GROK_QUESTION_CANCELLED_RESPONSE = { outcome: "cancelled" } as const;

export interface GrokQuestion {
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface GrokQuestionRequest {
  sessionId: string;
  toolCallId: string;
  questions: GrokQuestion[];
}

export interface GrokExitPlanRequest {
  sessionId: string;
  toolCallId: string;
  plan: string | null;
}

export interface GrokQuestionResponse {
  outcome: "accepted";
  answers: Record<string, string[]>;
  annotations?: Record<string, { notes: string }>;
}

export function parseGrokQuestionRequest(value: unknown): GrokQuestionRequest {
  const record = unwrapExtensionParams(value, "Grok question request");
  const rawQuestions = record.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("Grok sent a question request without questions.");
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    throw new Error(`Grok sent more than ${MAX_QUESTIONS} questions.`);
  }
  const prompts = new Set<string>();
  return {
    sessionId: requireId(record.sessionId, "sessionId"),
    toolCallId: requireId(record.toolCallId, "toolCallId"),
    questions: rawQuestions.map((raw, questionIndex) => {
      const question = requireObject(raw, "question");
      const prompt = requireText(question.question, "question", MAX_QUESTION_CHARS, true);
      const promptIdentity = interactionDisplayIdentity(prompt);
      if (prompts.has(promptIdentity)) throw new Error("Grok sent duplicate questions.");
      prompts.add(promptIdentity);
      const rawOptions = question.options;
      if (!Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS) {
        throw new Error(`Grok sent an invalid option list for question ${questionIndex + 1}.`);
      }
      const labels = new Set<string>();
      return {
        question: prompt,
        multiSelect: question.multiSelect === true,
        options: rawOptions.map((rawOption) => {
          const option = requireObject(rawOption, "question option");
          const label = requireText(option.label, "option label", MAX_OPTION_LABEL_CHARS);
          const labelIdentity = interactionDisplayIdentity(label);
          if (labels.has(labelIdentity)) {
            throw new Error(`Grok sent duplicate option labels for question ${questionIndex + 1}.`);
          }
          labels.add(labelIdentity);
          const description = option.description === undefined || option.description === null
            ? ""
            : requireText(option.description, "option description", MAX_OPTION_DESCRIPTION_CHARS, true);
          return { label, description };
        }),
      };
    }),
  };
}

export function grokInputRequest(
  requestId: string,
  request: GrokQuestionRequest,
): AgentInputRequest {
  return {
    requestId,
    autoResolutionMs: null,
    questions: request.questions.map((question, questionIndex) => ({
      id: grokQuestionId(questionIndex),
      header: "Question",
      question: question.question,
      isOther: true,
      isSecret: false,
      allowMultiple: question.multiSelect,
      options: question.options.map((option, optionIndex) => ({
        id: grokOptionId(optionIndex),
        label: option.label,
        description: option.description,
      })),
    })),
  };
}

export function grokQuestionResponse(
  request: GrokQuestionRequest,
  answers: Record<string, string[]>,
): GrokQuestionResponse {
  const selected: Record<string, string[]> = {};
  const annotations: Record<string, { notes: string }> = {};
  request.questions.forEach((question, questionIndex) => {
    const values = (answers[grokQuestionId(questionIndex)] ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length === 0) return;
    const labels: string[] = [];
    const notes: string[] = [];
    for (const value of values) {
      const option = question.options.find((candidate, optionIndex) =>
        grokOptionId(optionIndex) === value || candidate.label === value);
      if (option) labels.push(option.label);
      else notes.push(value);
    }
    selected[question.question] = labels.length > 0 ? labels : ["Other"];
    if (notes.length > 0) annotations[question.question] = { notes: notes.join("\n") };
  });
  return {
    outcome: "accepted",
    answers: selected,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

export function parseGrokExitPlanRequest(value: unknown): GrokExitPlanRequest {
  const record = unwrapExtensionParams(value, "Grok plan request");
  const content = record.planContent;
  if (content !== undefined && content !== null && typeof content !== "string") {
    throw new Error("Grok sent a plan that is not text.");
  }
  const plan = typeof content === "string" ? content.trim().slice(0, MAX_PLAN_CHARS) : "";
  return {
    sessionId: requireId(record.sessionId, "sessionId"),
    toolCallId: requireId(record.toolCallId, "toolCallId"),
    plan: plan || null,
  };
}

function grokQuestionId(index: number): string {
  return `question-${index + 1}`;
}

function grokOptionId(index: number): string {
  return `option-${index + 1}`;
}

function unwrapExtensionParams(value: unknown, label: string): Record<string, unknown> {
  const record = requireObject(value, label);
  return typeof record.method === "string" && record.params !== undefined
    ? requireObject(record.params, label)
    : record;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) {
    throw new Error(`Grok sent an invalid ${label}.`);
  }
  return value;
}

function requireText(
  value: unknown,
  label: string,
  maxChars: number,
  allowLineBreaks = false,
): string {
  if (!isSafeInteractionDisplayText(value, { maxChars, allowLineBreaks })) {
    throw new Error(`Grok sent an unsafe or oversized ${label}.`);
  }
  return value;
}
