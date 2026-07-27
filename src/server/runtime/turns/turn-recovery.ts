import type { AgentTurn } from "../../../shared/contracts";
import { RuntimeStore } from "../../database";

export interface TurnRecoveryResult {
  recoveredTurns: AgentTurn[];
  recoveredAttachmentIds: string[];
}

/**
 * Runs before providers or clients are admitted. RuntimeStore keeps the SQL
 * transaction for migration compatibility; this boundary makes restart
 * interruption an explicit part of authoritative turn-runtime bootstrap.
 */
export function recoverInterruptedTurns(store: RuntimeStore): TurnRecoveryResult {
  const before = store.unfinishedAgentTurns();
  store.recoverInterruptedRuns();
  const recoveredTurns = before
    .map(({ id }) => store.agentTurn(id))
    .filter(({ status, terminalReason }) =>
      status === "interrupted" && terminalReason === "runtime-restart");
  const recoveredAttachmentIds = new Set<string>();
  for (const turn of recoveredTurns) {
    const message = store.conversationDetail(turn.conversationId)?.messages
      .find(({ id }) => id === turn.userMessageId);
    for (const attachment of message?.attachments ?? []) {
      recoveredAttachmentIds.add(attachment.id);
    }
  }
  return {
    recoveredTurns,
    recoveredAttachmentIds: [...recoveredAttachmentIds],
  };
}
