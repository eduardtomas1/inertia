import type { AgentActivity, AgentTurnStatus } from "../../../shared/contracts";
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
export function classifyWatcherReply(
  text: string | null,
  turnStatus: AgentTurnStatus,
): WatcherReplyClass {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return turnStatus === "completed" ? "silent" : "finding";
  if (trimmed.length > MAX_SILENT_CANDIDATE_CHARS) return "finding";
  return SILENT_PATTERN.test(unwrap(trimmed)) ? "silent" : "finding";
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

/**
 * Settled command activities of one watcher turn, for the receipt's
 * "ran N read-only commands" line.
 */
export function watcherCommandsRun(activities: readonly AgentActivity[], turnId: string): number {
  return activities.filter((activity) =>
    activity.turnId === turnId && activity.kind === "command" && activity.status !== "running").length;
}
