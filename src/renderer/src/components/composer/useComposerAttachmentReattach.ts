import { useEffect, useEffectEvent } from "react";

import type { ConversationAttachmentGalleryItem } from "@shared/conversation-attachment-gallery";
import type { ComposerAttachmentActions } from "./composerAttachmentActions";
import {
  openReattachLease,
  registerComposerReattachTarget,
  type ComposerReattachOutcome,
} from "./composerAttachmentReattach";

const REATTACH_UNSUPPORTED = "Re-attaching files is unavailable in this window.";

/** Lets the Attachments surface add a stored file to this chat's draft. */
export function useComposerAttachmentReattach(
  conversationId: string,
  reattach: ComposerAttachmentActions["reattachAttachment"],
): void {
  const handle = useEffectEvent(async (
    item: ConversationAttachmentGalleryItem,
  ): Promise<ComposerReattachOutcome> => {
    const bridge = typeof window === "undefined" ? undefined : window.inertia;
    if (!bridge?.reattachAttachment) return { status: "rejected", message: REATTACH_UNSUPPORTED };
    return await reattach(item, async () =>
      await openReattachLease(bridge, conversationId, item.id));
  });
  useEffect(
    () => registerComposerReattachTarget(conversationId, async (item) => await handle(item)),
    [conversationId],
  );
}
