import { useCallback, useState } from "react";
import type { ChatAttachment } from "@shared/contracts";
import type { PreviewBounds, PreviewState } from "@shared/desktop";

interface DesktopToolsOptions {
  setActionError: (message: string | null) => void;
}

export function useDesktopTools({
  setActionError,
}: DesktopToolsOptions) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewNavigation, setPreviewNavigation] = useState<PreviewState>({
    url: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });

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
        return await window.inertia.importAttachments(await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            mimeType: file.type,
            data: await file.arrayBuffer(),
          })),
        ));
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
    setPreviewUrl(url);
    setPreviewNavigation((current) => ({ ...current, url, loading: true }));
    void window.inertia.previewNavigate(url)
      .then(setPreviewNavigation)
      .catch((error) => {
        setActionError(
          error instanceof Error
            ? error.message
            : "The preview could not be opened.",
        );
        setPreviewNavigation((current) => ({
          ...current,
          loading: false,
        }));
      });
  }, [setActionError]);

  const previewCommand = useCallback((
    action: "back" | "forward" | "reload",
  ) => {
    void window.inertia.previewCommand(action)
      .then((state) => {
        setPreviewNavigation(state);
        if (state.url) setPreviewUrl(state.url);
      })
      .catch((error) => {
        setActionError(
          error instanceof Error
            ? error.message
            : "The preview command failed.",
        );
      });
  }, [setActionError]);

  const setPreviewBounds = useCallback((bounds: PreviewBounds | null) => {
    void window.inertia.previewSetBounds(bounds).catch(() => undefined);
  }, []);

  return {
    previewUrl,
    previewNavigation,
    chooseComposerAttachments,
    importComposerAttachments,
    releaseComposerAttachment,
    navigatePreview,
    previewCommand,
    setPreviewBounds,
  };
}
