import type { AgentTurn } from "../../../shared/contracts";
import { RuntimeStore } from "../../database";

export interface TurnRecoveryResult {
  recoveredTurns: AgentTurn[];
}

/**
 * Runs before providers or clients are admitted. RuntimeStore keeps the SQL
 * transaction for migration compatibility; this boundary makes restart
 * interruption an explicit part of authoritative turn-runtime bootstrap.
 */
export function recoverInterruptedTurns(store: RuntimeStore): TurnRecoveryResult {
  const before = store.unfinishedAgentTurns();
  store.recoverInterruptedRuns();
  return {
    recoveredTurns: before
      .map(({ id }) => store.agentTurn(id))
      .filter(({ status, terminalReason }) =>
        status === "interrupted" && terminalReason === "runtime-restart"),
  };
}
