import type { SettingsSection } from "../../lib/settingsTarget";
import type { SettingsRowMetadata, SettingsSectionRows } from "../settingsRows";

export type SettingsMatchRange = readonly [start: number, end: number];

export interface SettingsSearchResult {
  row: SettingsRowMetadata;
  score: number;
  ranges: readonly SettingsMatchRange[];
}

export interface SettingsSearchGroup {
  sectionId: SettingsSection;
  label: string;
  results: readonly SettingsSearchResult[];
}

const TITLE_WEIGHT = 8;
const KEYWORD_WEIGHT = 4;
const GROUP_WEIGHT = 2;
const SECTION_WEIGHT = 1;
const WORD = /[\p{L}\p{N}]+/gu;

export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function words(value: string): string[] {
  return normalizeSearchText(value).match(WORD) ?? [];
}

function prefixes(fieldWords: readonly string[], token: string): boolean {
  return fieldWords.some((word) => word.startsWith(token));
}

export function settingsQueryTokens(query: string): string[] {
  return [...new Set(words(query))];
}

function titleRanges(title: string, tokens: readonly string[]): SettingsMatchRange[] {
  const ranges: SettingsMatchRange[] = [];
  for (const match of title.matchAll(WORD)) {
    const word = normalizeSearchText(match[0]);
    const length = Math.max(0, ...tokens.filter((token) => word.startsWith(token)).map((token) => token.length));
    if (length === 0) continue;
    let consumed = 0;
    let end = 0;
    for (const character of match[0]) {
      if (consumed >= length) break;
      consumed += normalizeSearchText(character).length;
      end += character.length;
    }
    ranges.push([match.index, match.index + end]);
  }
  return ranges;
}

function scoreRow(row: SettingsRowMetadata, sectionLabel: string, tokens: readonly string[]): number {
  const title = words(row.title);
  const keywords = row.keywords.flatMap(words);
  const group = words(row.group);
  const section = words(sectionLabel);
  let score = 0;
  for (const token of tokens) {
    const weight = prefixes(title, token) ? TITLE_WEIGHT
      : prefixes(keywords, token) ? KEYWORD_WEIGHT
        : prefixes(group, token) ? GROUP_WEIGHT
          : prefixes(section, token) ? SECTION_WEIGHT : 0;
    if (weight === 0) return 0;
    score += weight;
  }
  return normalizeSearchText(row.title).startsWith(tokens.join(" ")) ? score + 1 : score;
}

export function searchSettings(query: string, sections: readonly SettingsSectionRows[]): SettingsSearchGroup[] {
  const tokens = settingsQueryTokens(query);
  if (tokens.length === 0) return [];
  return sections
    .map((section, order) => {
      const results = section.rows
        .map((row, index) => ({ row, index, score: scoreRow(row, section.label, tokens) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map(({ row, score }) => ({ row, score, ranges: titleRanges(row.title, tokens) }));
      return { order, group: { sectionId: section.id, label: section.label, results } };
    })
    .filter(({ group }) => group.results.length > 0)
    .sort((left, right) => right.group.results[0]!.score - left.group.results[0]!.score || left.order - right.order)
    .map(({ group }) => group);
}
