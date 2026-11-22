import { MAX_PROVIDER_STOP_REASON_CHARS } from "../../shared/orchestration-v2";
import { launchCredentialValues, sanitizeProviderUserText, stripInvisibleCharacters } from "../provider/activity-detail";
import { redactCodexErrorHeaders } from "./managed-errors";
import { objectValue, type JsonObject } from "./protocol";
import type { CodexAppServerOptions } from "./types";

/** Codex `HookSource` values (T3 decodes `run.source` as exactly one of these). */
const CODEX_HOOK_SOURCES = new Set([
  "system", "user", "project", "mdm", "sessionFlags", "plugin", "cloudRequirements", "cloudManagedConfig",
  "legacyManagedConfigFile", "legacyManagedConfigMdm", "unknown",
]);
/** Codex `HookOutputEntryKind` values (T3 decodes each `entries[].kind` as exactly one of these). */
const CODEX_HOOK_ENTRY_KINDS = new Set(["warning", "stop", "feedback", "context", "error"]);
/**
 * Raw input bounds, applied before any sanitising. None cuts, so no credential is split before it is redacted: a
 * stop entry over its bound is refused whole, and joining stops at the first later stop entry that would take the
 * joined text over its bound, so no gap is left. Only the redacted text is cut.
 */
const MAX_CODEX_HOOK_ENTRIES = 1_000;
const MAX_RAW_HOOK_STOP_ENTRY_CHARS = 256 * 1024;
const MAX_RAW_HOOK_STOP_TEXT_CHARS = 64 * 1024;
const MAX_RAW_HOOK_EVENT_NAME_CHARS = 1_000;
const MAX_HOOK_EVENT_NAME_CHARS = 120;

export interface CodexHookStop {
  eventName: string;
  source: string | undefined;
  /** The trimmed text of the run's `stop` entries, joined by line breaks; raw and unredacted. */
  text: string;
}

/**
 * Cuts `value` to at most `maxChars` UTF-16 code units without leaving half of a surrogate pair at the end.
 * A local helper until a shared surrogate-safe cut exists.
 */
export function cutAtCodePointBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const end = maxChars > 0 && /[\uD800-\uDBFF]/u.test(value[maxChars - 1]!) ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" ? value.replaceAll("\0", "").trim() : undefined;
}

/**
 * The stop a Codex hook reported (T3 `hook/completed`, `CodexAdapterV2.ts:5182-5196`): a run whose status is
 * `stopped`, with the trimmed, non-empty text of its `stop` entries. Like T3's decoder, a malformed run rejects the
 * whole notification: a `source` that is not a `HookSource`, an entry whose kind is not a `HookOutputEntryKind` or
 * whose text is not a string, or an event name that is not a string. Undefined for any other run, or one without
 * stop text. Raw input is never cut; see the raw bounds above.
 */
export function codexHookStop(params: JsonObject): CodexHookStop | undefined {
  const run = objectValue(params.run);
  if (run?.status !== "stopped" || !Array.isArray(run.entries) || run.entries.length > MAX_CODEX_HOOK_ENTRIES) {
    return undefined;
  }
  if (typeof run.eventName !== "string" || run.eventName.length > MAX_RAW_HOOK_EVENT_NAME_CHARS) return undefined;
  if (run.source !== undefined && (typeof run.source !== "string" || !CODEX_HOOK_SOURCES.has(run.source))) {
    return undefined;
  }
  const stops: string[] = [];
  let length = 0;
  let full = false;
  for (const value of run.entries) {
    const entry = objectValue(value);
    if (typeof entry?.kind !== "string" || !CODEX_HOOK_ENTRY_KINDS.has(entry.kind) || typeof entry.text !== "string") {
      return undefined;
    }
    if (full || entry.kind !== "stop") continue;
    // An oversized entry is refused whole; after kept text it also ends the join, so no gap is left.
    if (entry.text.length > MAX_RAW_HOOK_STOP_ENTRY_CHARS) {
      full = stops.length > 0;
      continue;
    }
    const text = trimmed(entry.text);
    if (!text) continue;
    // Later entries are still decoded (a malformed one rejects the notification), but none is joined after a gap.
    if (stops.length > 0 && length + text.length + 1 > MAX_RAW_HOOK_STOP_TEXT_CHARS) {
      full = true;
      continue;
    }
    stops.push(text);
    length += text.length + 1;
  }
  const eventName = trimmed(run.eventName);
  if (!eventName || stops.length === 0) return undefined;
  return { eventName, source: run.source, text: stops.join("\n") };
}

