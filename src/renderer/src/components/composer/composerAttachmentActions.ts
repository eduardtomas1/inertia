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
  attachmentAuthorityKey: string;
  attachmentAuthorityRef: MutableRefObject<{
    key: string;
    conversationId: string;
  }>;
  attachmentImportSequenceRef: MutableRefObject<number>;
  attachmentImportingRef: MutableRefObject<boolean>;
  attachmentsRef: MutableRefObject<ChatAttachment[]>;
  pendingAttachmentIdsRef: MutableRefObject<Set<string>>;
  blocked: boolean;
  conversationId: string;
  harnessId: string | null;
  markEditorChanged: () => void;
  mountedRef: MutableRefObject<boolean>;
  onChooseAttachments: ComposerProps["onChooseAttachments"];
  onImportAttachments: ComposerProps["onImportAttachments"];
  releaseAttachmentRef: MutableRefObject<ComposerProps["onReleaseAttachment"]>;
  running: boolean;
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  setAttachmentImporting: Dispatch<SetStateAction<boolean>>;
  setPendingAttachmentIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  submittingRef: MutableRefObject<boolean>;
}

export interface ComposerAttachmentActions {
  chooseAttachments(): Promise<void>;
  importAttachments(files: File[]): Promise<void>;
  removeAttachment(attachment: ChatAttachment): void;
}

export function composerAttachmentActions({
  attachmentAuthorityKey,
  attachmentAuthorityRef,
  attachmentImportSequenceRef,
  attachmentImportingRef,
  attachmentsRef,
  pendingAttachmentIdsRef,
  blocked,
  conversationId,
  harnessId,
  markEditorChanged,
  mountedRef,
  onChooseAttachments,
  onImportAttachments,
  releaseAttachmentRef,
  running,
  setAttachments,
  setAttachmentImporting,
  setPendingAttachmentIds,
  submittingRef,
}: ComposerAttachmentActionOptions): ComposerAttachmentActions {
  const addAttachments = (
    incoming: readonly ChatAttachment[],
    releaseRejected = true,
    pendingPrivilegedCommit = false,
  ): string[] => {
    const permitted = running
      ? incoming.filter(({ mimeType }) => chatAttachmentKind(mimeType) === "image")
      : incoming;
    const blockedAttachments = permitted.length === incoming.length
      ? []
      : incoming.filter(({ mimeType }) => chatAttachmentKind(mimeType) !== "image");
    const current = attachmentsRef.current;
    const currentIds = new Set(current.map(({ id }) => id));
    const merged = mergeComposerAttachments(current, permitted);
    const changed = merged.attachments.length !== current.length
      || merged.attachments.some(
        ({ id }, index) => id !== current[index]?.id,
      );
    const adoptedIds = merged.attachments
      .filter(({ id }) => !currentIds.has(id))
      .map(({ id }) => id);
    if (pendingPrivilegedCommit && adoptedIds.length > 0) {
      const pending = new Set(pendingAttachmentIdsRef.current);
      for (const id of adoptedIds) pending.add(id);
      pendingAttachmentIdsRef.current = pending;
      setPendingAttachmentIds(pending);
    }
    if (changed) markEditorChanged();
    attachmentsRef.current = merged.attachments;
    setAttachments(() => merged.attachments);
    if (releaseRejected) {
      for (const attachment of [...blockedAttachments, ...merged.rejected]) {
        void releaseAttachmentRef.current(attachment.id);
      }
    }
    return adoptedIds;
  };

  const settlePendingAttachments = (ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const next = new Set(pendingAttachmentIdsRef.current);
    for (const id of ids) next.delete(id);
    pendingAttachmentIdsRef.current = next;
    if (mountedRef.current
      && attachmentAuthorityRef.current.conversationId === conversationId) {
      setPendingAttachmentIds(next);
    }
  };

  const selectionRemainsAuthorized = (authority: string): boolean =>
    mountedRef.current
    && attachmentAuthorityRef.current.key === authority
    && attachmentAuthorityRef.current.conversationId === conversationId;
  const selectionOwnsVisibleComposer = (): boolean =>
    mountedRef.current
    && attachmentAuthorityRef.current.conversationId === conversationId;
  const actionBlocked = (): boolean =>
    submittingRef.current
    || attachmentImportingRef.current
    || blocked
    || (running && !supportsActiveParentFollowUp(harnessId));
  const beginImport = (): number => {
    const sequence = attachmentImportSequenceRef.current + 1;
    attachmentImportSequenceRef.current = sequence;
    attachmentImportingRef.current = true;
    setAttachmentImporting(true);
    return sequence;
  };
  const finishImport = (sequence: number): void => {
    if (attachmentImportSequenceRef.current !== sequence) return;
    attachmentImportingRef.current = false;
    setAttachmentImporting(false);
  };
  const cancelPrivilegedLease = async (
    lease: NonNullable<Awaited<ReturnType<ComposerProps["onImportAttachments"]>>>,
  ): Promise<void> => { await Promise.allSettled([lease.cancel()]); };
  const adoptPrivilegedLease = async (
    lease: NonNullable<Awaited<ReturnType<ComposerProps["onImportAttachments"]>>>,
    authority: string,
  ): Promise<void> => {
    if (!selectionRemainsAuthorized(authority)) {
      await cancelPrivilegedLease(lease);
      return;
    }
    const adoptedIds = addAttachments(lease.attachments, false, true);
    if (adoptedIds.length === 0) {
      await cancelPrivilegedLease(lease);
      return;
    }
    try {
      await lease.commit(adoptedIds);
      const stillAuthorized = selectionRemainsAuthorized(authority);
      settlePendingAttachments(adoptedIds);
      if (!stillAuthorized) {
        const adopted = new Set(adoptedIds);
        const next = attachmentsRef.current.filter(({ id }) => !adopted.has(id));
        attachmentsRef.current = next;
        if (selectionOwnsVisibleComposer()) {
          setAttachments(() => next);
        }
        for (const id of adoptedIds) void releaseAttachmentRef.current(id);
      }
    } catch {
      const adopted = new Set(adoptedIds);
      const next = attachmentsRef.current.filter(({ id }) => !adopted.has(id));
      attachmentsRef.current = next;
      settlePendingAttachments(adoptedIds);
      if (selectionOwnsVisibleComposer()) {
        setAttachments(() => next);
      }
      await cancelPrivilegedLease(lease);
    }
  };

  return {
    async chooseAttachments() {
      if (actionBlocked()) return;
      const importSequence = beginImport();
      const authority = attachmentAuthorityKey;
      try {
        const lease = await onChooseAttachments(running ? "images" : "all");
        if (lease) await adoptPrivilegedLease(lease, authority);
      } finally {
        finishImport(importSequence);
      }
    },
    async importAttachments(files) {
      if (actionBlocked()) return;
      const authority = attachmentAuthorityKey;
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
      const importSequence = beginImport();
      try {
        const lease = await onImportAttachments(candidates);
        if (!lease) return;
        await adoptPrivilegedLease(lease, authority);
      } finally {
        finishImport(importSequence);
      }
    },
    removeAttachment(attachment) {
      if (attachmentImportingRef.current) return;
      if (!attachmentsRef.current.some(({ id }) => id === attachment.id)) return;
      markEditorChanged();
      const next = attachmentsRef.current.filter(({ id }) => id !== attachment.id);
      attachmentsRef.current = next;
      setAttachments(() => next);
      void releaseAttachmentRef.current(attachment.id);
    },
  };
}
