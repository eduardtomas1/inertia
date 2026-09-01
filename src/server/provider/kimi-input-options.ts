import type {
  PermissionOption,
  RequestPermissionRequest,
  ToolKind,
} from "@agentclientprotocol/sdk";

import {
  interactionDisplayIdentity,
  isSafeInteractionDisplayText,
} from "./approval-display";

const MAX_INPUT_OPTIONS = 20;
const MAX_INPUT_QUESTION_CHARS = 16_384;
const MAX_INPUT_OPTION_LABEL_CHARS = 512;
const MAX_INPUT_OPERATION_CHARS = 4_096;
const MAX_INPUT_PERMISSION_PROMPT_CHARS = 21_000;

interface KimiInputOption {
  id: string;
  label: string;
}

export interface KimiInputOptions {
  kind: "question" | "plan";
  prompt: string;
  options: KimiInputOption[];
}

export function kimiInputOptions(
  params: Pick<RequestPermissionRequest, "options" | "toolCall">,
): KimiInputOptions | null {
  if (
    !Array.isArray(params.options)
    || params.options.length === 0
    || params.options.length > MAX_INPUT_OPTIONS
    || !isTrustedKimiInputToolKind(params.toolCall.kind)
  ) return null;

  const title = params.toolCall.title;
  const kind = title === "AskUserQuestion"
    ? "question" as const
    : title === "ExitPlanMode"
      ? "plan" as const
      : null;
  if (!kind) return null;
  const prompt = kimiPermissionInputText(params, kind);
  if (prompt === null) return null;

  const options = parseKimiInputOptions(params.options);
  if (!options) return null;
  const input = kind === "question"
    ? kimiQuestionInputOptions(options)
    : kimiPlanInputOptions(options);
  return input ? { ...input, prompt } : null;
}

interface ParsedKimiInputOption extends KimiInputOption {
  kind: PermissionOption["kind"];
}

function parseKimiInputOptions(
  options: PermissionOption[],
): ParsedKimiInputOption[] | null {
  const optionIds = new Set<string>();
  const optionLabels = new Set<string>();
  const parsed: ParsedKimiInputOption[] = [];
  for (const option of options) {
    if (
      typeof option?.optionId !== "string"
      || option.optionId.length === 0
      || option.optionId.length > 160
      || optionIds.has(option.optionId)
      || !isSafeInteractionDisplayText(option.name, {
        maxChars: MAX_INPUT_OPTION_LABEL_CHARS,
      })
      || !isKimiPermissionOptionKind(option.kind)
    ) return null;
    const labelIdentity = interactionDisplayIdentity(option.name);
    if (optionLabels.has(labelIdentity)) return null;
    optionIds.add(option.optionId);
    optionLabels.add(labelIdentity);
    parsed.push({
      id: option.optionId,
      label: option.name,
      kind: option.kind,
    });
  }
  return parsed;
}

function kimiQuestionInputOptions(
  options: ParsedKimiInputOption[],
): Omit<KimiInputOptions, "prompt"> | null {
  let questionIndex: string | undefined;
  let skipSeen = false;
  const optionIndexes = new Set<number>();
  const inputOptions: KimiInputOption[] = [];
  for (const option of options) {
    const match = /^q(\d+)_(opt_(\d+)|skip)$/u.exec(option.id);
    if (!match || (questionIndex !== undefined && match[1] !== questionIndex)) {
      return null;
    }
    questionIndex = match[1];
    if (match[2] === "skip") {
      if (skipSeen || option.kind !== "reject_once") return null;
      skipSeen = true;
      continue;
    }
    const optionIndex = Number(match[3]);
    if (
      option.kind !== "allow_once"
      || !Number.isSafeInteger(optionIndex)
      || optionIndexes.has(optionIndex)
    ) return null;
    optionIndexes.add(optionIndex);
    inputOptions.push({ id: option.id, label: option.label });
  }
  if (inputOptions.length === 0) return null;
  const orderedIndexes = [...optionIndexes].sort((left, right) => left - right);
  if (orderedIndexes.some((value, index) => value !== index)) return null;
  return { kind: "question", options: inputOptions };
}

