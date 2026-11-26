import type {
  SDKMessage,
  SDKStartupFailureReason,
  TerminalReason,
} from "@anthropic-ai/claude-agent-sdk";

import { clipCodeUnits } from "../../shared/code-units";
import { watcherCommandEnvironment } from "../runtime/watcher/read-only-commands";
import {
  MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  sanitizeProviderFailureDetail,
} from "./activity-detail";
import type { ProviderRunFailure, ProviderRunInput } from "./contracts";
import type { ClaudeDelegateCompletion } from "./claude-delegate-lifecycle";
import { CLAUDE_IDENTITY_ENVIRONMENT } from "./claude-identity";
import {
  CLAUDE_STARTUP_FAILURE_RESULTS,
  CLAUDE_TRANSCRIPT_FLUSH,
  claudeStartupFailure,
} from "./claude-startup-failure";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;

export function claudeLifecycleFailure(
  reason: Extract<ClaudeDelegateCompletion, { kind: "incomplete" }>["reason"],
): string {
  switch (reason) {
    case "prompt-refused":
      return "Claude refused the request before returning an answer.";
    case "prompt-cancelled":
      return "Claude cancelled the request before returning an answer.";
    case "prompt-discarded":
      return "Claude discarded the request before returning an answer.";
    case "delegates-abandoned":
      return "Claude Agent SDK exited while delegated work was still running.";
    case "parent-not-resumed":
      return "Claude Agent SDK exited before the parent resumed after delegated work.";
    case "missing-result":
      return "Claude Agent SDK exited without a final result.";
    case "prompt-unanswered":
      return "Claude finished the request without returning an answer.";
  }
}

export function claudeResultReason(
  result: Extract<SDKMessage, { type: "result" }>,
): Parameters<typeof claudeResultFailure>[0] {
  return result.subtype === "success"
    ? result.terminal_reason ?? "api_error"
    : claudeStartupFailure(result)?.reason ?? result.subtype;
}

export function claudeResultDetail(
  result: Extract<SDKMessage, { type: "result" }>,
  credentials: readonly string[],
  workspaceRoot: string,
): string | null {
  return sanitizeProviderFailureDetail(
    (result.subtype === "success" ? [result.result] : result.errors)
      .filter((value): value is string => typeof value === "string")
      .join("\n"),
    credentials,
    { workspaceRoot, maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS },
  );
}

export function claudeResultFailure(
  reason:
    | Exclude<Extract<SDKMessage, { type: "result" }>["subtype"], "success">
    | TerminalReason
    | SDKStartupFailureReason,
): string {
  switch (reason) {
    case "prompt_too_long":
      return "This chat is too long for Claude's context. Compact it or start a new chat.";
    case "error_max_turns":
      return "Claude reached the maximum number of agent turns.";
    case "error_max_budget_usd":
      return "Claude reached the configured spending limit.";
    case "error_max_structured_output_retries":
      return "Claude could not produce a valid structured response.";
    default:
      return "Claude could not complete the request.";
  }
}

export function claudeFailure(
  message: string,
  terminalEvent: string,
  technicalDetail?: string,
): ProviderRunFailure {
  return {
    reason: "provider-error",
    message,
    phase: "turn",
    terminalEvent,
    ...(technicalDetail ? { technicalDetail } : {}),
  };
}

export function claudeRuntimeFailure(
  rawError: string,
  message: string,
): ProviderRunFailure {
  const reason: ProviderRunFailure["reason"] = /oversized|(?:stream|text)-correlation|trace state|bounded(?: [\w-]+)* event (?:rate|budget)/iu.test(rawError)
    ? "protocol-overflow"
    : /unserializable|malformed|non-canonical/iu.test(rawError)
      ? "malformed-protocol"
      : "provider-error";
  return {
    reason,
    message,
    phase: "runtime",
    terminalEvent: "sdk/exception",
  };
}

export function boundedClaudeText(value: string): string {
  return clipCodeUnits(value, MAX_EVENT_TEXT_CHARS);
}

export function claudeReadableRuntimeError(rawError: string): string {
  // Keeps the "oversized" wording that classifies protocol overflow.
  return rawError === "Claude sent an oversized event."
    ? "Claude sent an oversized event that stayed above Inertia's 1 MB per-update limit even after its longest fields were shortened."
    : rawError;
}

/**
 * Deliberate subagent fan-out ceilings (#339). They match the SDK defaults
 * but are pinned so an SDK default change cannot silently widen them. An
 * explicit value in the provider environment still wins.
 */
const CLAUDE_SUBAGENT_LIMITS = {
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "3",
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "20",
} as const;

/** Oldest Claude Code version verified to accept `--thinking-display`. */
const CLAUDE_THINKING_DISPLAY_MIN_VERSION = [2, 1, 269] as const;

export function claudeSupportsThinkingDisplay(
  version: string | null | undefined,
): boolean {
  const match = version?.match(/(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const minimum = CLAUDE_THINKING_DISPLAY_MIN_VERSION[index]!;
    if (parts[index] !== minimum) return parts[index]! > minimum;
  }
  return true;
}

export function claudeRunEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  readOnlyProfile?: ProviderRunInput["readOnlyProfile"],
): NodeJS.ProcessEnv {
  const run = {
    ...CLAUDE_SUBAGENT_LIMITS,
    ...CLAUDE_STARTUP_FAILURE_RESULTS,
    ...CLAUDE_TRANSCRIPT_FLUSH,
    ...(environment ?? process.env),
    ...CLAUDE_IDENTITY_ENVIRONMENT,
  };
  return readOnlyProfile === "watcher" ? watcherCommandEnvironment(run) : run;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? boundedClaudeText(error.message) : fallback;
}

export function claudeEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : undefined;
}
