/** Release metadata is untrusted presentation text, never HTML or navigation authority. */
export function appUpdateReleaseNotes(value: unknown, version: string): string | null {
  const notes = Array.isArray(value)
    ? value.slice(0, 32).find((item: unknown) => typeof item === "object" && item !== null
      && "version" in item && item.version === version)
    : typeof value === "string" ? value : null;
  const text = typeof notes === "string" ? notes
    : typeof notes === "object" && notes !== null && "note" in notes ? notes.note : null;
  if (typeof text !== "string") return null;
  // Bound processing and IPC size. The UI permits safe formatting, not raw HTML/URLs.
  const bounded = text.slice(0, 8_192).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "").trim();
  return bounded ? `${bounded}${text.length > 8_192 ? "\n…" : ""}` : null;
}

const CONDENSED_PARAGRAPH_LENGTH = 280;
const CONDENSED_ITEM_LENGTH = 220;
const CONDENSED_ITEMS = 3;
const BULLET = /^(?:[-*]|\d+[.)])\s+(.+)$/u;

function clipped(text: string, length: number): string {
  if (text.length <= length) return text;
  const cut = text.slice(0, length - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function condensedReleaseNote(text: string): { notes: string; omittedItems: number } {
  const lines = text.split("\n");
  const items = lines.flatMap((line) => BULLET.exec(line)?.[1]?.trim() ?? []).filter(Boolean);
  const first = text.split(/\n\s*\n/u)[0]?.trim() ?? "";
  if (first && !/^(?:#|[-*>`]|\d+[.)])/u.test(first)) {
    return { notes: clipped(first.split("\n").map((line) => line.trim()).join(" "), CONDENSED_PARAGRAPH_LENGTH), omittedItems: items.length };
  }
  if (items.length > 0) {
    const shown = items.slice(0, CONDENSED_ITEMS);
    return { notes: shown.map((item) => `- ${clipped(item, CONDENSED_ITEM_LENGTH)}`).join("\n"), omittedItems: items.length - shown.length };
  }
  const plain = lines.map((line) => line.replace(/^\s*(?:#{1,6}|>)\s*/u, "").trim()).filter(Boolean).join(" ");
  return { notes: clipped(plain, CONDENSED_PARAGRAPH_LENGTH), omittedItems: 0 };
}

export interface AppUpdateHistoryNotes {
  version: string;
  notes: string;
  omittedItems: number;
}

export function appUpdateReleaseHistory(value: unknown, options: {
  tagPrefix: string;
  prerelease: boolean;
  version: (text: string) => string | null;
  compare: (left: string, right: string) => number;
  installed: string;
  latest: string;
  limit: number;
}): { releases: AppUpdateHistoryNotes[]; omitted: number } {
  if (!Array.isArray(value)) return { releases: [], omitted: 0 };
  const found = new Map<string, string>();
  for (const item of value.slice(0, 100)) {
    if (typeof item !== "object" || item === null) continue;
    const release = item as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; body?: unknown };
    if (release.draft !== false || release.prerelease !== options.prerelease) continue;
    if (typeof release.tag_name !== "string" || !release.tag_name.startsWith(options.tagPrefix)) continue;
    const version = options.version(release.tag_name.slice(options.tagPrefix.length));
    if (!version || found.has(version)) continue;
    if (options.compare(version, options.installed) <= 0 || options.compare(version, options.latest) >= 0) continue;
    const notes = appUpdateReleaseNotes(release.body, version);
    if (notes) found.set(version, notes);
  }
  const releases = [...found].map(([version, notes]) => ({ version, ...condensedReleaseNote(notes) }))
    .sort((left, right) => options.compare(right.version, left.version));
  return { releases: releases.slice(0, options.limit), omitted: Math.max(0, releases.length - options.limit) };
}
