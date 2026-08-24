import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

export const MAX_CLAUDE_PROJECTOR_EVENT_TEXT_CHARS = 1024 * 1024;
export const MAX_CLAUDE_TRACKED_MESSAGE_IDS = 4_096;
export const MAX_CLAUDE_TRACKED_TEXT_ALIASES =
  MAX_CLAUDE_TRACKED_MESSAGE_IDS * 4;
export const MAX_CLAUDE_STREAM_STATES = 256;
export const MAX_CLAUDE_STREAM_CORRELATION_BLOCKS = 1_024;
export const MAX_CLAUDE_STREAM_CORRELATION_CHARS = 4 * 1024 * 1024;
const MAX_CLAUDE_STREAM_BLOCK_INDEX = 10_000;

export interface ClaudeProjectedFailure {
  message: string;
  terminalEvent: string;
  activityId?: string;
}

export type ClaudeCommandLifecycleState =
  | "queued"
  | "started"
  | "completed"
  | "cancelled"
  | "refused"
  | "discarded";

export interface ClaudeCommandLifecycleMessage {
  type: "command_lifecycle";
  command_uuid: string;
  state: ClaudeCommandLifecycleState;
}

const CLAUDE_COMMAND_LIFECYCLE_PROJECTIONS = {
  queued: { phase: "started", label: "Claude queued the request" },
  started: { phase: "started", label: "Claude started the request" },
  completed: { phase: "completed", label: "Claude completed the request" },
  cancelled: { phase: "info", label: "Claude cancelled the request" },
  refused: { phase: "failed", label: "Claude refused the request" },
  discarded: { phase: "info", label: "Claude discarded the request" },
} as const satisfies Record<ClaudeCommandLifecycleState, {
  phase: "started" | "completed" | "failed" | "info";
  label: string;
}>;

export function claudeCommandLifecycleProjection(
  state: ClaudeCommandLifecycleState,
) {
  return CLAUDE_COMMAND_LIFECYCLE_PROJECTIONS[state];
}

function commandLifecycleState(
  value: unknown,
): value is ClaudeCommandLifecycleState {
  return value === "queued"
    || value === "started"
    || value === "completed"
    || value === "cancelled"
    || value === "refused"
    || value === "discarded";
}

export function claudeCommandLifecycleMessage(
  value: unknown,
): ClaudeCommandLifecycleMessage | null {
  const record = claudeObjectValue(value);
  if (
    record?.type !== "command_lifecycle"
    || typeof record.command_uuid !== "string"
    || !commandLifecycleState(record.state)
  ) return null;
  return {
    type: "command_lifecycle",
    command_uuid: record.command_uuid,
    state: record.state,
  };
}

export class BoundedStringSet {
  private readonly values = new Set<string>();

  constructor(private readonly maximum: number) {}

  add(value: string): void {
    if (this.values.delete(value)) this.values.add(value);
    else {
      this.values.add(value);
      if (this.values.size > this.maximum) {
        const oldest = this.values.values().next().value;
        if (typeof oldest === "string") this.values.delete(oldest);
      }
    }
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  delete(value: string): void {
    this.values.delete(value);
  }

  clear(): void {
    this.values.clear();
  }
}

export class BoundedStringMap<Value> {
  private readonly values = new Map<string, Value>();

  constructor(private readonly maximum: number) {}

  set(key: string, value: Value): void {
    if (this.values.delete(key)) this.values.set(key, value);
    else {
      this.values.set(key, value);
      if (this.values.size > this.maximum) {
        const oldest = this.values.keys().next().value;
        if (typeof oldest === "string") this.values.delete(oldest);
      }
    }
  }

