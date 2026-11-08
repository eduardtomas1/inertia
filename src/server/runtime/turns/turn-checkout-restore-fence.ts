import type { RuntimeStore } from "../../database";
import { MESSAGE_ADMISSION_UNAVAILABLE, RuntimeRequestError } from "../../runtime-errors";
import { CHECKOUT_RESTORE_IN_PROGRESS } from "../conversation-work-authority";

export function assertNoCheckoutRestore(store: Pick<RuntimeStore, "conversationWork">, conversationId: string): void {
  if (store.conversationWork.restoreBlocksConversation(conversationId)) {
    throw new RuntimeRequestError(CHECKOUT_RESTORE_IN_PROGRESS, MESSAGE_ADMISSION_UNAVAILABLE);
  }
}
