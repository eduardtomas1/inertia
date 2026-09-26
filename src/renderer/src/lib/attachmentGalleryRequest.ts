import type { ClientCommand, ServerEvent } from "@shared/contracts";
import type { AttachmentGalleryResult } from "@shared/attachment-gallery";
import { withRequestId } from "./runtimeCommands";

export function attachmentGalleryRequest(send: (command: ClientCommand) => Promise<ServerEvent>, conversationId: string) {
  return async (cursor?: string): Promise<AttachmentGalleryResult> => {
    const event = await send(withRequestId({ type: "conversation.attachments.list", payload: { conversationId, ...(cursor ? { cursor } : {}) } }));
    if (event.type === "request.result" && event.result.kind === "conversation.attachments" && event.result.conversationId === conversationId) return event.result;
    throw new Error(event.type === "request.error" ? event.message : "The chat attachments could not be loaded.");
  };
}
