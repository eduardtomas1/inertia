import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "@shared/contracts";
import type { PreviewBounds, PreviewState, PreviewStateUpdate } from "@shared/desktop";
import type { AttachmentPickerMode } from "@shared/desktop";
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from "@shared/attachments";
import type { ComposerAttachmentImportLease } from "../utils/composerAttachments";
import type { WorkspacePreviewOwner } from "../utils/workspacePreviewFocus";

interface DesktopToolsOptions {
  setActionError: (message: string | null) => void;
  previewOwnerId?: WorkspacePreviewOwner;
  previewContextId?: string | null;
}

interface OwnedPreviewState {
  contextId: string | null;
  url: string;
  navigation: PreviewState;
}

interface PreviewConnection {
  ownerId: WorkspacePreviewOwner;
  contextId: string;
  connectionId: string;
}

export function mergePreviewStateUpdate(
  current: OwnedPreviewState,
  state: PreviewStateUpdate,
): OwnedPreviewState {
  const evidence = state.evidence
    ?? (current.contextId === state.contextId
      ? current.navigation.evidence
      : emptyPreviewState().evidence);
  return {
    contextId: state.contextId,
    url: state.url,
    navigation: { ...state, evidence },
  };
}

export function preflightComposerAttachmentFiles(
  files: readonly File[],
): void {
  if (files.length > MAX_ATTACHMENT_COUNT) throw new Error(`Select at most ${MAX_ATTACHMENT_COUNT} attachments.`);
  let totalBytes = 0;
  for (const file of files) {
    if (
      !Number.isSafeInteger(file.size)
      || file.size < 1
      || file.size > MAX_ATTACHMENT_BYTES
    ) {
      throw new Error(
        "An attachment is empty or larger than the 50 MiB file limit. No files were attached.",
      );
    }
    totalBytes += file.size;
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      throw new Error("Attachments exceed the maximum message size.");
    }
  }
}

// Electron rethrows main-process IPC errors as
// "Error invoking remote method '<channel>': Error: <message>".
export const ELECTRON_IPC_ERROR_PREFIX =
  /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/u;

/** Shows an attachment import failure without Electron's IPC wrapper text. */
export function attachmentImportErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message.replace(ELECTRON_IPC_ERROR_PREFIX, "").trim()
    : "";
  return message || "Attachments could not be added.";
}

export interface ComposerAttachmentImportBatch {
  begin(): Promise<string>;
  importOne(
    batchId: string,
    value: import("@shared/desktop").AttachmentImport,
  ): Promise<ChatAttachment[]>;
  cancel(batchId: string): Promise<void>;
}

export interface PreparedComposerAttachmentImport {
  readonly batchId: string;
  readonly attachments: readonly ChatAttachment[];
}

export async function importComposerAttachmentFilesSequentially(
  files: readonly File[],
  batch: ComposerAttachmentImportBatch,
): Promise<PreparedComposerAttachmentImport> {
  preflightComposerAttachmentFiles(files);
  const batchId = await batch.begin();
  const imported: ChatAttachment[] = [];
  try {
    for (const file of files) {
      let current: ChatAttachment[] = [];
      for (let offset = 0; offset < file.size; offset += ATTACHMENT_UPLOAD_CHUNK_BYTES) {
        const end = Math.min(file.size, offset + ATTACHMENT_UPLOAD_CHUNK_BYTES);
        const data = await file.slice(offset, end).arrayBuffer();
        if (data.byteLength !== end - offset) throw new Error("An attachment changed while it was being imported.");
        current = await batch.importOne(batchId, {
          name: file.name, mimeType: file.type, data,
          stream: { size: file.size, offset, final: end === file.size },
        });
        if (end < file.size && current.length !== 0) throw new Error("Invalid attachment upload acknowledgement.");
      }
      if (current.length === 0) continue;
      if (current.length !== 1) throw new Error("Attachment import did not complete.");
      imported.push(current[0]!);
    }
    return { batchId, attachments: imported };
  } catch (error) {
    try {
      await batch.cancel(batchId);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Attachments could not be rolled back safely.",
      );
    }
    throw error;
  }
}

