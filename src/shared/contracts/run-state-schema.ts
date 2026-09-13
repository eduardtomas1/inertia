import type { AgentTurnStatus } from "../turn-lifecycle";

export function authoritativeRunState(value: unknown, status: AgentTurnStatus): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value === undefined;
  }
  const { state, providerState, revision } = value as Record<string, unknown>;
  const compatibleState = state === status || (status === "running"
    && (state === "delegated" || state === "retrying" || state === "cancelling"));
  return compatibleState
    && (providerState === null || (typeof providerState === "string"
      && providerState.length > 0 && providerState.length <= 200))
    && typeof revision === "number"
    && Number.isSafeInteger(revision)
    && revision >= 0;
}
