import {
  MAX_WATCHER_FINDING_BYTES,
  MAX_WATCHER_NOTE_CHARS,
} from "../../../shared/watcher";
import { truncateUtf8 } from "../untrusted-agent-text";

export type WatcherReplyClass = "silent" | "finding";

const SILENT_PATTERN = /^SILENT\.?$/u;
/** Longer replies cannot be a wrapped `SILENT`, so they skip the unwrap loop. */
const MAX_SILENT_CANDIDATE_CHARS = 64;
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ["**", "**"],
  ["__", "__"],
  ["`", "`"],
  ["\"", "\""],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
];
const SHORTENED_MARKER = "\n\n[Shortened by Inertia.]";
export const MAX_WATCHER_RESOLVED_CHECKS = 20;
const RESOLVED_LINE_PATTERN = /^resolved: check \d{1,9}(?:, check \d{1,9})*\.?$/iu;
const MAX_RESOLVED_LINE_CHARS = 400;

function unwrap(value: string): string {
  let current = value.trim();
  for (let pass = 0; pass < 8; pass += 1) {
    const wrapper = WRAPPERS.find(([open, close]) =>
      current.length >= open.length + close.length
      && current.startsWith(open)
      && current.endsWith(close));
    if (!wrapper) return current;
    current = current.slice(wrapper[0].length, current.length - wrapper[1].length).trim();
  }
  return current;
}

/**
 * Classifies a watcher's final reply. Only an exact `SILENT` (optionally with
 * one trailing period, after trimming and stripping surrounding bold,
 * backticks or quotes) is silent, and so is an empty reply on a completed
 * turn. Anything else is a finding. Callers map failed, cancelled and
 * usage-limited turns to their own outcomes before asking.
 */
export function classifyWatcherReply(text: string | null): WatcherReplyClass {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return "silent";
  if (trimmed.length > MAX_SILENT_CANDIDATE_CHARS) return "finding";
  return SILENT_PATTERN.test(unwrap(trimmed)) ? "silent" : "finding";
}

export function splitWatcherResolvedLine(text: string): { text: string; resolved: number[] } {
  const trimmed = text.trim();
  const lineStart = trimmed.lastIndexOf("\n") + 1;
  const line = unwrap(trimmed.slice(lineStart));
  if (line.length > MAX_RESOLVED_LINE_CHARS || !RESOLVED_LINE_PATTERN.test(line)) return { text: trimmed, resolved: [] };
  const checks = [...line.matchAll(/\d+/gu)].map(([digits]) => Number(digits));
  if (checks.length > MAX_WATCHER_RESOLVED_CHECKS || checks.some((check) => check < 1)) return { text: trimmed, resolved: [] };
  return { text: trimmed.slice(0, lineStart).trim(), resolved: [...new Set(checks)] };
}

function clipCodeUnits(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const last = value.charCodeAt(maximum - 1);
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? maximum - 1 : maximum);
}

/**
 * The stored preview of a finding: trimmed, at most `MAX_WATCHER_NOTE_CHARS`
 * characters and `MAX_WATCHER_FINDING_BYTES` UTF-8 bytes, never splitting a
 * surrogate pair or a multi-byte character. Shortened previews end with a
 * marker that stays inside both limits.
 */
export function findingPreview(text: string): string {
  const trimmed = text.replaceAll("\0", "�").trim();
  const fitsChars = trimmed.length <= MAX_WATCHER_NOTE_CHARS;
  const fitsBytes = !truncateUtf8(trimmed, MAX_WATCHER_FINDING_BYTES).truncated;
  if (fitsChars && fitsBytes) return trimmed;
  const chars = clipCodeUnits(trimmed, MAX_WATCHER_NOTE_CHARS - SHORTENED_MARKER.length);
  const bounded = truncateUtf8(chars, MAX_WATCHER_FINDING_BYTES - SHORTENED_MARKER.length).text;
  return `${bounded.trimEnd()}${SHORTENED_MARKER}`;
}
