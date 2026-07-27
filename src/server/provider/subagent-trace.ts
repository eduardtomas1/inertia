import type { SubagentTraceStatus } from "../../shared/contracts";

export const MAX_SUBAGENT_DESCRIPTION_CHARS = 4_000;
export const MAX_SUBAGENT_PROGRESS_CHARS = 4_000;
export const MAX_SUBAGENT_RESULT_CHARS = 16_000;
export const MAX_SUBAGENT_TRACES_PER_TURN = 128;

const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentTraceStatus>([
  "completed",
  "failed",
  "cancelled",
  "lost",
]);

// Trace copy can originate in tool output. Keep a deliberately small,
// deterministic scrubber at this persistence boundary without retaining the
// raw payload. This is defense in depth; provider adapters should emit concise
// summaries, not command/environment dumps.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/giu,
  /\b(?:sk|rk|pk|api|key|token)[-_][A-Za-z0-9_-]{12,}\b/giu,
  /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN)\s*[:=]\s*[^\s,;]+/giu,
];

export function isTerminalSubagentStatus(status: SubagentTraceStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(status);
}

export function boundedSubagentText(
  value: unknown,
  maxChars: number,
): string | null {
  if (typeof value !== "string") return null;
  let text = value.replace(/\0/gu, "").trim();
  if (!text) return null;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }
  return text.slice(0, maxChars);
}

export function boundedSubagentIdentifier(
  value: unknown,
  maxChars = 1_000,
): string | null {
  if (typeof value !== "string") return null;
  const identifier = value.replace(/\0/gu, "").trim();
  return identifier ? identifier.slice(0, maxChars) : null;
}
