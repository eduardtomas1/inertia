import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "@shared/contracts";
import type { PreviewBounds, PreviewState } from "@shared/desktop";
import type { AttachmentPickerMode } from "@shared/desktop";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
} from "@shared/attachments";

interface DesktopToolsOptions {
  setActionError: (message: string | null) => void;
  previewOwnerId?: "primary" | "secondary";
  previewContextId?: string | null;
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

export async function importComposerAttachmentFilesSequentially(
  files: readonly File[],
  importOne: (
    value: { name: string; mimeType: string; data: ArrayBuffer },
  ) => Promise<ChatAttachment[]>,
  release: (id: string) => Promise<void>,
): Promise<ChatAttachment[]> {
  preflightComposerAttachmentFiles(files);
  const imported: ChatAttachment[] = [];
  try {
    for (const file of files) {
      const data = await file.arrayBuffer();
      if (data.byteLength !== file.size) {
        throw new Error("An attachment changed while it was being imported.");
      }
      const current = await importOne({
        name: file.name,
        mimeType: file.type,
        data,
      });
      if (current.length !== 1) {
        throw new Error("Attachment import did not complete.");
      }
      imported.push(current[0]!);
    }
    return imported;
  } catch (error) {
    await Promise.allSettled(imported.map(async ({ id }) => await release(id)));
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
  const [ownedPreview, setOwnedPreview] = useState<{
    contextId: string | null;
    url: string;
    navigation: PreviewState;
  }>({
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
      setOwnedPreview({
        contextId: state.contextId,
        url: state.url,
        navigation: state,
      });
    });
    return () => {
      unsubscribe();
      void window.inertia.previewClose({
        ownerId: previewOwnerId,
        contextId: previewContextId,
      }).catch(() => undefined);
    };
  }, [previewContextId, previewOwnerId]);

  const chooseComposerAttachments = useCallback(
    async (mode: AttachmentPickerMode = "all"): Promise<ChatAttachment[]> => {
      try {
        return await window.inertia.selectAttachments(mode);
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : "Attachments could not be added.",
        );
        return [];
      }
    },
    [setActionError],
  );

  const importComposerAttachments = useCallback(
    async (files: File[]): Promise<ChatAttachment[]> => {
      try {
        return await importComposerAttachmentFilesSequentially(
          files,
          async (value) => await window.inertia.importAttachments([value]),
          async (id) => await window.inertia.releaseAttachment(id),
        );
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : "Attachments could not be added.",
        );
        return [];
      }
    },
    [setActionError],
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
  };
}
