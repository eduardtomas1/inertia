export type ComposerPrimaryActionState =
  | "send-disabled"
  | "send-ready"
  | "submitting"
  | "stop-ready"
  | "stop-pending";

export type ComposerFollowUpState =
  | "hidden"
  | "unavailable"
  | "ready"
  | "pending";

export function supportsActiveParentFollowUp(harnessId: string | null): boolean {
  return harnessId === "codex-app-server"
    || harnessId === "claude-agent-sdk";
}

export function composerFollowUpState({
  running,
  harnessId,
  hasDraft,
  textOnly,
  submitting,
  sending,
}: {
  running: boolean;
  harnessId: string | null;
  hasDraft: boolean;
  textOnly: boolean;
  submitting: boolean;
  sending: boolean;
}): ComposerFollowUpState {
  if (!running || !hasDraft) return "hidden";
  if (!supportsActiveParentFollowUp(harnessId) || !textOnly) {
    return "unavailable";
  }
  return submitting || sending ? "pending" : "ready";
}

// The provider-backed runtime normally projects `running` immediately after it
// accepts a turn. Keep the local latch long enough to bridge a loaded renderer
// while still recovering in test/offline routes that accept without a turn.
export const COMPOSER_ACTION_STALE_FALLBACK_MS = 3_000;

export function composerPrimaryActionState({
  sendEligible,
  submitting,
  sending,
  running,
  stopping,
}: {
  sendEligible: boolean;
  submitting: boolean;
  sending: boolean;
  running: boolean;
  stopping: boolean;
}): ComposerPrimaryActionState {
  if (running) return stopping ? "stop-pending" : "stop-ready";
  if (submitting || sending) return "submitting";
  return sendEligible ? "send-ready" : "send-disabled";
}
