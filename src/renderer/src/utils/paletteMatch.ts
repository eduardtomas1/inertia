import { createElement, Fragment, type ReactNode } from "react";
import { messageSearchPattern } from "@shared/message-search";

export interface PaletteMatchItem {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
}

export function paletteScore(label: string, detail: string | undefined, query: string, keywords = ""): number {
  const target = `${label} ${detail ?? ""} ${keywords}`.toLocaleLowerCase();
  if (!query) return 1;
  if (label.toLocaleLowerCase().startsWith(query)) return 4;
  if (target.split(/\s+/u).some((word) => word.startsWith(query))) return 3;
  return target.includes(query) ? 2 : 0;
}

export function rankPaletteItems<T extends PaletteMatchItem>(
  items: readonly T[],
  query: string,
  limit?: number,
  wordMatches?: ReadonlySet<string>,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return items
    .map((item) => ({ item, rank: paletteScore(item.label, item.detail, needle, item.keywords) || (wordMatches?.has(item.id) ? 1 : 0) }))
    .filter(({ rank }) => rank > 0)
    .sort((left, right) => right.rank - left.rank)
    .slice(0, limit)
    .map(({ item }) => item);
}

export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  if (!query.trim()) return text;
  const pattern = new RegExp(messageSearchPattern(query.trim()), "giu");
  let offset = 0;
  const parts: ReactNode[] = [];
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(offset, match.index), createElement("mark", { key: match.index }, match[0]));
    offset = match.index + match[0].length;
  }
  return createElement(Fragment, null, ...parts, text.slice(offset));
}
