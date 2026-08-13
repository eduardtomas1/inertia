export const ATTACHMENT_RESOLUTION_PUBLIC_ERROR =
  "The selected attachment is no longer available or could not be verified.";

export class AttachmentResolutionError extends Error {
  constructor() {
    super(ATTACHMENT_RESOLUTION_PUBLIC_ERROR);
    this.name = "AttachmentResolutionError";
  }
}