/**
 * The provider stop reason of one Codex run (T3 `hookStopReason`). A hook stop is kept for the exact active turn
 * it names, the latest one winning, until that turn completes. The run's reason is the one of the native turn that
 * ends it: each completed native turn replaces it, so a later turn without a hook stop clears it.
 */
export class CodexHookStopTracker {
  private pending: { turnId: string; stop: CodexHookStop } | undefined;
  /** Redacted and bounded; set only while the latest completed native turn was stopped by a hook. */
  reason: string | undefined;

  constructor(private readonly options: Pick<CodexAppServerOptions, "environment" | "cwd">) {}

  /** A `hook/completed` notification already matched to the run's provider thread. */
  observe(params: JsonObject, turnId: string | undefined, activeTurnId: string | undefined): void {
    if (!turnId || turnId !== activeTurnId) return;
    const stop = guarded(() => codexHookStop(params));
    if (stop) this.pending = { turnId, stop };
  }

  /**
   * Settles the native turn `turnId`. `providerEnded` is true when Codex itself ended it completed or interrupted
   * (not failed, and not a Stop the user asked for); only then does its hook stop become the run's reason.
   */
  settle(turnId: string, providerEnded: boolean): string | undefined {
    const stop = providerEnded && this.pending?.turnId === turnId ? this.pending.stop : undefined;
    this.pending = undefined;
    // Called from the turn/completed handler: a failure records no reason instead of reaching the protocol reader.
    this.reason = stop === undefined ? undefined : guarded(() => this.format(stop));
    return this.reason;
  }

  /** The run result's fields: no reason when the run failed, or when a Stop the user asked for ended it. */
  resultFields(finalStatus: "completed" | "failed" | "cancelled", userStopped: boolean): { providerStopReason?: string } {
    return this.reason === undefined || finalStatus === "failed" || (finalStatus === "cancelled" && userStopped)
      ? {} : { providerStopReason: this.reason };
  }

  private format(stop: CodexHookStop): string | undefined {
    // Hook stop messages are written by the user and kept as written, as T3 keeps them. Only Inertia's launch
    // credentials, Codex error header maps and local paths are removed, over the whole bounded raw text, before
    // anything is cut; every step is linear.
    const credentials = launchCredentialValues(this.options.environment);
    // Invisible characters go first, so an escape inside `headers` cannot hide a header map from its redaction.
    const clean = (value: string) => sanitizeProviderUserText(redactCodexErrorHeaders(stripInvisibleCharacters(value)),
      credentials, { workspaceRoot: this.options.cwd }).trim();
    const eventName = cutAtCodePointBoundary(clean(stop.eventName), MAX_HOOK_EVENT_NAME_CHARS);
    const text = clean(stop.text);
    if (!eventName || !text) return undefined;
    const source = stop.source === undefined ? "" : ` (${stop.source})`;
    return cutAtCodePointBoundary(`${eventName} hook${source}: ${text}`, MAX_PROVIDER_STOP_REASON_CHARS);
  }
}

/** Runs a hook stop step; a failure is logged without its message (it may quote provider text) and yields none. */
function guarded<T>(step: () => T | undefined): T | undefined {
  try {
    return step();
  } catch (error) {
    console.warn("A Codex hook stop reason could not be recorded.", error instanceof Error ? error.name : "unknown error");
    return undefined;
  }
}
