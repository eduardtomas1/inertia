import { z } from "zod";

export const AGENT_TURN_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
  "waiting-for-input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AgentTurnStatus = (typeof AGENT_TURN_STATUSES)[number];
export type AgentTurnTerminalStatus = Extract<
  AgentTurnStatus,
  "completed" | "failed" | "cancelled" | "interrupted"
>;
export type AgentTurnAssociation = "authoritative" | "inferred";

export const agentTurnStatusSchema = z.enum(AGENT_TURN_STATUSES);
export const agentTurnAssociationSchema = z.enum(["authoritative", "inferred"]);

const AGENT_TURN_TERMINAL_STATUSES: ReadonlySet<AgentTurnStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const AGENT_TURN_STATUS_TRANSITIONS: Readonly<
  Record<AgentTurnStatus, ReadonlySet<AgentTurnStatus>>
> = {
  queued: new Set(["starting", "running", "completed", "failed", "cancelled", "interrupted"]),
  starting: new Set(["running", "waiting-for-approval", "waiting-for-input", "completed", "failed", "cancelled", "interrupted"]),
  running: new Set(["waiting-for-approval", "waiting-for-input", "completed", "failed", "cancelled", "interrupted"]),
  "waiting-for-approval": new Set(["running", "waiting-for-input", "completed", "failed", "cancelled", "interrupted"]),
  "waiting-for-input": new Set(["running", "waiting-for-approval", "completed", "failed", "cancelled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

export function isAgentTurnTerminalStatus(
  status: AgentTurnStatus,
): status is AgentTurnTerminalStatus {
  return AGENT_TURN_TERMINAL_STATUSES.has(status);
}

/**
 * Lifecycle writes may be replayed with the same state, but terminal states
 * cannot be replaced by a different outcome.
 */
export function canTransitionAgentTurnStatus(
  from: AgentTurnStatus,
  to: AgentTurnStatus,
): boolean {
  return from === to || AGENT_TURN_STATUS_TRANSITIONS[from].has(to);
}
