import { z } from "zod";

import { MAX_ATTACHMENT_COUNT } from "./attachments.js";

const attachmentHandoffSchema = z.object({
  requestId: z.string().uuid(),
  attachmentIds: z.array(z.string().uuid()).min(1).max(MAX_ATTACHMENT_COUNT),
}).strict();

export interface AttachmentHandoffRequest {
  requestId: string;
  attachmentIds: string[];
}

export function parseAttachmentHandoffRequest(
  value: unknown,
): AttachmentHandoffRequest | null {
  const parsed = attachmentHandoffSchema.safeParse(value);
  if (!parsed.success) return null;
  if (new Set(parsed.data.attachmentIds).size !== parsed.data.attachmentIds.length) {
    return null;
  }
  return parsed.data;
}
