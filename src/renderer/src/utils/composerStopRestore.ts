export const COMPOSER_STOP_RESTORE_EVENT = "inertia:composer-stop-restore";

export interface ComposerStopRestoreDetail {
  phase: "start" | "failed";
  requestId: string;
  conversationId: string;
  turnId: string;
  messageId: string;
  text: string;
}

export function notifyComposerStopRestore(
  detail: ComposerStopRestoreDetail,
): void {
  window.dispatchEvent(new CustomEvent<ComposerStopRestoreDetail>(
    COMPOSER_STOP_RESTORE_EVENT,
    { detail },
  ));
}
