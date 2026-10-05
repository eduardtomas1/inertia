import type { AppShortcutAction } from "@shared/keybindings";

import { HELP_TOPICS, type HelpEntry, type HelpTopic } from "./helpTopics";

export const HELP_SEARCH_LIMIT = 30;

export interface HelpSearchHit {
  topic: HelpTopic;
  entry: HelpEntry;
}

export interface HelpSearchResult {
  words: readonly string[];
  hits: readonly HelpSearchHit[];
  total: number;
}

export interface HelpSearchGroup {
  topic: HelpTopic;
  hits: HelpSearchHit[];
}

export interface HelpTextPart {
  text: string;
  match: boolean;
}

interface IndexedHelpEntry extends HelpSearchHit {
  name: readonly string[];
  action: readonly string[];
  title: readonly string[];
  detail: readonly string[];
}

function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

export function helpSearchWords(text: string): string[] {
  return fold(text.replaceAll("⌘", " cmd command "))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

export function indexHelpTopics(topics: readonly HelpTopic[]): readonly IndexedHelpEntry[] {
  return topics.flatMap((topic) => {
    const title = helpSearchWords(topic.title);
    return topic.entries.map((entry) => ({
      topic,
      entry,
      name: helpSearchWords(entry.name),
      action: entry.shortcut ? helpSearchWords(entry.shortcut) : [],
      title,
      detail: helpSearchWords(entry.detail),
    }));
  });
}

export const HELP_INDEX = indexHelpTopics(HELP_TOPICS);

function startsAny(words: readonly string[], prefix: string): boolean {
  return words.some((word) => word.startsWith(prefix));
}

export function searchHelp(
  query: string,
  shortcutLabel: (action: AppShortcutAction) => string,
  index: readonly IndexedHelpEntry[] = HELP_INDEX,
  limit = HELP_SEARCH_LIMIT,
): HelpSearchResult {
  const words = [...new Set(helpSearchWords(query))];
  if (words.length === 0) return { words, hits: [], total: 0 };
  const ranked = index.flatMap((item, order) => {
    const shortcut = item.entry.shortcut
      ? [...item.action, ...helpSearchWords(shortcutLabel(item.entry.shortcut))]
      : [];
    const fields = [item.name, shortcut, item.title, item.detail];
    let rank = 0;
    for (const word of words) {
      const field = fields.findIndex((tokens) => startsAny(tokens, word));
      if (field < 0) return [];
      rank += field;
    }
    return [{ hit: { topic: item.topic, entry: item.entry }, order, rank }];
  });
  ranked.sort((left, right) => left.rank - right.rank || left.order - right.order);
  return { words, hits: ranked.slice(0, limit).map(({ hit }) => hit), total: ranked.length };
}

export function groupHelpHits(hits: readonly HelpSearchHit[]): HelpSearchGroup[] {
  const groups = new Map<HelpTopic, HelpSearchGroup>();
  for (const hit of hits) {
    const group = groups.get(hit.topic);
    if (group) group.hits.push(hit);
    else groups.set(hit.topic, { topic: hit.topic, hits: [hit] });
  }
  return [...groups.values()];
}

export function highlightHelpText(text: string, words: readonly string[]): HelpTextPart[] {
  const parts: HelpTextPart[] = [];
  const push = (value: string, match: boolean): void => {
    if (value.length === 0) return;
    const last = parts.at(-1);
    if (last && last.match === match && !match) last.text += value;
    else parts.push({ text: value, match });
  };
  let offset = 0;
  for (const found of text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const word = fold(found[0]);
    if (!words.some((prefix) => word.startsWith(prefix))) continue;
    push(text.slice(offset, found.index), false);
    push(found[0], true);
    offset = found.index + found[0].length;
  }
  push(text.slice(offset), false);
  return parts;
}