function kimiPlanInputOptions(
  options: ParsedKimiInputOption[],
): Omit<KimiInputOptions, "prompt"> | null {
  let approveSeen = false;
  let reviseSeen = false;
  let rejectAndExitSeen = false;
  const optionIndexes = new Set<number>();
  for (const option of options) {
    const match = /^plan_opt_(\d+)$/u.exec(option.id);
    if (match) {
      const optionIndex = Number(match[1]);
      if (
        option.kind !== "allow_once"
        || !Number.isSafeInteger(optionIndex)
        || optionIndexes.has(optionIndex)
      ) return null;
      optionIndexes.add(optionIndex);
      continue;
    }
    if (option.id === "plan_approve") {
      if (approveSeen || option.kind !== "allow_once") return null;
      approveSeen = true;
      continue;
    }
    if (option.id === "plan_revise") {
      if (reviseSeen || option.kind !== "reject_once") return null;
      reviseSeen = true;
      continue;
    }
    if (option.id === "plan_reject_and_exit") {
      if (rejectAndExitSeen || option.kind !== "reject_once") return null;
      rejectAndExitSeen = true;
      continue;
    }
    return null;
  }
  if (
    reviseSeen === false
    || rejectAndExitSeen === false
    || approveSeen === (optionIndexes.size > 0)
    || optionIndexes.size === 1
  ) return null;
  const orderedIndexes = [...optionIndexes].sort((left, right) => left - right);
  if (orderedIndexes.some((value, index) => value !== index)) return null;
  return {
    kind: "plan",
    options: options.map(({ id, label }) => ({ id, label })),
  };
}

function isTrustedKimiInputToolKind(
  kind: ToolKind | null | undefined,
): boolean {
  return kind === undefined || kind === null || kind === "other";
}

function isKimiPermissionOptionKind(
  kind: unknown,
): kind is PermissionOption["kind"] {
  return kind === "allow_once"
    || kind === "allow_always"
    || kind === "reject_once"
    || kind === "reject_always";
}

function kimiPermissionQuestionText(
  params: Pick<RequestPermissionRequest, "toolCall">,
  kind: KimiInputOptions["kind"],
): string | null {
  let text: string | undefined;
  for (const content of params.toolCall.content ?? []) {
    const value = objectValue(content);
    if (value?.type === "content" && typeof value.content === "object") {
      const nested = objectValue(value.content);
      if (nested?.type === "text" && typeof nested.text === "string") {
        text = nested.text;
        break;
      }
    }
    if (value?.type === "text" && typeof value.text === "string") {
      text = value.text;
      break;
    }
  }
  text ??= kind === "plan"
    ? "How should Kimi Code proceed with this plan?"
    : "Kimi Code needs your input.";
  return isSafeInteractionDisplayText(text, {
    allowLineBreaks: true,
    maxChars: MAX_INPUT_QUESTION_CHARS,
  }) ? text : null;
}

function kimiPermissionInputText(
  params: Pick<RequestPermissionRequest, "toolCall">,
  kind: KimiInputOptions["kind"],
): string | null {
  const question = kimiPermissionQuestionText(params, kind);
  if (!question) return null;
  let operation: string | undefined;
  try {
    operation = params.toolCall.rawInput === undefined
      ? "No additional operation details were provided."
      : JSON.stringify(params.toolCall.rawInput);
  } catch {
    return null;
  }
  if (!isSafeInteractionDisplayText(operation, {
    allowLineBreaks: true,
    maxChars: MAX_INPUT_OPERATION_CHARS,
  })) return null;
  const prompt = `Kimi Code is requesting permission through ${params.toolCall.title}. Selecting an option authorizes this request.\n\n${question}\n\nOperation details:\n${operation}`;
  return isSafeInteractionDisplayText(prompt, {
    allowLineBreaks: true,
    maxChars: MAX_INPUT_PERMISSION_PROMPT_CHARS,
  }) ? prompt : null;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
