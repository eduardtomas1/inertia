import type { AgentGoal } from "../../shared/contracts";
import { parseCodexGoalSnapshot } from "../codex/goals";
import { objectValue } from "../codex/protocol";

export function exactBoundedString(
  value: unknown,
  maximum: number,
): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.includes("\0")
  ) return undefined;
  return value;
}

export function boundedDisplayString(
  value: unknown,
  maximum: number,
): string | undefined {
  const exact = exactBoundedString(value, maximum);
  const clean = exact?.trim();
  return clean || undefined;
}

export function parseCodexGoal(
  conversationId: string,
  expectedSessionId: string,
  value: unknown,
  synchronizedAt = new Date().toISOString(),
): AgentGoal | null {
  const goal = objectValue(value);
  const providerSessionId = exactBoundedString(goal?.threadId, 512);
  const snapshot = parseCodexGoalSnapshot(goal);
  if (providerSessionId !== expectedSessionId || !snapshot) return null;
  return {
    conversationId,
    source: "codex-native",
    providerSessionId,
    ...snapshot,
    synchronizedAt,
  };
}
