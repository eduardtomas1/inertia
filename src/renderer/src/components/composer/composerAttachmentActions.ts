import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { ChatAttachment } from "@shared/contracts";
import {
  MAX_CHAT_ATTACHMENTS,
  chatAttachmentKind,
  chatAttachmentMimeTypeForName,
} from "@shared/attachments";
import { mergeComposerAttachments } from "../../utils/composerAttachments";
import { supportsActiveParentFollowUp } from "../../utils/composerPrimaryAction";
import type { ComposerProps } from "./types";

interface ComposerAttachmentActionOptions {
  attachmentAuthorityRef: MutableRefObject<number>;
  attachmentsRef: MutableRefObject<ChatAttachment[]>;
  blocked: boolean;
  conversationId: string;
  conversationIdRef: MutableRefObject<string>;
  harnessId: string | null;
  markEditorChanged(): void;
  mountedRef: MutableRefObject<boolean>;
  onChooseAttachments: ComposerProps["onChooseAttachments"];
  onImportAttachments: ComposerProps["onImportAttachments"];
  releaseAttachmentRef: MutableRefObject<ComposerProps["onReleaseAttachment"]>;
  running: boolean;
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  submittingRef: MutableRefObject<boolean>;
}

export interface ComposerAttachmentActions {
  chooseAttachments(): Promise<void>;
  importAttachments(files: File[]): Promise<void>;
  removeAttachment(attachment: ChatAttachment): void;
}

export function composerAttachmentActions({
  attachmentAuthorityRef,
  attachmentsRef,
  blocked,
  conversationId,
  conversationIdRef,
  harnessId,
  markEditorChanged,
  mountedRef,
  onChooseAttachments,
  onImportAttachments,
  releaseAttachmentRef,
  running,
  setAttachments,
  submittingRef,
}: ComposerAttachmentActionOptions): ComposerAttachmentActions {
  const addAttachments = (incoming: readonly ChatAttachment[]): void => {
    const permitted = running
      ? incoming.filter(({ mimeType }) => chatAttachmentKind(mimeType) === "image")
      : incoming;
    const blockedAttachments = permitted.length === incoming.length
      ? []
      : incoming.filter(({ mimeType }) => chatAttachmentKind(mimeType) !== "image");
    const merged = mergeComposerAttachments(attachmentsRef.current, permitted);
    const changed = merged.attachments.length !== attachmentsRef.current.length
      || merged.attachments.some(
        ({ id }, index) => id !== attachmentsRef.current[index]?.id,
      );
    if (changed) markEditorChanged();
    attachmentsRef.current = merged.attachments;
    setAttachments(() => merged.attachments);
    for (const attachment of [...blockedAttachments, ...merged.rejected]) {
      void releaseAttachmentRef.current(attachment.id);
    }
  };

  const selectionRemainsAuthorized = (authority: number): boolean =>
    mountedRef.current
    && attachmentAuthorityRef.current === authority
    && conversationIdRef.current === conversationId;
  const releaseSelected = (selected: readonly ChatAttachment[]): void => {
    for (const attachment of selected) {
      void releaseAttachmentRef.current(attachment.id);
    }
  };
  const actionBlocked = (): boolean =>
    submittingRef.current
    || blocked
    || (running && !supportsActiveParentFollowUp(harnessId));

  return {
    async chooseAttachments() {
      if (actionBlocked()) return;
      const authority = attachmentAuthorityRef.current;
      const selected = await onChooseAttachments(running ? "images" : "all");
      if (!selectionRemainsAuthorized(authority)) {
        releaseSelected(selected);
        return;
      }
      addAttachments(selected);
    },
    async importAttachments(files) {
      if (actionBlocked()) return;
      const authority = attachmentAuthorityRef.current;
      const remaining = Math.max(
        0,
        MAX_CHAT_ATTACHMENTS - attachmentsRef.current.length,
      );
      const candidates = (running
        ? files.filter((file) => {
            const mimeType = chatAttachmentMimeTypeForName(file.name);
            return mimeType !== null && chatAttachmentKind(mimeType) === "image";
          })
        : files).slice(0, remaining);
      if (candidates.length === 0) return;
      const selected = await onImportAttachments(candidates);
      if (!selectionRemainsAuthorized(authority)) {
        releaseSelected(selected);
        return;
      }
      addAttachments(selected);
    },
    removeAttachment(attachment) {
      if (!attachmentsRef.current.some(({ id }) => id === attachment.id)) return;
      markEditorChanged();
      const next = attachmentsRef.current.filter(({ id }) => id !== attachment.id);
      attachmentsRef.current = next;
      setAttachments(() => next);
      void releaseAttachmentRef.current(attachment.id);
    },
  };
}
