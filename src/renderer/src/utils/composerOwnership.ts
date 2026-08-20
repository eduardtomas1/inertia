export type ComposerDetachmentBlocker =
  | "mutation-in-flight"
  | "pending-model-route"
  | "attachments"
  | "file-references"
  | "prompt-context"
  | "preview-context";

export type ComposerDetachmentPreparation =
  | { readonly status: "ready" }
  | {
      readonly status: "blocked";
      readonly blocker: ComposerDetachmentBlocker;
      readonly reason: string;
    };

export type ComposerDetachmentPrepare = () => ComposerDetachmentPreparation;

interface ComposerOwner {
  prepare: ComposerDetachmentPrepare;
}

// Renderer modules are isolated per BrowserWindow. This registry therefore
// tracks the composer mounted in this window without creating cross-window
// ownership or lifecycle coupling.
const composerOwners = new Map<string, ComposerOwner>();

export function registerComposerOwnership(
  conversationId: string,
  prepare: ComposerDetachmentPrepare,
): () => void {
  const owner = { prepare };
  composerOwners.set(conversationId, owner);

  return () => {
    // React Strict Mode can register a replacement before an older effect's
    // cleanup runs. A stale cleanup must never unregister the newer owner.
    if (composerOwners.get(conversationId) === owner) {
      composerOwners.delete(conversationId);
    }
  };
}

export function prepareComposerDetachment(
  conversationId: string,
): ComposerDetachmentPreparation {
  return composerOwners.get(conversationId)?.prepare() ?? { status: "ready" };
}
