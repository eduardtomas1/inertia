import { z } from "zod";

import type { Conversation } from "./contracts/app";

export const ARCHIVED_CONVERSATIONS_PAGE_SIZE = 20;
export const MAX_ARCHIVED_CONVERSATIONS_QUERY_CHARS = 200;

const providerIdSchema = z.enum(["codex", "claude", "cursor", "kimi", "opencode", "antigravity", "grok"]);

export const archivedConversationsCursorSchema = z.strictObject({
  archivedAt: z.string().min(1).max(64),
  id: z.uuid(),
});

export const archivedConversationsRequestSchema = z.strictObject({
  query: z.string().max(MAX_ARCHIVED_CONVERSATIONS_QUERY_CHARS).optional(),
  providerIds: z.array(providerIdSchema).max(providerIdSchema.options.length).optional(),
  after: archivedConversationsCursorSchema.nullable().optional(),
  limit: z.number().int().min(1).max(ARCHIVED_CONVERSATIONS_PAGE_SIZE).optional(),
});

export type ArchivedConversationsCursor = z.infer<typeof archivedConversationsCursorSchema>;
export type ArchivedConversationsRequest = z.infer<typeof archivedConversationsRequestSchema>;

export interface ArchivedConversationsPage {
  kind: "conversation.archived";
  conversations: Conversation[];
  total: number;
  next: ArchivedConversationsCursor | null;
}