export function useDesktopTools({
  setActionError,
  previewOwnerId = "primary",
  previewContextId = null,
}: DesktopToolsOptions) {
  const previewConnectionRef = useRef<PreviewConnection | null>(null);
  const previewBoundsRef = useRef<PreviewBounds | null>(null);
  const authorityRef = useRef({ previewOwnerId, previewContextId });
  authorityRef.current = { previewOwnerId, previewContextId };
  const previewIsCurrent = useCallback(() => {
    const authority = authorityRef.current;
    return authority.previewOwnerId === previewOwnerId
      && authority.previewContextId === previewContextId;
  }, [previewOwnerId, previewContextId]);
  const [ownedPreview, setOwnedPreview] = useState<OwnedPreviewState>({
    contextId: previewContextId,
    url: "",
    navigation: emptyPreviewState(),
  });

  useEffect(() => {
    setOwnedPreview({
      contextId: previewContextId,
      url: "",
      navigation: emptyPreviewState(),
    });
    if (!previewContextId) return;
    const connection = {
      ownerId: previewOwnerId,
      contextId: previewContextId,
      connectionId: crypto.randomUUID(),
    };
    previewConnectionRef.current = connection;
    const unsubscribe = window.inertia.onPreviewState((state) => {
      const authority = authorityRef.current;
      if (
        state.ownerId !== authority.previewOwnerId
        || state.contextId !== authority.previewContextId
      ) return;
      setOwnedPreview((current) => mergePreviewStateUpdate(current, state));
    });
    void window.inertia.previewConnect(connection).then((state) => {
      if (previewConnectionRef.current !== connection) return;
      setOwnedPreview({
        contextId: previewContextId,
        url: state.url,
        navigation: state,
      });
      const bounds = previewBoundsRef.current;
      if (bounds) {
        void window.inertia.previewSetBounds({ ...connection, bounds })
          .catch(() => undefined);
      }
    }).catch(() => undefined);
    return () => {
      unsubscribe();
      previewConnectionRef.current = null;
      void window.inertia.previewClose(connection).catch(() => undefined);
    };
  }, [previewContextId, previewOwnerId]);

  const composerAttachmentLease = useCallback((
    prepared: PreparedComposerAttachmentImport,
  ): ComposerAttachmentImportLease => {
    let settled = false;
    return {
      attachments: prepared.attachments,
      async commit(adoptedAttachmentIds) {
        if (settled) throw new Error("Attachment import is already settled.");
        try {
          await window.inertia.commitAttachmentImport(
            prepared.batchId,
            [...adoptedAttachmentIds],
          );
          settled = true;
        } catch (error) {
          setActionError(attachmentImportErrorMessage(error));
          throw error;
        }
      },
      async cancel() {
        if (settled) return;
        try {
          await window.inertia.cancelAttachmentImport(prepared.batchId);
          settled = true;
        } catch (error) {
          setActionError("Attachments could not be rolled back safely.");
          throw error;
        }
      },
    };
  }, [setActionError]);

  const chooseComposerAttachments = useCallback(
    async (
      mode: AttachmentPickerMode = "all",
    ): Promise<ComposerAttachmentImportLease | null> => {
      try {
        const prepared = await window.inertia.selectAttachments(mode);
        return prepared ? composerAttachmentLease(prepared) : null;
      } catch (error) {
        setActionError(attachmentImportErrorMessage(error));
        return null;
      }
    },
    [composerAttachmentLease, setActionError],
  );

  const importComposerAttachments = useCallback(
    async (files: File[]): Promise<ComposerAttachmentImportLease | null> => {
      try {
        const prepared = await importComposerAttachmentFilesSequentially(
          files,
          {
            begin: async () => await window.inertia.beginAttachmentImport(),
            importOne: async (batchId, value) =>
              await window.inertia.importAttachments(batchId, [value]),
            cancel: async (batchId) =>
              await window.inertia.cancelAttachmentImport(batchId),
          },
        );
        return composerAttachmentLease(prepared);
      } catch (error) {
        setActionError(attachmentImportErrorMessage(error));
        return null;
      }
    },
    [composerAttachmentLease, setActionError],
  );

  const releaseComposerAttachment = useCallback(
    async (id: string): Promise<void> => {
      try {
        await window.inertia.releaseAttachment(id);
      } catch {
        // Releasing an unsent temporary attachment is best effort.
      }
    },
    [],
  );

  const navigatePreview = useCallback((
    url: string,
    onSettled?: () => void,
  ) => {
    const contextId = previewContextId;
    if (!contextId) return;
    setOwnedPreview((current) => ({
      contextId,
      url,
      navigation: { ...current.navigation, url, loading: true },
    }));
    void window.inertia.previewNavigate({
      ownerId: previewOwnerId,
      contextId,
      url,
    })
      .then((state) => {
        if (!previewIsCurrent()) return;
        setOwnedPreview({
          contextId,
          url: state.url,
          navigation: state,
        });
        onSettled?.();
      })
      .catch((error) => {
        if (!previewIsCurrent()) return;
        setActionError(
          error instanceof Error
            ? error.message
            : "The preview could not be opened.",
        );
        setOwnedPreview((current) => ({
          ...current,
          navigation: {
            ...current.navigation,
            loading: false,
          },
        }));
        onSettled?.();
      });
  }, [previewContextId, previewOwnerId, previewIsCurrent, setActionError]);

  const previewCommand = useCallback((
    action: "back" | "forward" | "reload",
  ) => {
    const contextId = previewContextId;
    if (!contextId) return;
    void window.inertia.previewCommand({
      ownerId: previewOwnerId,
      contextId,
      action,
    })
      .then((state) => {
        if (!previewIsCurrent()) return;
        setOwnedPreview({
          contextId,
          url: state.url,
          navigation: state,
        });
      })
      .catch((error) => {
        if (!previewIsCurrent()) return;
        setActionError(
          error instanceof Error
            ? error.message
            : "The preview command failed.",
        );
      });
  }, [previewContextId, previewOwnerId, previewIsCurrent, setActionError]);

  const previewTab = useCallback((
    action: "open" | "activate" | "close",
    tabId?: string,
  ) => {
    const contextId = previewContextId;
    if (!contextId) return;
    void window.inertia.previewTab({
      ownerId: previewOwnerId,
      contextId,
      action,
      ...(tabId ? { tabId } : {}),
    })
      .then((state) => {
        if (!previewIsCurrent()) return;
        setOwnedPreview({ contextId, url: state.url, navigation: state });
      })
      .catch((error) => {
        if (!previewIsCurrent()) return;
        setActionError(
          error instanceof Error
            ? error.message
            : "The Browser tab action failed.",
        );
      });
  }, [previewContextId, previewOwnerId, previewIsCurrent, setActionError]);

  const setPreviewBounds = useCallback((bounds: PreviewBounds | null) => {
    previewBoundsRef.current = bounds;
    const connection = previewConnectionRef.current;
    if (!connection) return;
    void window.inertia.previewSetBounds({
      ...connection,
      bounds,
    }).catch(() => undefined);
  }, []);

  const inspectPreviewEvidenceImage = useCallback(async (
    evidenceId: string,
  ): Promise<boolean> => {
    const contextId = previewContextId;
    if (!contextId) return false;
    try {
      const opened = await window.inertia.previewInspectEvidenceImage({
        ownerId: previewOwnerId,
        contextId,
        evidenceId,
      });
      return previewIsCurrent() && opened;
    } catch {
      return false;
    }
  }, [previewContextId, previewOwnerId, previewIsCurrent]);

  const visiblePreview = ownedPreview.contextId === previewContextId
    ? ownedPreview
    : {
        contextId: previewContextId,
        url: "",
        navigation: emptyPreviewState(),
      };

  return {
    previewUrl: visiblePreview.url,
    previewNavigation: visiblePreview.navigation,
    chooseComposerAttachments,
    importComposerAttachments,
    releaseComposerAttachment,
    navigatePreview,
    previewCommand,
    previewTab,
    setPreviewBounds,
    inspectPreviewEvidenceImage,
  };
}

function emptyPreviewState(): PreviewState {
  return {
    url: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    activeTabId: null,
    tabs: [],
    agentActivity: null,
    evidence: { revision: 0, entries: [], omitted: false },
  };
}
