import { lazy, Suspense } from "react";

import type { ChatAttachment } from "@shared/contracts";

const DeferredAttachmentPreviewDialog = lazy(async () => ({
  default: (await import("./DocumentAttachmentPreview"))
    .AttachmentPreviewDialog,
}));

type AttachmentPreviewDialogProps = {
  attachment: ChatAttachment;
  onClose: () => void;
};

export function AttachmentPreviewDialog(
  props: AttachmentPreviewDialogProps,
): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <DeferredAttachmentPreviewDialog {...props} />
    </Suspense>
  );
}
