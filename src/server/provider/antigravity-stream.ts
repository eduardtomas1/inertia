import { isProviderTerminalSessionId } from "../../shared/provider-terminal-resume";
import {
  sanitizeProviderActivityDetail,
  sanitizeProviderFailureSummary,
} from "./activity-detail";
import type {
  ProviderActivityPhase,
  ProviderRunFailure,
  ProviderRunInput,
  ProviderUsageEvent,
} from "./contracts";

const MAX_TECHNICAL_DETAIL_CHARS = 16 * 1024;
const MAX_LABEL_CHARS = 200;
const EFFORTS = new Set(["low", "medium", "high"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/u;

export const ANTIGRAVITY_HEADLESS_ARGUMENTS = [
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
] as const;

export const ANTIGRAVITY_AUTH_REQUIRED_MESSAGE =
  "Antigravity needs you to sign in. Use Connect to open Antigravity in a terminal, sign in there, then send your message again.";

export interface AntigravityResult {
  status: string;
  conversationId: string | null;
  response: string;
  error: string | null;
  usage: ProviderUsageEvent["usage"] | null;
}

export type AntigravityStreamEvent =
  | { kind: "session"; conversationId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; label: string; phase: ProviderActivityPhase }
  | { kind: "result"; result: AntigravityResult };

export type AntigravityFailureKind =
  | "auth"
  | "error"
  | "waiting"
  | "invalid"
  | "stopped"
  | "exit"
  | "signal"
  | "malformed"
  | "unsupported";

type JsonObject = Record<string, unknown>;

const FAILURE_MESSAGES: Readonly<Record<Exclude<AntigravityFailureKind, "error" | "unsupported">, string>> = {
  auth: ANTIGRAVITY_AUTH_REQUIRED_MESSAGE,
  waiting: "Antigravity stopped to wait for input that Inertia can't answer in headless mode.",
  invalid: "Antigravity rejected the request.",
  stopped: "Antigravity stopped the turn before it finished.",
  exit: "Antigravity exited before the turn finished.",
  signal: "Antigravity was stopped before the turn finished.",
  malformed: "Antigravity sent output Inertia could not read.",
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function antigravitySessionId(
  value: string | null | undefined,
): string | undefined {
  return value && isProviderTerminalSessionId(value) ? value : undefined;
}

export function antigravityArguments(
  input: Pick<
    ProviderRunInput,
    "sessionId" | "modelSelection" | "reasoningEffort" | "interactionMode" | "access"
  >,
): string[] {
  const args: string[] = [...ANTIGRAVITY_HEADLESS_ARGUMENTS];
  const sessionId = antigravitySessionId(input.sessionId);
  if (sessionId) args.push("--conversation", sessionId);
  const model = input.modelSelection.modelId;
  if (model !== "provider-default" && MODEL_ID.test(model)) {
    args.push("--model", model);
  }
  const effort = input.modelSelection.reasoningEffort ?? input.reasoningEffort;
  if (effort && EFFORTS.has(effort)) args.push("--effort", effort);
  if (input.interactionMode === "plan") args.push("--mode", "plan");
  else if (input.access === "auto-edit") args.push("--mode", "accept-edits");
  else if (input.access === "full") args.push("--dangerously-skip-permissions");
  return args;
}

export function antigravityUserLine(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

export function antigravityUsage(
  value: unknown,
): ProviderUsageEvent["usage"] | null {
  if (!isObject(value)) return null;
  const totalProcessedTokens = tokenCount(value.total_tokens);
  const usage: ProviderUsageEvent["usage"] = {
    usedTokens: null,
    totalProcessedTokens,
    totalProcessedScope: totalProcessedTokens === null ? null : "session",
    maxTokens: null,
    inputTokens: tokenCount(value.input_tokens),
    cachedInputTokens: tokenCount(value.cache_read_tokens),
    cacheWriteInputTokens: null,
    outputTokens: tokenCount(value.output_tokens),
    reasoningOutputTokens: tokenCount(value.thinking_tokens),
    compactsAutomatically: null,
  };
  return Object.values(usage).some((entry) => typeof entry === "number" && entry > 0)
    ? usage
    : null;
}

export function parseAntigravityLine(
  line: string,
): AntigravityStreamEvent[] | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.event !== "string") return null;
  const nested = value[value.event];
  const payload = isObject(nested) ? nested : value;
  const conversationId = antigravitySessionId(nonEmptyText(payload.conversation_id));
  if (value.event === "result") {
    return [{
      kind: "result",
      result: {
        status: nonEmptyText(payload.status) ?? "",
        conversationId: conversationId ?? null,
        response: typeof payload.response === "string" ? payload.response : "",
        error: nonEmptyText(payload.error),
        usage: antigravityUsage(payload.usage),
      },
    }];
  }
  const events: AntigravityStreamEvent[] = conversationId
    ? [{ kind: "session", conversationId }]
    : [];
  if (value.event !== "step_update") return events;
  const toolName = nonEmptyText(payload.tool_name);
  if (toolName) {
    const stepIndex = tokenCount(payload.step_index);
    events.push({
      kind: "tool",
      id: stepIndex === null ? toolName : String(stepIndex),
      label: toolName.slice(0, MAX_LABEL_CHARS),
      phase: payload.state === "DONE" ? "completed" : "started",
    });
    return events;
  }
  const delta = nonEmptyText(payload.text_delta);
  if (delta) events.push({ kind: "text", text: delta });
  return events;
}

export function antigravityAuthRequired(detail: string): boolean {
  return /authentication (?:required|failed or timed out)|please visit the url to log in|please sign in/iu
    .test(detail);
}

export function antigravityDeclinedNotice(line: string): boolean {
  return /\b(?:soft[- ]denied|denied|declined|requires approval|needs approval)\b/iu.test(line);
}

export function antigravityFailure(
  kind: AntigravityFailureKind,
  detail: string,
  workspaceRoot: string,
  message?: string,
): ProviderRunFailure {
  const reason: ProviderRunFailure["reason"] = kind === "malformed"
    ? "malformed-protocol"
    : kind === "exit"
      ? "process-exit"
      : kind === "signal"
        ? "process-signal"
        : "provider-error";
  const summary = message ?? (
    kind === "error" || kind === "unsupported"
      ? sanitizeProviderFailureSummary(detail, "Antigravity reported an error.", { workspaceRoot })
      : FAILURE_MESSAGES[kind]
  );
  const technicalDetail = sanitizeProviderActivityDetail(detail, {
    workspaceRoot,
    maxChars: MAX_TECHNICAL_DETAIL_CHARS,
  }) ?? undefined;
  return {
    reason,
    message: summary,
    phase: kind === "auth" ? "auth" : "turn",
    terminalEvent: `result:${kind}`,
    ...(technicalDetail && technicalDetail !== summary ? { technicalDetail } : {}),
  };
}

export function antigravityResultFailure(
  result: AntigravityResult,
  workspaceRoot: string,
): ProviderRunFailure | null {
  const detail = result.error ?? "";
  switch (result.status) {
    case "SUCCESS":
      return null;
    case "ERROR":
      return antigravityFailure(
        antigravityAuthRequired(detail) ? "auth" : "error",
        detail,
        workspaceRoot,
      );
    case "WAITING":
      return antigravityFailure("waiting", detail, workspaceRoot);
    case "INVALID":
      return antigravityFailure("invalid", detail, workspaceRoot);
    default:
      return antigravityFailure("stopped", detail || result.status, workspaceRoot);
  }
}
