import type { ChatAttachmentMimeType } from "./attachments";

/**
 * Privileged attachment capability materialized by Electron main for the
 * supervised runtime. Renderer commands can reference the opaque id, but
 * cannot author any field in this descriptor.
 */
export interface TrustedRuntimeAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: ChatAttachmentMimeType;
  size: number;
  digest: string;
}
