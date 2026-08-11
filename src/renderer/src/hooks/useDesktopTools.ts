import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "@shared/contracts";
import type { PreviewBounds, PreviewState } from "@shared/desktop";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
} from "@shared/attachments";

interface DesktopToolsOptions {
  setActionError: (message: string | null) => void;
  previewOwnerId?: "primary" | "secondary";
  previewContextId?: string | null;
}

function loadedPreviewUrl(requestedUrl: string, loadedUrl: string): string {
  if (!loadedUrl) return "";
  try {
    return new URL(requestedUrl).origin === new URL(loadedUrl).origin
      ? loadedUrl
      : "";
  } catch {
    return "";
  }
}

export async function prepareComposerAttachmentImports(
  files: readonly File[],
): Promise<Array<{ name: string; mimeType: string; data: ArrayBuffer }>> {
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
  return await Promise.all(files.map(async (file) => ({
    name: file.name,
    mimeType: file.type,
    data: await file.arrayBuffer(),
  })));
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
    lastLoadedUrl: string;
    navigation: PreviewState;
  }>({
    contextId: previewContextId,
    url: "",
    lastLoadedUrl: "",
    navigation: emptyPreviewState(),
  });

  useEffect(() => {
    setOwnedPreview({
      contextId: previewContextId,
      url: "",
      lastLoadedUrl: "",
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
        lastLoadedUrl: state.ready
          ? loadedPreviewUrl(state.url, state.url)
          : "",
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
    async (): Promise<ChatAttachment[]> => {
      try {
        return await window.inertia.selectAttachments();
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
        return await window.inertia.importAttachments(
          await prepareComposerAttachmentImports(files),
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

  const navigatePreview = useCallback((url: string) => {
    const contextId = previewContextId;
    if (!contextId) return;
    setOwnedPreview((current) => ({
      contextId,
      url,
      lastLoadedUrl: "",
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
          lastLoadedUrl: loadedPreviewUrl(url, state.url),
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
            : "The preview could not be opened.",
        );
        setOwnedPreview((current) => ({
          ...current,
          navigation: {
            ...current.navigation,
            loading: false,
          },
        }));
      });
  }, [previewContextId, previewOwnerId, setActionError]);

  const previewCommand = useCallback((
    action: "back" | "forward" | "reload",
  ) => {
    const contextId = previewContextId;
    if (!contextId) return;
    setOwnedPreview((current) => current.contextId === contextId
      ? {
          ...current,
          lastLoadedUrl: "",
          navigation: { ...current.navigation, loading: true },
        }
      : current);
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
        setOwnedPreview((current) => ({
          contextId,
          url: state.url,
          lastLoadedUrl: current.contextId === contextId
            ? current.lastLoadedUrl
            : "",
          navigation: state,
        }));
      })
      .catch((error) => {
        const authority = authorityRef.current;
        if (
          authority.previewOwnerId !== previewOwnerId
          || authority.previewContextId !== contextId
        ) return;
        setOwnedPreview((current) => current.contextId === contextId
          ? { ...current, lastLoadedUrl: "" }
          : current);
        setActionError(
          error instanceof Error
            ? error.message
            : "The preview command failed.",
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
        lastLoadedUrl: "",
        navigation: emptyPreviewState(),
      };

  return {
    previewUrl: visiblePreview.url,
    lastLoadedPreviewUrl: visiblePreview.lastLoadedUrl,
    previewNavigation: visiblePreview.navigation,
    chooseComposerAttachments,
    importComposerAttachments,
    releaseComposerAttachment,
    navigatePreview,
    previewCommand,
    setPreviewBounds,
  };
}

function emptyPreviewState(): PreviewState {
  return {
    url: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}
