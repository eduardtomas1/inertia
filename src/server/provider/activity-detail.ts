import { homedir } from "node:os";

import { boundedSubagentText } from "./subagent-trace";

/** Maximum persisted technical detail for one provider activity. */
export const MAX_PROVIDER_ACTIVITY_DETAIL_CHARS = 32 * 1024;
/** Maximum persisted technical detail across one authoritative turn. */
export const MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS = 256 * 1024;
/** Smaller envelope reserved for one terminal failure dossier. */
export const MAX_PROVIDER_FAILURE_DETAIL_CHARS = 16 * 1024;
/** Failure summaries stay useful in the transcript without becoming logs. */
export const MAX_PROVIDER_FAILURE_SUMMARY_CHARS = 480;

type JsonObject = Record<string, unknown>;

const ANSI_ESCAPE = [
  // OSC, including hyperlinks and window-title control strings.
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu,
  // CSI and the remaining common single-character escape sequences.
  /\u001B\[[0-?]*[ -/]*[@-~]/gu,
  /\u001B[@-_]/gu,
] as const;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function scrubPathPrefix(text: string, path: string | undefined, replacement: string): string {
  const normalized = path?.replace(/[\\/]+$/u, "");
  if (!normalized) return text;
  return text.replace(new RegExp(escaped(normalized), process.platform === "win32" ? "giu" : "gu"), replacement);
}

export function boundProviderActivityDetail(
  value: string,
  maxChars = MAX_PROVIDER_ACTIVITY_DETAIL_CHARS,
): string {
  const limit = Math.max(0, Math.trunc(maxChars));
  if (value.length <= limit) return value;
  if (limit === 0) return "";
  const marker = `\n… [${value.length - limit} or more characters omitted] …\n`;
  if (marker.length >= limit) return marker.slice(0, limit);
  const retained = limit - marker.length;
  const headLength = Math.ceil(retained * 0.65);
  return `${value.slice(0, headLength)}${marker}${value.slice(-(retained - headLength))}`;
}

/**
 * Scrubs provider-authored technical output before it crosses the persistence
 * boundary. This deliberately reuses the subagent secret scrubber because
 * both payloads can originate in tool output.
 */
export function sanitizeProviderActivityDetail(
  value: unknown,
  options: {
    workspaceRoot?: string;
    homeDirectory?: string;
    maxChars?: number;
  } = {},
): string | null {
  if (typeof value !== "string") return null;
  let text = value.replace(/\r\n?/gu, "\n");
  for (const pattern of ANSI_ESCAPE) text = text.replace(pattern, "");
  text = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .replace(/<system(?:[_ -]?prompt)?\b[^>]*>[\s\S]*?<\/system(?:[_ -]?prompt)?>/giu, "system_prompt=[redacted]")
    .replace(
      /(?:^|\n)[ \t]*(?:-{2,}[ \t]*)?(?:developer|generated|internal|system)[_ -]?prompt(?:[ \t]*-{2,})?[ \t]*[:=][ \t]*(?:"[\s\S]*?"|'[\s\S]*?'|[^\n]*)/giu,
      "\nsystem_prompt=[redacted]",
    )
    .replace(/\b(?:ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .replace(
      /\b(api[_ -]?key|authorization|cookie|credential|password|prompt|secret|system[_ -]?prompt|tokens?)\s*[:=]\s*(?:(?:Bearer|Basic)\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1=[redacted]",
    );
  text = boundedSubagentText(text, text.length) ?? "";
  text = scrubPathPrefix(text, options.workspaceRoot, "<workspace>");
  text = scrubPathPrefix(text, options.homeDirectory ?? homedir(), "<home>");
  text = text
    .replace(/\b[A-Za-z]:\\(?:Users|Temp)\\(?:[^\\\s]+\\)*[^\\\s]*/giu, "<path>")
    .replace(/\/(?:Users|home|private\/tmp|tmp)(?:\/[^\s,;:]+)+/gu, "<path>")
    .trim();
  if (!text) return null;
  return boundProviderActivityDetail(
    text,
    options.maxChars ?? MAX_PROVIDER_ACTIVITY_DETAIL_CHARS,
  );
}

/**
 * Produces the one-line, renderer-safe failure summary used by the terminal
 * event and persisted error activity. Provider output belongs in the bounded
 * technical detail, never in this always-visible field.
 */
export function sanitizeProviderFailureSummary(
  value: unknown,
  fallback: string,
  options: {
    workspaceRoot?: string;
    homeDirectory?: string;
  } = {},
): string {
  const sanitized = sanitizeProviderActivityDetail(value, {
    ...options,
    maxChars: MAX_PROVIDER_FAILURE_SUMMARY_CHARS * 2,
  });
  const summary = sanitized
    ?.split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .find(Boolean)
    ?.slice(0, MAX_PROVIDER_FAILURE_SUMMARY_CHARS);
  return summary || fallback;
}

const FAILURE_METADATA_LINE = /^(?:Reason|Phase|Exit code|Signal|Terminal event|Turn|Activity|Cleanup):/iu;

function failureMetadataValue(value: unknown): string {
  const sanitized = sanitizeProviderActivityDetail(value, { maxChars: 512 });
  return sanitized?.replace(/\s+/gu, " ").trim() || "not reported";
}

/**
 * Canonical persisted envelope for a failed provider run. Its header contains
 * only allowlisted lifecycle/process facts. Optional provider context has
 * already crossed the scrubber once, is scrubbed again here, and is mounted by
 * the renderer only after an explicit disclosure.
 */
export function providerFailureActivityDetail(input: {
  reason: string;
  phase?: string;
  exitCode: number | null;
  signal: string | null;
  terminalEvent?: string;
  activityId?: string;
  cleanupConfirmed: boolean;
  cause?: string;
  stack?: string;
  technicalDetail?: string;
  workspaceRoot?: string;
}): string {
  const cause = sanitizeProviderActivityDetail(input.cause, {
    workspaceRoot: input.workspaceRoot,
    maxChars: 2 * 1024,
  });
  const stack = sanitizeProviderActivityDetail(input.stack, {
    workspaceRoot: input.workspaceRoot,
    maxChars: 8 * 1024,
  });
  const context = sanitizeProviderActivityDetail(input.technicalDetail, {
    workspaceRoot: input.workspaceRoot,
    maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  })
    ?.split("\n")
    .filter((line) => !FAILURE_METADATA_LINE.test(line.trim()))
    .join("\n")
    .trim();
  const detail = [
    `Reason: ${failureMetadataValue(input.reason)}`,
    `Phase: ${failureMetadataValue(input.phase)}`,
    `Exit code: ${input.exitCode ?? "not reported"}`,
    `Signal: ${failureMetadataValue(input.signal)}`,
    `Terminal event: ${failureMetadataValue(input.terminalEvent)}`,
    `Activity: ${failureMetadataValue(input.activityId)}`,
    `Cleanup: ${input.cleanupConfirmed ? "confirmed" : "unconfirmed"}`,
    ...(cause ? [`Cause: ${cause}`] : []),
    ...(stack ? ["Stack:", stack] : []),
    ...(context ? ["", "Recent provider context:", context] : []),
  ].join("\n");
  return sanitizeProviderActivityDetail(detail, {
    workspaceRoot: input.workspaceRoot,
    maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  }) ?? "Reason: provider-error";
}

/**
 * Extracts text only from official tool-result shaped values. Callers must
 * still select the provider's documented input/output field before invoking
 * this helper; arbitrary provider objects are intentionally never stringified.
 */
export function officialToolResultText(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => officialToolResultText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
    return text || null;
  }
  const record = objectValue(value);
  if (!record) return null;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "text" || type === "output_text") {
    return typeof record.text === "string" ? record.text : null;
  }
  if (type === "tool_result") {
    return officialToolResultText(record.content)
      ?? officialToolResultText(record.output)
      ?? officialToolResultText(record.text);
  }
  return null;
}

export function providerActivityDetailSections(options: {
  command?: unknown;
  output?: unknown;
  error?: unknown;
}): string | null {
  const command = officialToolResultText(options.command);
  const output = officialToolResultText(options.output);
  const error = officialToolResultText(options.error);
  const sections = [
    command ? `Command:\n${command}` : null,
    output ? `Output:\n${output}` : null,
    error ? `Error:\n${error}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  return sections.length > 0 ? sections.join("\n\n") : null;
}

export function joinProviderActivityDetail(
  previous: string | null,
  next: string | null,
  maxChars = MAX_PROVIDER_ACTIVITY_DETAIL_CHARS,
): string | null {
  if (!previous) return next ? boundProviderActivityDetail(next, maxChars) : null;
  if (!next || previous === next || previous.endsWith(next)) {
    return boundProviderActivityDetail(previous, maxChars);
  }
  return boundProviderActivityDetail(`${previous}\n\n${next}`, maxChars);
}

export function mergeProviderActivityDetailWithinTurnBudget(
  previous: string | null,
  next: string | null,
  currentTurnChars: number,
): { detail: string | null; totalChars: number } {
  const baseChars = Math.max(0, currentTurnChars - (previous?.length ?? 0));
  const remaining = Math.max(
    0,
    MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS - baseChars,
  );
  const detail = joinProviderActivityDetail(
    previous,
    next,
    Math.min(MAX_PROVIDER_ACTIVITY_DETAIL_CHARS, remaining),
  ) || null;
  return {
    detail,
    totalChars: baseChars + (detail?.length ?? 0),
  };
}
