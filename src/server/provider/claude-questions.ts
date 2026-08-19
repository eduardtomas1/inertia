import type { AgentInputRequest } from "./interactions";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_INPUT_QUESTIONS = 4;
const MAX_INPUT_OPTIONS = 4;

export function claudeQuestions(
  requestId: string,
  toolUseId: string,
  input: Record<string, unknown>,
): AgentInputRequest {
  if (!Array.isArray(input.questions)) {
    throw new Error("Claude sent an invalid question request.");
  }
  const questions = input.questions;
  if (questions.length === 0) {
    throw new Error("Claude sent an empty question request.");
  }
  if (questions.length > MAX_INPUT_QUESTIONS) {
    throw new Error(`Claude sent more than ${MAX_INPUT_QUESTIONS} questions.`);
  }
  const identityPrefix = (toolUseId || requestId).slice(0, 96);
  const prompts = new Set<string>();
  return {
    requestId,
    autoResolutionMs: null,
    questions: questions.map((value, index) => {
      const question = objectValue(value);
      if (!question) {
        throw new Error(`Claude sent an invalid question at position ${index + 1}.`);
      }
      const text = strictClaudeText(
        question.question,
        `question ${index + 1}`,
      );
      if (prompts.has(text)) {
        throw new Error("Claude sent duplicate question prompts.");
      }
      prompts.add(text);
      const header = strictClaudeText(
        question.header,
        `question ${index + 1} header`,
      );
      if (!Array.isArray(question.options)) {
        throw new Error(`Claude sent invalid options for question ${index + 1}.`);
      }
      const options = question.options;
      if (options.length > MAX_INPUT_OPTIONS) {
        throw new Error(
          `Claude sent more than ${MAX_INPUT_OPTIONS} options for question ${index + 1}.`,
        );
      }
      if (
        question.multiSelect !== undefined
        && typeof question.multiSelect !== "boolean"
      ) {
        throw new Error(`Claude sent an invalid selection mode for question ${index + 1}.`);
      }
      if (
        question.allowMultiple !== undefined
        && typeof question.allowMultiple !== "boolean"
      ) {
        throw new Error(`Claude sent an invalid selection mode for question ${index + 1}.`);
      }
      const optionLabels = new Set<string>();
      return {
        id: `${identityPrefix}:question:${index + 1}`,
        header,
        question: text,
        isOther: true,
        isSecret: false,
        allowMultiple:
          question.multiSelect === true || question.allowMultiple === true,
        options: options.map((option, optionIndex) => {
          const item = objectValue(option);
          if (!item) {
            throw new Error(
              `Claude sent an invalid option ${optionIndex + 1} for question ${index + 1}.`,
            );
          }
          const label = strictClaudeText(
            item.label,
            `option ${optionIndex + 1} label`,
          );
          if (optionLabels.has(label)) {
            throw new Error(
              `Claude sent a duplicate option label for question ${index + 1}.`,
            );
          }
          optionLabels.add(label);
          return {
            id: `option-${optionIndex + 1}`,
            label,
            description: strictClaudeText(
              item.description,
              `option ${optionIndex + 1} description`,
              true,
            ),
          };
        }),
      };
    }),
  };
}

function strictClaudeText(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || value.includes("\0")
    || value.length > MAX_EVENT_TEXT_CHARS
    || (!allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(`Claude sent an invalid ${label}.`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
