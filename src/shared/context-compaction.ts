import type { ProviderId } from "./provider";
const PROVIDER_IDS: readonly ProviderId[] = ["codex", "claude", "cursor", "kimi", "opencode", "antigravity"];
export const CONTEXT_COMPACTION_TRIGGERS = ["manual", "on-return"] as const;
export type ContextCompactionTrigger = (typeof CONTEXT_COMPACTION_TRIGGERS)[number];

/** Provider-confirmed context mutation; it is not an agent turn. */
export interface ContextCompaction {
  providerId: ProviderId;
  beforeTokens: number | null;
  afterTokens: number | null;
  instructionForwarded: boolean;
  trigger?: ContextCompactionTrigger;
}

export function isContextCompaction(value: unknown): value is ContextCompaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const count = (input: unknown): boolean => input === null
    || (typeof input === "number" && Number.isSafeInteger(input) && input >= 0);
  const triggered = "trigger" in row;
  return Object.keys(row).length === (triggered ? 5 : 4)
    && (!triggered || CONTEXT_COMPACTION_TRIGGERS.includes(row.trigger as ContextCompactionTrigger))
    && PROVIDER_IDS.includes(row.providerId as ProviderId)
    && count(row.beforeTokens) && count(row.afterTokens)
    && typeof row.instructionForwarded === "boolean";
}

export function contextCompactionLabel(
  value: Pick<ContextCompaction, "beforeTokens" | "afterTokens">,
): string {
  if (value.beforeTokens === null || value.afterTokens === null) return "Compacted context";
  const format = (count: number): string => new Intl.NumberFormat("en-US", {
    notation: "compact", maximumSignificantDigits: 3,
  }).format(count);
  return `Compacted context ${format(value.beforeTokens)} → ${format(value.afterTokens)} tokens`;
}
