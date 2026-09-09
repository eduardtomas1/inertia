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
  const match = pattern.exec(content);
  if (!match) return null;
  let start = Math.max(0, match.index - 35);
  // Preserve UTF-16 pairs at source-window boundaries, including full matches.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(content[start])) start -= 1;
  const prefix = start > 0 ? "…" : "";
  let end = Math.min(content.length, start + MESSAGE_SEARCH_SNIPPET_MAX - prefix.length - 1);
  if (end < content.length && /[\uDC00-\uDFFF]/u.test(content[end])) end -= 1;
  const source = content.slice(start, end);
  const sourceIndex = match.index - start;
  // Anchor the verified occurrence while formatting only this bounded window.
  // The long inner run cannot exist in the source; distinct delimiters prevent
  // original controls at either boundary from overlapping the inserted marker.
  const marker = "\0" + "\u0001".repeat(source.length + 1) + "\0";
  const anchored = source.slice(0, sourceIndex) + marker + source.slice(sourceIndex + match[0].length);
  const plain = anchored
    .replace(/^ {0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+\.\s+)/gmu, "")
    .replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gmu, "")
    .replace(/!?\[([^\n[\]]+)\]\([^()\n]*\)/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
    .replace(/__([^_\n]+)__/gu, "$1")
    .replace(/\s+/gu, " ").trim();
  const plainIndex = plain.indexOf(marker);
  // Explicit searches for stripped source (for example a link URL) stay raw.
  const preview = plainIndex < 0 ? source
    : plain.slice(0, plainIndex) + match[0] + plain.slice(plainIndex + marker.length);
  const matchStart = prefix.length + (plainIndex < 0 ? sourceIndex : plainIndex);
  return {
    snippet: prefix + preview + (end < content.length ? "…" : ""),
    matchStart,
    matchEnd: matchStart + match[0].length,
  };
}
