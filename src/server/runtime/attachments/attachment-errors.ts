export const ATTACHMENT_RESOLUTION_PUBLIC_ERROR =
  "The selected attachment is no longer available or could not be verified.";

// Only deliberately authored document guidance may cross the runtime boundary.
// Filesystem, decoder and native library exceptions remain private.
export class DocumentAttachmentError extends Error {}

export class AttachmentResolutionError extends Error {
  constructor() {
    super(ATTACHMENT_RESOLUTION_PUBLIC_ERROR);
    this.name = "AttachmentResolutionError";
  }
}
