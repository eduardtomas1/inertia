import { randomBytes } from "node:crypto";

import {
  createOpencodeClient,
  type OpencodeClient,
  type QuestionInfo,
} from "@opencode-ai/sdk/v2";

import { environmentValue } from "../environment";
import {
  interactionDisplayIdentity,
  isSafeInteractionDisplayText,
} from "./approval-display";
import type { AgentInputRequest } from "./interactions";

const MAX_INTERACTION_ID_CHARS = 256;
const MAX_QUESTION_CHARS = 16_384;
const MAX_HEADER_CHARS = 256;
const MAX_OPTION_LABEL_CHARS = 512;
const MAX_OPTION_DESCRIPTION_CHARS = 4_096;
const MAX_INPUT_QUESTIONS = 3;
const MAX_INPUT_OPTIONS = 20;

export interface OwnedOpenCodeCredentials {
  username: string;
  password: string;
}

export function ownedOpenCodeCredentials(
  environment: NodeJS.ProcessEnv,
): OwnedOpenCodeCredentials {
  return {
    username: environmentValue(environment, "OPENCODE_SERVER_USERNAME")
      ?? "opencode",
    password: environmentValue(environment, "OPENCODE_SERVER_PASSWORD")
      || randomBytes(32).toString("base64url"),
  };
}

export function ownedOpenCodeEnvironment(
  environment: NodeJS.ProcessEnv,
  credentials: OwnedOpenCodeCredentials,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      !["OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD"]
        .includes(key.toUpperCase())),
  );
  return {
    ...inherited,
    OPENCODE_SERVER_USERNAME: credentials.username,
    OPENCODE_SERVER_PASSWORD: credentials.password,
  };
}

export function createOwnedOpenCodeClient(
  baseUrl: string,
  directory: string,
  credentials: OwnedOpenCodeCredentials,
): OpencodeClient {
  const authorization = `Basic ${Buffer.from(
    `${credentials.username}:${credentials.password}`,
    "utf8",
  ).toString("base64")}`;
  return createOpencodeClient({
    baseUrl,
    directory,
    throwOnError: true,
    headers: { Authorization: authorization },
  });
}

export function openCodeInteractionId(
  value: unknown,
  kind: "permission" | "question",
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_INTERACTION_ID_CHARS
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error(`OpenCode sent an invalid ${kind} request ID.`);
  }
  return value;
}

export function openCodeQuestionPayload(value: unknown): QuestionInfo[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("OpenCode sent an invalid question request.");
  }
  if (value.length > MAX_INPUT_QUESTIONS) {
    throw new Error("OpenCode sent more questions than Inertia can represent safely.");
  }
  const promptIdentities = new Set<string>();
  return value.map((rawQuestion, questionIndex) => {
    const question = objectValue(rawQuestion);
    if (
      !question
      || typeof question.question !== "string"
      || typeof question.header !== "string"
      || !Array.isArray(question.options)
      || (question.multiple !== undefined && typeof question.multiple !== "boolean")
      || (question.custom !== undefined && typeof question.custom !== "boolean")
    ) {
      throw new Error(`OpenCode sent an invalid question at position ${questionIndex + 1}.`);
    }
    if (question.options.length > MAX_INPUT_OPTIONS) {
      throw new Error(`OpenCode sent too many options for question ${questionIndex + 1}.`);
    }
    const prompt = strictOpenCodeInteractionText(
      question.question,
      `question ${questionIndex + 1} prompt`,
      MAX_QUESTION_CHARS,
      true,
    );
    const promptIdentity = interactionDisplayIdentity(prompt);
    if (promptIdentities.has(promptIdentity)) {
      throw new Error("OpenCode sent duplicate question prompts.");
    }
    promptIdentities.add(promptIdentity);
    const header = strictOpenCodeInteractionText(
      question.header,
      `question ${questionIndex + 1} header`,
      MAX_HEADER_CHARS,
    );
    const optionLabelIdentities = new Set<string>();
    const options = question.options.map((rawOption, optionIndex) => {
      const option = objectValue(rawOption);
      if (
        !option
        || typeof option.label !== "string"
        || typeof option.description !== "string"
      ) {
        throw new Error(
          `OpenCode sent an invalid option ${optionIndex + 1} for question ${questionIndex + 1}.`,
        );
      }
      const label = strictOpenCodeInteractionText(
        option.label,
        `option ${optionIndex + 1} label for question ${questionIndex + 1}`,
        MAX_OPTION_LABEL_CHARS,
      );
      const labelIdentity = interactionDisplayIdentity(label);
      if (optionLabelIdentities.has(labelIdentity)) {
        throw new Error(
          `OpenCode sent a duplicate option label for question ${questionIndex + 1}.`,
        );
      }
      optionLabelIdentities.add(labelIdentity);
      return {
        label,
        description: strictOpenCodeInteractionText(
          option.description,
          `option ${optionIndex + 1} description for question ${questionIndex + 1}`,
          MAX_OPTION_DESCRIPTION_CHARS,
          true,
        ),
      };
    });
    return {
      question: prompt,
      header,
      options,
      ...(question.multiple !== undefined ? { multiple: question.multiple } : {}),
      ...(question.custom !== undefined ? { custom: question.custom } : {}),
    };
  });
}

export function openCodeQuestions(
  requestId: string,
  questions: QuestionInfo[],
): AgentInputRequest {
  return {
    requestId,
    autoResolutionMs: null,
    questions: questions.map((question, index) => ({
      id: openCodeQuestionId(index),
      header: question.header,
      question: question.question,
      isOther: question.custom !== false,
      isSecret: false,
      allowMultiple: question.multiple === true,
      options: question.options.map((option, optionIndex) => ({
        id: openCodeOptionId(optionIndex),
        label: option.label,
        description: option.description,
      })),
    })),
  };
}

export function openCodeQuestionId(index: number): string {
  return `question-${index + 1}`;
}

export function openCodeOptionId(index: number): string {
  return `option-${index + 1}`;
}

function strictOpenCodeInteractionText(
  value: unknown,
  label: string,
  maxChars: number,
  allowLineBreaks = false,
): string {
  if (!isSafeInteractionDisplayText(value, { allowLineBreaks, maxChars })) {
    throw new Error(`OpenCode sent invalid ${label}.`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
