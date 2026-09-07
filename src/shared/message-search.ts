import { z } from "zod";

export const MESSAGE_SEARCH_LIMIT = 20;
export const MESSAGE_SEARCH_QUERY_MAX = 200;
export const MESSAGE_SEARCH_SNIPPET_MAX = 240;

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

/** Literal Unicode-aware matching; punctuation never becomes query syntax. */
export function messageSearchPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
}

export function messageSearchExcerpt(
  content: string,
  pattern: RegExp,
): Pick<MessageSearchHit, "snippet" | "matchStart" | "matchEnd"> | null {
  const match = pattern.exec(content);
  if (!match) return null;
  let start = Math.max(0, match.index - 35);
  // Preserve UTF-16 pairs at snippet boundaries. Match offsets stay in the
  // original text rather than a lowercased string with possibly different length.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(content[start])) start -= 1;
  const prefix = start > 0 ? "…" : "";
  let end = Math.min(content.length, start + MESSAGE_SEARCH_SNIPPET_MAX - prefix.length - 1);
  if (end < content.length && /[\uDC00-\uDFFF]/u.test(content[end])) end -= 1;
  const snippet = prefix + content.slice(start, end) + (end < content.length ? "…" : "");
  return {
    snippet,
    matchStart: prefix.length + match.index - start,
    matchEnd: prefix.length + match.index - start + match[0].length,
  };
}
