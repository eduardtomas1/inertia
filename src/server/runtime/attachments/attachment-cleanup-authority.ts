import type { AuthorizeAttachmentCleanup } from "../../../node/conversation-attachment-storage-management";
import type { RuntimeStore } from "../../database";
import type { TurnController } from "../turns/turn-controller";

const CLEANUP_ADMISSION_TIMEOUT_MS = 1_000;

export function attachmentCleanupAuthority(
  store: Pick<RuntimeStore, "attachmentConversationIds" | "evictableAttachmentIds">,
  turns: Pick<TurnController, "acquireTurnAdmission">,
): AuthorizeAttachmentCleanup {
  return async (ids) => {
    const acquired = await Promise.allSettled(store.attachmentConversationIds(ids).map((conversationId) =>
      turns.acquireTurnAdmission(conversationId, CLEANUP_ADMISSION_TIMEOUT_MS)));
    const leases = acquired.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
    const leased = new Set(leases.map(({ conversationId }) => conversationId));
    return {
      order: () => store.evictableAttachmentIds(leased),
      release: () => { for (const lease of leases) lease.release(); },
    };
  };
}
