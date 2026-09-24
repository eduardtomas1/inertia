import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { ChatAttachment } from "@shared/contracts";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentKind,
  safeChatAttachmentMimeTypeForName as chatAttachmentMimeTypeForName,
} from "@shared/attachments";
import { formatAttachmentSize, mergeComposerAttachments, type ComposerAttachmentAdoptionResult, type ComposerAttachmentImportLease } from "../../utils/composerAttachments";
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
  markEditorChanged: () => void;
  mountedRef: MutableRefObject<boolean>;
  onChooseAttachments: ComposerProps["onChooseAttachments"];
  onImportAttachments: ComposerProps["onImportAttachments"];
  releaseAttachmentRef: MutableRefObject<ComposerProps["onReleaseAttachment"]>;
  running: boolean;
  imageInputUnavailableReason: string | null;
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  setAttachmentImporting: Dispatch<SetStateAction<boolean>>;
  setAttachmentError: Dispatch<SetStateAction<string | null>>;
  setPendingAttachmentIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  submittingRef: MutableRefObject<boolean>;
}

const MAX_NAMED_UNSUPPORTED_FILES = 3;
const SUPPORTED_ATTACHMENT_TYPES = "PNG, JPEG, WebP, GIF, PDF, TXT, Markdown, CSV, JSON, XLSX and XLS";
/** Same wording the runtime uses when it refuses a document follow-up. */
export const DOCUMENT_FOLLOW_UP_UNSUPPORTED =
  "Follow-ups while the agent is working support images only. Documents were not attached.";

export interface ComposerAttachmentActions {
  adoptAttachments(lease: ComposerAttachmentImportLease): Promise<ComposerAttachmentAdoptionResult>;
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
  markEditorChanged,
  mountedRef,
  onChooseAttachments,
  onImportAttachments,
  releaseAttachmentRef,
  running,
  imageInputUnavailableReason,
  setAttachments,
  setAttachmentImporting,
  setAttachmentError,
  setPendingAttachmentIds,
  submittingRef,
}: ComposerAttachmentActionOptions): ComposerAttachmentActions {
  const reportAttachmentLimit = (): void => setAttachmentError(
    `Some files were not attached. A message supports up to ${MAX_CHAT_ATTACHMENTS} attachments totaling ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_TOTAL_BYTES)}.`,
  );
  const permitsKind = (mimeType: Parameters<typeof chatAttachmentKind>[0] | null): boolean => {
    const image = mimeType !== null && chatAttachmentKind(mimeType) === "image";
    return image ? !imageInputUnavailableReason : !running;
  };
  const reportImagesRejected = (
    mimeTypes: readonly (Parameters<typeof chatAttachmentKind>[0] | null)[],
  ): void => {
    if (imageInputUnavailableReason && mimeTypes.some((mimeType) =>
      mimeType !== null && chatAttachmentKind(mimeType) === "image")) {
      setAttachmentError(`${imageInputUnavailableReason} Images were not attached.`);
    }
  };
  const reportDocumentsRejected = (
    mimeTypes: readonly (Parameters<typeof chatAttachmentKind>[0] | null)[],
  ): void => {
    if (running && mimeTypes.some((mimeType) =>
      mimeType !== null && chatAttachmentKind(mimeType) === "document")) {
      setAttachmentError(DOCUMENT_FOLLOW_UP_UNSUPPORTED);
    }
  };
  // One unsupported file used to fail the whole batch in the main process
  // with a bare "Invalid attachment."; name the files and import the rest.
  const reportUnsupportedFiles = (files: readonly File[]): void => {
    if (files.length === 0) return;
    const names = files.slice(0, MAX_NAMED_UNSUPPORTED_FILES).map((file) => file.name);
    const more = files.length - names.length;
    setAttachmentError(
      `Unsupported file type: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}. `
      + `Supported types: ${SUPPORTED_ATTACHMENT_TYPES}.`,
    );
  };
  const addAttachments = (
    incoming: readonly ChatAttachment[],
  ): string[] => {
    const permitted = incoming.filter(({ mimeType }) => permitsKind(mimeType));
    reportImagesRejected(incoming.map(({ mimeType }) => mimeType));
    reportDocumentsRejected(incoming.map(({ mimeType }) => mimeType));
    const current = attachmentsRef.current;
    const merged = mergeComposerAttachments(current, permitted);
    const acceptedIds = new Set(merged.attachments.map(({ id }) => id));
    if (merged.rejected.some(({ id }) => !acceptedIds.has(id))) reportAttachmentLimit();
    // Merging preserves the current prefix and only appends accepted imports.
    const adoptedIds = merged.attachments
      .slice(current.length)
      .map(({ id }) => id);
    if (adoptedIds.length > 0) {
      const pending = new Set(pendingAttachmentIdsRef.current);
      for (const id of adoptedIds) pending.add(id);
      pendingAttachmentIdsRef.current = pending;
      setPendingAttachmentIds(pending);
      markEditorChanged();
    }
    attachmentsRef.current = merged.attachments;
    setAttachments(() => merged.attachments);
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
    || blocked;
  const beginImport = (): number => {
    setAttachmentError(null);
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
  ): Promise<ComposerAttachmentAdoptionResult> => {
    if (!selectionRemainsAuthorized(authority)) {
      await cancelPrivilegedLease(lease);
      return "cancelled";
    }
    const adoptedIds = addAttachments(lease.attachments);
    if (adoptedIds.length === 0) {
      await cancelPrivilegedLease(lease);
      return selectionRemainsAuthorized(authority) ? "rejected" : "cancelled";
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
        return "cancelled";
      }
      return "adopted";
    } catch {
      const adopted = new Set(adoptedIds);
      const next = attachmentsRef.current.filter(({ id }) => !adopted.has(id));
      attachmentsRef.current = next;
      settlePendingAttachments(adoptedIds);
      if (selectionOwnsVisibleComposer()) {
        setAttachments(() => next);
      }
      await cancelPrivilegedLease(lease);
      return selectionRemainsAuthorized(authority) ? "rejected" : "cancelled";
    }
  };

  return {
    async adoptAttachments(lease) {
      if (actionBlocked()) { await cancelPrivilegedLease(lease); return selectionRemainsAuthorized(attachmentAuthorityKey) ? "rejected" : "cancelled"; }
      const sequence = beginImport();
      try { return await adoptPrivilegedLease(lease, attachmentAuthorityKey); } finally { finishImport(sequence); }
    },
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
      const mimeTypes = files.map((file) => chatAttachmentMimeTypeForName(file.name));
      const supported = files.filter((_file, index) => mimeTypes[index] !== null);
      const eligible = running || imageInputUnavailableReason
        ? supported.filter((file) => permitsKind(chatAttachmentMimeTypeForName(file.name)))
        : supported;
      // Reported after beginImport() clears the previous error, so a partial
      // batch keeps its explanation while the supported files are imported.
      const reportSkippedFiles = (): void => {
        reportUnsupportedFiles(files.filter((_file, index) => mimeTypes[index] === null));
        reportImagesRejected(mimeTypes);
        reportDocumentsRejected(mimeTypes);
        if (eligible.length > remaining) reportAttachmentLimit();
      };
      const candidates = eligible.slice(0, remaining);
      if (candidates.length === 0) {
        reportSkippedFiles();
        return;
      }
      const importSequence = beginImport();
      reportSkippedFiles();
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
      setAttachmentError(null);
      const next = attachmentsRef.current.filter(({ id }) => id !== attachment.id);
      attachmentsRef.current = next;
      setAttachments(() => next);
      void releaseAttachmentRef.current(attachment.id);
    },
  };
}
