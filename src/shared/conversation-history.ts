import { z } from "zod";

export const conversationHistoryCursorSchema = z.strictObject({
  at: z.string().datetime(),
  id: z.string().min(1).max(200),
  kind: z.enum(["turn", "message"]),
});
export type ConversationHistoryCursor = z.infer<typeof conversationHistoryCursorSchema>;

export const conversationHistoryRequestSchema = z.strictObject({
  before: conversationHistoryCursorSchema.optional(),
  messageId: z.string().min(1).max(200).optional(),
  turnId: z.string().min(1).max(200).optional(),
}).refine((value) => Number(Boolean(value.before)) + Number(Boolean(value.messageId))
  + Number(Boolean(value.turnId)) <= 1, "Choose one history destination.");
export type ConversationHistoryRequest = z.infer<typeof conversationHistoryRequestSchema>;

export interface ConversationHistoryPage {
  older: ConversationHistoryCursor | null;
}

// Leave ample room for other frames already queued on the shared connection.
export const MAX_CONVERSATION_HISTORY_BYTES = 32 * 1024 * 1024;
export const CONVERSATION_HISTORY_PAGE_SIZE = 40;
