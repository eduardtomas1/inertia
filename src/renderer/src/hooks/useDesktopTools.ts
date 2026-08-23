import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "@shared/contracts";
import type {
  BrowserEvidenceImage,
} from "@shared/browser-evidence";
import type { PreviewBounds, PreviewState, PreviewStateUpdate } from "@shared/desktop";
import type { AttachmentPickerMode } from "@shared/desktop";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
} from "@shared/attachments";
import type { ComposerAttachmentImportLease } from "../utils/composerAttachments";

interface DesktopToolsOptions {
  setActionError: (message: string | null) => void;
  previewOwnerId?: "primary" | "secondary";
  previewContextId?: string | null;
}

interface OwnedPreviewState {
  contextId: string | null;
  url: string;
  navigation: PreviewState;
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
  let totalBytes = 0;
  for (const file of files) {
    if (
      !Number.isSafeInteger(file.size)
      || file.size < 1
      || file.size > MAX_CHAT_ATTACHMENT_BYTES
    ) {
      throw new Error(
        "An attachment is empty or exceeds the 10 MB file limit.",
      );
    }
    totalBytes += file.size;
    if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      throw new Error("Attachments exceed the 20 MB turn limit.");
    }
  }
}

export interface ComposerAttachmentImportBatch {
  begin(): Promise<string>;
  importOne(
    batchId: string,
    value: { name: string; mimeType: string; data: ArrayBuffer },
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
  const digests = new Set<string>();
  const imported: ChatAttachment[] = [];
  try {
    for (const file of files) {
      const data = await file.arrayBuffer();
      if (data.byteLength !== file.size) {
        throw new Error("An attachment changed while it was being imported.");
      }
      const digestBytes = new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", data),
      );
      const digest = Array.from(
        digestBytes,
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (digests.has(digest)) continue;
      const current = await batch.importOne(batchId, {
        name: file.name,
        mimeType: file.type,
        data,
      });
      if (current.length !== 1) {
        throw new Error("Attachment import did not complete.");
      }
      digests.add(digest);
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
  const authorityRef = useRef({ previewOwnerId, previewContextId });
  authorityRef.current = { previewOwnerId, previewContextId };
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
    const unsubscribe = window.inertia.onPreviewState((state) => {
      const authority = authorityRef.current;
      if (
        state.ownerId !== authority.previewOwnerId
        || state.contextId !== authority.previewContextId
      ) return;
      setOwnedPreview((current) => mergePreviewStateUpdate(current, state));
    });
    return () => {
      unsubscribe();
      void window.inertia.previewClose({
        ownerId: previewOwnerId,
        contextId: previewContextId,
      }).catch(() => undefined);
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
          setActionError(
            error instanceof Error
              ? error.message
              : "Attachments could not be added.",
          );
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
        setActionError(
          error instanceof Error
            ? error.message
            : "Attachments could not be added.",
        );
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
        setActionError(
          error instanceof Error
            ? error.message
            : "Attachments could not be added.",
        );
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
        const authority = authorityRef.current;
        if (
          authority.previewOwnerId !== previewOwnerId
          || authority.previewContextId !== contextId
        ) return;
        setOwnedPreview({
          contextId,
          url: state.url,
          navigation: state,
        });
        onSettled?.();
      })
      .catch((error) => {
        const authority = authorityRef.current;
        if (
          authority.previewOwnerId !== previewOwnerId
          || authority.previewContextId !== contextId
        ) return;
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
  }, [previewContextId, previewOwnerId, setActionError]);

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
        const authority = authorityRef.current;
        if (
          authority.previewOwnerId !== previewOwnerId
          || authority.previewContextId !== contextId
        ) return;
        setOwnedPreview({
          contextId,
          url: state.url,
          navigation: state,
        });
      })
      .catch((error) => {
        const authority = authorityRef.current;
        if (
          authority.previewOwnerId !== previewOwnerId
          || authority.previewContextId !== contextId
        ) return;
        setActionError(
          error instanceof Error
            ? error.message
            : "The preview command failed.",
        );
      });
  }, [previewContextId, previewOwnerId, setActionError]);

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
        const authority = authorityRef.current;
        if (
          authority.previewOwnerId !== previewOwnerId
          || authority.previewContextId !== contextId
        ) return;
        setOwnedPreview({ contextId, url: state.url, navigation: state });
      })
      .catch((error) => {
        const authority = authorityRef.current;
        if (
          authority.previewOwnerId !== previewOwnerId
          || authority.previewContextId !== contextId
        ) return;
        setActionError(
          error instanceof Error
            ? error.message
            : "The Browser tab action failed.",
        );
      });
  }, [previewContextId, previewOwnerId, setActionError]);

  const setPreviewBounds = useCallback((bounds: PreviewBounds | null) => {
    if (!previewContextId) return;
    void window.inertia.previewSetBounds({
      ownerId: previewOwnerId,
      contextId: previewContextId,
      bounds,
    }).catch(() => undefined);
  }, [previewContextId, previewOwnerId]);

  const loadPreviewEvidenceImage = useCallback(async (
    evidenceId: string,
  ): Promise<BrowserEvidenceImage | null> => {
    const contextId = previewContextId;
    if (!contextId) return null;
    try {
      const image = await window.inertia.previewEvidenceImage({
        ownerId: previewOwnerId,
        contextId,
        evidenceId,
      });
      const authority = authorityRef.current;
      return authority.previewOwnerId === previewOwnerId
        && authority.previewContextId === contextId
        ? image
        : null;
    } catch {
      return null;
    }
  }, [previewContextId, previewOwnerId]);

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
    loadPreviewEvidenceImage,
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
