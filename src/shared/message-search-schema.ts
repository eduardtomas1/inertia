import { z } from "zod";
import { MESSAGE_SEARCH_LIMIT, MESSAGE_SEARCH_QUERY_MAX, MESSAGE_SEARCH_SNIPPET_MAX } from "./message-search";

export const messageSearchQuerySchema = z.string().trim().min(2)
  .max(MESSAGE_SEARCH_QUERY_MAX).refine((query) => !query.includes("\0"));

export const messageSearchTargetSchema = z.strictObject({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid(),
  turnId: z.string().min(1).max(200).nullable(),
  messageId: z.string().min(1).max(200),
});
export type MessageSearchTarget = z.infer<typeof messageSearchTargetSchema>;

export const messageSearchHitSchema = messageSearchTargetSchema.extend({
  role: z.enum(["user", "assistant"]),
  createdAt: z.string().datetime({ offset: true }),
  snippet: z.string().max(MESSAGE_SEARCH_SNIPPET_MAX),
  matchStart: z.number().int().min(0).max(MESSAGE_SEARCH_SNIPPET_MAX),
  matchEnd: z.number().int().min(1).max(MESSAGE_SEARCH_SNIPPET_MAX),
}).refine((hit) => hit.matchStart < hit.matchEnd && hit.matchEnd <= hit.snippet.length);
export type MessageSearchHit = z.infer<typeof messageSearchHitSchema>;

export const messageSearchResultSchema = z.strictObject({
  kind: z.literal("conversation.messages.search"),
  query: messageSearchQuerySchema,
  hits: z.array(messageSearchHitSchema).max(MESSAGE_SEARCH_LIMIT),
  hasMore: z.boolean(),
  incomplete: z.boolean(),
}).refine((result) => new Set(result.hits.map((hit) => hit.messageId)).size === result.hits.length);
export type MessageSearchResult = z.infer<typeof messageSearchResultSchema>;
