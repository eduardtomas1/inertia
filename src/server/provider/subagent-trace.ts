import type { SubagentTaskStep, SubagentTraceStatus } from "../../shared/contracts";
import {
  MAX_SUBAGENT_LABEL_CHARS,
  MAX_SUBAGENT_STEP_LABEL_CHARS,
  MAX_SUBAGENT_STEPS,
  MAX_SUBAGENT_STEPS_JSON_CHARS,
} from "../../shared/subagent-task-limits";

export {
  MAX_SUBAGENT_ACTIVITY_ID_CHARS,
  MAX_SUBAGENT_COMMAND_CHARS,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  MAX_SUBAGENT_LABEL_CHARS,
  MAX_SUBAGENT_PROGRESS_CHARS,
  MAX_SUBAGENT_RESULT_CHARS,
  MAX_SUBAGENT_STEP_LABEL_CHARS,
  MAX_SUBAGENT_STEPS,
  MAX_SUBAGENT_STEPS_JSON_CHARS,
} from "../../shared/subagent-task-limits";

export const MAX_SUBAGENT_TRACES_PER_TURN = 128;
/**
 * Background commands, monitors and MCP tasks share the per-turn trace cap
 * with delegated agents but may never take more than half of it.
 */
export const MAX_SUBAGENT_NON_AGENT_TRACES_PER_TURN = 64;
export const MAX_SUBAGENT_TOOL_USE_COUNT = 1_000_000;
export const MAX_SUBAGENT_DURATION_MS = 31 * 24 * 60 * 60 * 1_000;

const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentTraceStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "lost",
]);

// Trace copy can originate in tool output. Keep a deliberately small,
// deterministic scrubber at this persistence boundary without retaining the
// raw payload. This is defense in depth; provider adapters should emit concise
// summaries, not command/environment dumps.
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[^-]|-(?!----)){0,65536}(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----)?/gu, "[redacted]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/giu, "[redacted]"],
  [/\b(?:sk|rk|pk|api|key|token)[-_][A-Za-z0-9_-]{12,}\b/giu, "[redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/gu, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, "[redacted]"],
  [/\bxox[abeoprs]-[A-Za-z0-9-]{10,255}/gu, "[redacted]"],
  [/\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|aws_secret_access_key|aws_session_token)\s*[:=]\s*[^\s,;]+/giu, "[redacted]"],
  [/("(?:[A-Za-z0-9_-]{0,40}[_-])?(?:api[_-]?key|token|secret|password|passwd)"\s{0,8}:\s{0,8})"[^"\n]{0,4096}"/giu, "$1\"[redacted]\""],
  [/(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@/]{1,256}:)[^\s@/]{1,256}@/giu, "$1[redacted]@"],
];

export function isTerminalSubagentStatus(status: SubagentTraceStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(status);
}

export function scrubSubagentSecrets(value: string): string {
  let text = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function boundedSubagentText(
  value: unknown,
  maxChars: number,
): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\0/gu, "").trim();
  if (!text) return null;
  return scrubSubagentSecrets(text).slice(0, maxChars);
}

export function boundedSubagentIdentifier(
  value: unknown,
  maxChars = 1_000,
): string | null {
  if (typeof value !== "string") return null;
  const identifier = value.replace(/\0/gu, "").trim();
  return identifier ? identifier.slice(0, maxChars) : null;
}

export function boundedSubagentCount(
  value: unknown,
  maximum: number,
): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum
    ? value
    : null;
}

export function boundedSubagentLabel(
  value: string | null | undefined,
  maxChars = MAX_SUBAGENT_LABEL_CHARS,
): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (text.length <= maxChars) return text;
  const lastUnit = text.charCodeAt(maxChars - 1);
  const end = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? maxChars - 1 : maxChars;
  return text.slice(0, end).trim() || null;
}

const SUBAGENT_STEP_STATUSES = new Set<SubagentTaskStep["status"]>([
  "running",
  "completed",
  "failed",
]);

/**
 * Keeps at most the most recent allowed steps whose labels survive the given
 * scrubber, and drops the oldest until the serialized form fits its column.
 */
export function boundedSubagentSteps(
  value: unknown,
  label: (text: string) => string | null,
): SubagentTaskStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: SubagentTaskStep[] = [];
  for (const candidate of value.slice(-MAX_SUBAGENT_STEPS)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const { label: rawLabel, status } = candidate as Record<string, unknown>;
    if (typeof rawLabel !== "string" || !SUBAGENT_STEP_STATUSES.has(status as SubagentTaskStep["status"])) continue;
    const text = boundedSubagentLabel(label(rawLabel), MAX_SUBAGENT_STEP_LABEL_CHARS);
    if (text) steps.push({ label: text, status: status as SubagentTaskStep["status"] });
  }
  while (steps.length > 0 && JSON.stringify(steps).length > MAX_SUBAGENT_STEPS_JSON_CHARS) {
    steps.shift();
  }
  return steps.length > 0 ? steps : null;
}

export function subagentTaskStepsFromJson(value: string | null): SubagentTaskStep[] | null {
  if (value === null) return null;
  try {
    return boundedSubagentSteps(JSON.parse(value), (text) => text);
  } catch {
    return null;
  }
}
