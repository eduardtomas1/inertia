import type { AgentTurn } from "../../../shared/contracts";
import { RuntimeStore } from "../../database";
import { RecordNotFoundError } from "../../persistence/errors";

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
    const message = userMessage(store, turn);
    for (const attachment of message?.attachments ?? []) {
      recoveredAttachmentIds.add(attachment.id);
    }
  }
  return {
    recoveredTurns,
    recoveredAttachmentIds: [...recoveredAttachmentIds],
  };
}

function userMessage(store: RuntimeStore, turn: AgentTurn) {
  try {
    const message = store.message(turn.userMessageId);
    return message.conversationId === turn.conversationId ? message : null;
  } catch (error) {
    if (error instanceof RecordNotFoundError) return null;
    throw error;
  }
}
