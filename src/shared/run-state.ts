import type { AgentTurnStatus } from "./turn-lifecycle";

export const AGENT_RUN_STATES = [
  "queued",
  "starting",
  "running",
  "delegated",
  "retrying",
  "waiting-for-approval",
  "waiting-for-input",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AgentRunState = (typeof AGENT_RUN_STATES)[number];
export type AgentRunTerminalState = Extract<
  AgentRunState,
  "completed" | "failed" | "cancelled" | "interrupted"
>;

/**
 * Exact live execution state for one conversation/run/turn owner. `providerState`
 * keeps the bounded provider-native phase when a transport exposes one; the
 * canonical state is only the runtime policy projection used across providers.
 */
export interface AgentRunStateSnapshot {
  state: AgentRunState;
  providerState: string | null;
  revision: number;
}

export function isAgentRunTerminalState(
  state: AgentRunState,
): state is AgentRunTerminalState {
  return state.endsWith("ed") && state[0] !== "q" && state[0] !== "d";
}

export function agentRunStateForTurn(input: {
  status: AgentTurnStatus;
  runState?: AgentRunStateSnapshot;
}): AgentRunState {
  return input.runState?.state ?? input.status;
}

/** Compatibility projection for released turn-ledger consumers. */
export function agentTurnStatusForRunState(
  state: AgentRunState,
): AgentTurnStatus {
  if (state === "delegated" || state === "retrying" || state === "cancelling") {
    return "running";
  }
  return state;
}
