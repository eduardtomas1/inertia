import type { AgentInputRequest, AgentPlanStep } from "./interactions";
import {
  interactionDisplayIdentity,
  isSafeInteractionDisplayText,
} from "./approval-display";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_QUESTION_CHARS = 16_384;
const MAX_QUESTION_TITLE_CHARS = 256;
const MAX_OPTION_LABEL_CHARS = 512;
const MAX_INPUT_QUESTIONS = 3;
const MAX_INPUT_OPTIONS = 20;

export interface CursorQuestionParams {
  toolCallId: string;
  title?: string;
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
}

export interface CursorTodo {
  id?: string;
  content?: string;
  title?: string;
  status?: string;
}

export interface CursorPlanParams {
  toolCallId: string;
  plan: string;
  todos: CursorTodo[];
}

export interface CursorTodosParams {
  toolCallId: string;
  todos: CursorTodo[];
  merge: boolean;
}

export interface CursorTaskParams {
  toolCallId: string;
  description: string;
  prompt: string;
  subagentType: string;
  model?: string;
  agentId?: string;
  durationMs?: number;
}

export interface CursorGenerateImageParams {
  toolCallId: string;
  description: string;
  filePath?: string;
  referenceImagePaths: string[];
}

export function parseCursorQuestionRequest(
  value: unknown,
): CursorQuestionParams {
  const record = requireObject(value, "Cursor question request");
  const rawQuestions = requireArray(record.questions, "questions");
  if (rawQuestions.length === 0) {
    throw new Error("Cursor sent an empty question request.");
  }
  if (rawQuestions.length > MAX_INPUT_QUESTIONS) {
    throw new Error(`Cursor sent more than ${MAX_INPUT_QUESTIONS} questions.`);
  }
  const questionIds = new Set<string>();
  const questionPrompts = new Set<string>();
  return {
    toolCallId: requireString(record.toolCallId, "toolCallId"),
    ...(typeof record.title === "string"
      ? {
          title: requireInteractionText(
            record.title,
            "title",
            MAX_QUESTION_TITLE_CHARS,
          ),
        }
      : {}),
    questions: rawQuestions.map((raw, questionIndex) => {
      const question = requireObject(raw, "question");
      const questionId = requireNativeId(question.id, "question.id", 120);
      if (questionIds.has(questionId)) {
        throw new Error(`Cursor sent duplicate question ID '${questionId}'.`);
      }
      questionIds.add(questionId);
      const prompt = requireInteractionText(
        question.prompt,
        "question.prompt",
        MAX_QUESTION_CHARS,
        true,
      );
      const promptIdentity = interactionDisplayIdentity(prompt);
      if (questionPrompts.has(promptIdentity)) {
        throw new Error("Cursor sent duplicate question prompts.");
      }
      questionPrompts.add(promptIdentity);
      const rawOptions = requireArray(question.options, "question.options");
      if (rawOptions.length > MAX_INPUT_OPTIONS) {
        throw new Error(
          `Cursor sent more than ${MAX_INPUT_OPTIONS} options for question ${questionIndex + 1}.`,
        );
      }
      const optionIds = new Set<string>();
      const optionLabels = new Set<string>();
      return {
        id: questionId,
        prompt,
        options: rawOptions.map((rawOption) => {
          const option = requireObject(rawOption, "question option");
          const optionId = requireNativeId(option.id, "option.id", 160);
          if (optionIds.has(optionId)) {
            throw new Error(
              `Cursor sent duplicate option ID '${optionId}' for question ${questionIndex + 1}.`,
            );
          }
          optionIds.add(optionId);
          const label = requireInteractionText(
            option.label,
            "option.label",
            MAX_OPTION_LABEL_CHARS,
          );
          const labelIdentity = interactionDisplayIdentity(label);
          if (optionLabels.has(labelIdentity)) {
            throw new Error(
              `Cursor sent duplicate option labels for question ${questionIndex + 1}.`,
            );
          }
          optionLabels.add(labelIdentity);
          return {
            id: optionId,
            label,
          };
        }),
        ...(typeof question.allowMultiple === "boolean"
          ? { allowMultiple: question.allowMultiple }
          : {}),
      };
    }),
  };
}

export function parseCursorPlanRequest(value: unknown): CursorPlanParams {
  const record = requireObject(value, "Cursor plan request");
  return {
    toolCallId: requireString(record.toolCallId, "toolCallId"),
    plan: requireString(record.plan, "plan"),
    todos: parseTodos(record.todos),
  };
}

