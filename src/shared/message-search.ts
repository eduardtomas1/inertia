export const MESSAGE_SEARCH_LIMIT = 20;
export const MESSAGE_SEARCH_QUERY_MAX = 200;
export const MESSAGE_SEARCH_SNIPPET_MAX = 240;

export type MessageSearchTarget = {
  projectId: string; conversationId: string; turnId: string | null; messageId: string;
};
export type MessageSearchHit = MessageSearchTarget & {
  role: "user" | "assistant"; createdAt: string; snippet: string; matchStart: number; matchEnd: number;
};
export type MessageSearchResult = {
  kind: "conversation.messages.search"; query: string; hits: MessageSearchHit[]; hasMore: boolean; incomplete: boolean;
};

/** Literal Unicode-aware matching; punctuation never becomes query syntax. */
export function messageSearchPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
}

export function messageSearchExcerpt(
  content: string,
  pattern: RegExp,
): Pick<MessageSearchHit, "snippet" | "matchStart" | "matchEnd"> | null {
  // Keep previews readable without rendering untrusted Markdown. If a query
  // explicitly matches markup, a URL, or exact whitespace, preserve that source.
  const plain = content
    .replace(/^ {0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+\.\s+)/gmu, "")
    .replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gmu, "")
    .replace(/!?\[([^\n[\]]+)\]\([^()\n]*\)/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
    .replace(/__([^_\n]+)__/gu, "$1")
    .replace(/\s+/gu, " ").trim();
  const plainMatch = pattern.exec(plain);
  const match = plainMatch ?? pattern.exec(content);
  if (!match) return null;
  if (plainMatch) content = plain;
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