  get(key: string): Value | undefined {
    return this.values.get(key);
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

/**
 * Ordered, capped provider text state used only when Claude corrects or
 * retracts already-emitted text. Per-result sealing bounds identity retention
 * while preserving the immutable prefix across accepted follow-ups.
 */
export class ClaudeProjectedTextLedger {
  private prefix = "";
  private readonly order: string[] = [];
  private readonly values = new Map<string, string>();
  private totalChars = 0;

  append(itemId: string, value: string): string {
    if (!value) return "";
    const current = this.values.get(itemId);
    if (current === undefined) {
      if (this.order.length >= MAX_CLAUDE_TRACKED_MESSAGE_IDS) {
        throw new Error(
          "Claude exceeded the bounded text-correlation state for this turn.",
        );
      }
      this.order.push(itemId);
      this.values.set(itemId, "");
    }
    const available = Math.max(
      0,
      MAX_CLAUDE_STREAM_CORRELATION_CHARS - this.totalChars,
    );
    const accepted = value.slice(0, available);
    if (!accepted) return "";
    this.values.set(itemId, `${this.values.get(itemId) ?? ""}${accepted}`);
    this.totalChars += accepted.length;
    return accepted;
  }

  replace(itemId: string, value: string): void {
    const current = this.values.get(itemId);
    if (current === undefined) {
      if (this.order.length >= MAX_CLAUDE_TRACKED_MESSAGE_IDS) {
        throw new Error(
          "Claude exceeded the bounded text-correlation state for this turn.",
        );
      }
      this.order.push(itemId);
    } else {
      this.totalChars -= current.length;
    }
    const available = Math.max(
      0,
      MAX_CLAUDE_STREAM_CORRELATION_CHARS - this.totalChars,
    );
    const accepted = value.slice(0, available);
    this.values.set(itemId, accepted);
    this.totalChars += accepted.length;
  }

  remove(itemId: string): boolean {
    const current = this.values.get(itemId);
    if (current === undefined) return false;
    this.values.delete(itemId);
    this.totalChars -= current.length;
    const index = this.order.indexOf(itemId);
    if (index >= 0) this.order.splice(index, 1);
    return true;
  }

  snapshot(): string {
    const values = [this.prefix];
    for (const itemId of this.order) {
      values.push(this.values.get(itemId) ?? "");
    }
    return values.join("").slice(0, MAX_CLAUDE_STREAM_CORRELATION_CHARS);
  }

  seal(): void {
    this.prefix = this.snapshot();
    this.order.splice(0);
    this.values.clear();
    this.totalChars = this.prefix.length;
  }

  reset(): void {
    this.prefix = "";
    this.order.splice(0);
    this.values.clear();
    this.totalChars = 0;
  }
}

export function claudeAssistantFailure(
  error: SDKAssistantMessageError,
  activityId: string | undefined,
): ClaudeProjectedFailure {
  const message = (() => {
    switch (error) {
      case "authentication_failed":
        return "Claude authentication failed.";
      case "oauth_org_not_allowed":
        return "This Claude organization does not allow OAuth access.";
      case "account_on_hold":
        return "Claude could not continue because the account is on hold.";
      case "billing_error":
        return "Claude could not continue because of an account billing issue.";
      case "rate_limit":
        return "Claude reached an account rate limit.";
      case "overloaded":
        return "Claude is temporarily overloaded.";
      case "invalid_request":
        return "Claude rejected the request as invalid.";
      case "model_not_found":
        return "The selected Claude model is unavailable.";
      case "server_error":
        return "Claude reported a server error.";
      case "max_output_tokens":
        return "Claude reached the response token limit.";
      case "unknown":
        return "Claude reported an unknown response error.";
      default: {
        const exhaustive: never = error;
        void exhaustive;
        return "Claude reported an unsupported response error.";
      }
    }
  })();
  return {
    message,
    terminalEvent: `assistant/${error}`,
    ...(activityId ? { activityId } : {}),
  };
}

export function boundedClaudeEventText(value: string): string {
  return value.slice(0, MAX_CLAUDE_PROJECTOR_EVENT_TEXT_CHARS);
}

export function boundedClaudeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\0/gu, "").trim();
  return normalized ? normalized.slice(0, 1_000) : undefined;
}

export function claudeTextItemId(kind: string, value: string): string {
  return boundedClaudeIdentifier(`claude:${kind}:${value}`)
    ?? `claude:${kind}`;
}

export function boundedClaudeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 240)
    : fallback;
}

export function claudeObjectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function safeClaudeStreamIndex(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_CLAUDE_STREAM_BLOCK_INDEX
    ? value
    : null;
}

export function isChildOwnedClaudeMessage(parentToolUseId: unknown): boolean {
  return parentToolUseId !== null && parentToolUseId !== undefined;
}

export function safeClaudePositiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

export function safeClaudeNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function claudeDetailLines(
  values: readonly (string | null | undefined)[],
): string | undefined {
  const detail = values
    .filter((value): value is string =>
      typeof value === "string" && value.length > 0)
    .join("\n")
    .slice(0, MAX_CLAUDE_PROJECTOR_EVENT_TEXT_CHARS);
  return detail || undefined;
}

export function claudePlanSteps(markdown: string): Array<{
  step: string;
  status: "pending";
}> {
  const parsed = markdown
    .split("\n")
    .map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)/u)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return (parsed.length > 0 ? parsed : [markdown])
    .slice(0, 100)
    .map((step) => ({
      step: boundedClaudeEventText(step),
      status: "pending",
    }));
}
