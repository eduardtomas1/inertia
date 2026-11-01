import type { CheckpointSummary } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type { TerminalManager } from "../terminal";
import type { TurnController } from "./turns/turn-controller";

export const CHECKOUT_RESTORE_BUSY = "Another chat, terminal or task is working in this checkout or a folder that overlaps it. Stop it, then restore again.";
export const CHECKOUT_RESTORE_TERMINAL_REFUSAL = "Files are being restored in this chat's checkout. Open the terminal again when the restore finishes.";
export const ROLLED_BACK_CHECKPOINT = "This checkpoint belongs to a rolled-back turn. Restore files with the rollback instead, or choose a checkpoint from a retained turn.";

export interface CheckoutRestoreActivity {
  turns: Pick<TurnController, "checkoutActivityConversationIds">;
  terminals?: Pick<TerminalManager, "liveSessionScopes">;
}

export function claimCheckoutForRestore(
  store: Pick<RuntimeStore, "conversationWork" | "conversationPath">,
  conversationId: string,
  activity: CheckoutRestoreActivity,
): (() => void) | null {
  const work = store.conversationWork;
  if (!work.conversationMatchesCheckout(conversationId, store.conversationPath(conversationId))) return null;
  if (!work.claimRestoreCheckout(conversationId)) return null;
  const release = () => work.releaseRestoreCheckout(conversationId);
  let isolated = false;
  try {
    isolated = !activity.turns.checkoutActivityConversationIds().some((otherId) =>
      otherId !== conversationId && work.conversationOverlapsReservation(otherId, conversationId))
      && !(activity.terminals?.liveSessionScopes() ?? []).some((session) =>
        session.conversationId !== null && session.conversationId !== conversationId
        && work.overlapsReservation(conversationId, session.cwd));
  } finally {
    if (!isolated) release();
  }
  return isolated ? release : null;
}

export function isRolledBackTurnCheckpoint(
  store: Pick<RuntimeStore, "orchestration" | "agentTurn">,
  checkpoint: Pick<CheckpointSummary, "id" | "turnId">,
): boolean {
  if (!checkpoint.turnId) return false;
  return store.orchestration.history.rolledBack(checkpoint.turnId)
    && store.agentTurn(checkpoint.turnId).checkpointId === checkpoint.id;
}