export function parseCursorTodosRequest(value: unknown): CursorTodosParams {
  const record = requireObject(value, "Cursor todo request");
  if (typeof record.merge !== "boolean") {
    throw new Error("Cursor todo request is missing merge.");
  }
  return {
    toolCallId: requireString(record.toolCallId, "toolCallId"),
    todos: parseTodos(record.todos),
    merge: record.merge,
  };
}

export function parseCursorTaskNotification(value: unknown): CursorTaskParams {
  const record = requireObject(value, "Cursor task notification");
  const rawSubagentType = record.subagentType;
  const subagentType = typeof rawSubagentType === "string"
    ? requireString(rawSubagentType, "subagentType")
    : requireString(
      requireObject(rawSubagentType, "subagentType").custom,
      "subagentType.custom",
    );
  const durationMs = record.durationMs;
  if (
    durationMs !== undefined
    && (
      typeof durationMs !== "number"
      || !Number.isSafeInteger(durationMs)
      || durationMs < 0
    )
  ) {
    throw new Error("Cursor task durationMs must be a non-negative safe integer.");
  }
  return {
    toolCallId: requireNativeId(record.toolCallId, "toolCallId", 1_000),
    description: requireString(record.description, "description"),
    prompt: requireString(record.prompt, "prompt"),
    subagentType: bounded(subagentType),
    ...(typeof record.model === "string"
      ? { model: requireString(record.model, "model") }
      : {}),
    ...(typeof record.agentId === "string"
      ? { agentId: requireNativeId(record.agentId, "agentId", 1_000) }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function parseCursorGenerateImageNotification(
  value: unknown,
): CursorGenerateImageParams {
  const record = requireObject(value, "Cursor generated-image notification");
  const referenceImagePaths = record.referenceImagePaths === undefined
    ? []
    : requireArray(record.referenceImagePaths, "referenceImagePaths");
  if (referenceImagePaths.length > 20) {
    throw new Error("Cursor sent more than 20 generated-image references.");
  }
  return {
    toolCallId: requireNativeId(record.toolCallId, "toolCallId", 1_000),
    description: requireString(record.description, "description"),
    ...(typeof record.filePath === "string"
      ? { filePath: requireString(record.filePath, "filePath") }
      : {}),
    referenceImagePaths: referenceImagePaths.map((path, index) =>
      requireString(path, `referenceImagePaths[${index}]`)),
  };
}

export function cursorQuestions(
  requestId: string,
  params: CursorQuestionParams,
): AgentInputRequest {
  return {
    requestId,
    autoResolutionMs: null,
    questions: params.questions.map((question) => ({
      id: question.id,
      header: bounded(params.title ?? "Question"),
      question: bounded(question.prompt),
      isOther: true,
      isSecret: false,
      allowMultiple: question.allowMultiple === true,
      options: question.options.map((option) => ({
        id: bounded(option.id),
        label: bounded(option.label),
        description: "",
      })),
    })),
  };
}

export function cursorTodoSteps(
  todos: CursorTodo[],
  fallback?: string,
): AgentPlanStep[] {
  const steps = todos.flatMap((todo) => {
    const step = todo.content?.trim() || todo.title?.trim();
    if (!step) return [];
    return [{
      step: bounded(step),
      status: todo.status === "completed"
        ? "completed" as const
        : todo.status === "in_progress" || todo.status === "inProgress"
          ? "inProgress" as const
          : "pending" as const,
    }];
  });
  return steps.length > 0
    ? steps
    : fallback
      ? [{ step: bounded(fallback), status: "pending" }]
      : [];
}

function parseTodos(value: unknown): CursorTodo[] {
  return requireArray(value, "todos").slice(0, 100).map((raw) => {
    const todo = requireObject(raw, "todo");
    return {
      ...(typeof todo.id === "string" ? { id: bounded(todo.id) } : {}),
      ...(typeof todo.content === "string"
        ? { content: bounded(todo.content) }
        : {}),
      ...(typeof todo.title === "string"
        ? { title: bounded(todo.title) }
        : {}),
      ...(typeof todo.status === "string" ? { status: todo.status } : {}),
    };
  });
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}

function requireObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_EVENT_TEXT_CHARS
  ) {
    throw new Error(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function requireInteractionText(
  value: unknown,
  label: string,
  maxChars: number,
  allowLineBreaks = false,
): string {
  if (!isSafeInteractionDisplayText(value, { allowLineBreaks, maxChars })) {
    throw new Error(`${label} must be safe bounded display text.`);
  }
  return value;
}

function requireNativeId(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  const id = requireString(value, label);
  if (id.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters.`);
  }
  return id;
}
