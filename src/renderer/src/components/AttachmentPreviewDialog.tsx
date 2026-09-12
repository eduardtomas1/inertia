import { lazy, Suspense } from "react";

import type { AttachmentPreviewSource } from "../utils/composerAttachments";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";

const DeferredAttachmentPreviewDialog = lazy(async () => ({
  default: (await import("./DocumentAttachmentPreview"))
    .AttachmentPreviewDialog,
}));

type AttachmentPreviewDialogProps = {
  attachment: AttachmentPreviewSource;
  onClose: () => void;
};

export function AttachmentPreviewDialog(
  props: AttachmentPreviewDialogProps,
): React.JSX.Element {
  // Reserve the trusted overlay before the deferred document viewer arrives.
  useNativePreviewSuspension(true);
  return (
    <Suspense fallback={null}>
      <DeferredAttachmentPreviewDialog {...props} />
    </Suspense>
  );
}
