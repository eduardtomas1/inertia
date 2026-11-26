import { homedir } from "node:os";

import { scrubCommandSecrets } from "./command-secrets";
import { scrubSubagentSecrets } from "./subagent-trace";

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

const DEFAULT_HOME_DIRECTORY = homedir();
const MAX_PATH_REGEX_CACHE = 32;
const windowsPathRegexCache = new Map<string, RegExp>();

const SYSTEM_PROMPT_TAG = /<system(?:[_ -]?prompt)?\b[^>]*>[\s\S]*?<\/system(?:[_ -]?prompt)?>/giu;
const LABELED_PROMPT_LINE =
  /(?:^|\n)[ \t]*(?:-{2,}[ \t]*)?(?:developer|generated|internal|system)[_ -]?prompt(?:[ \t]*-{2,})?[ \t]*[:=][ \t]*(?:"[\s\S]*?"|'[\s\S]*?'|[^\n]*)/giu;
const QUERY_SECRET_PARAM =
  /((?:[?&#;]|%(?:3F|26|23|3B))(?:[A-Za-z0-9_.~-]|%[0-9A-F]{2}){0,64}?(?:key|token|secret|password|passwd|signature|sig|credentials?|auth|jwt|session(?:[_-]?id)?|(?<=[?&#;_.~-]|%[0-9A-F]{2})code)(?:=|%3D))(?:(?!%2[36])[^&#\s'"<>])+/giu;
const PLATFORM_TOKEN = /\b(?:ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const SK_TOKEN = /\bsk-[A-Za-z0-9_-]{20,}/gu;
const KEY_VALUE_SECRET =
  /\b(api[_ -]?key|authorization|cookie|credential|password|prompt|secret|system[_ -]?prompt|tokens?)\s*[:=]\s*(?:(?:Bearer|Basic)\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const ENV_ASSIGNMENT_SECRET =
  /\b((?:[A-Z0-9]+_)*(?:[A-Z0-9]*PASSWORD|PASS|PASSWD|SECRET|TOKEN|CREDENTIALS?|(?:API|ACCESS|PRIVATE|SECRET)_KEY)(?:_[A-Z0-9]+)*)=(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gu;
const USER_PASS_FLAG = /(^|\s)(-u|--user)(\s+|=)([^\s:]+):(?!\[redacted\])(\S+)/gmu;
const CLI_SECRET_FLAG = /(^|\s)--(password|token)\s+(?:"[^"\n]*"|'[^'\n]*'|\S+)/gmu;
const MYSQL_PASSWORD_FLAG = /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]*?\s)-p(?=[^\s-])\S+/gu;
const CLI_TOOL_PASSWORD_FLAG =
  /(\b(?:docker\s+login|sshpass)\b[^\n]*?\s-p|\bredis-cli\b[^\n]*?\s-a)(?:\s+|=)?(?=[^\s-])\S+/gu;
const AWS_CONFIGURE_SECRET =
  /(\baws\s+configure\s+set\s+(?:\S+\.)?(?:aws_secret_access_key|aws_session_token)\s+)\S+/giu;
const NPM_AUTH_CONFIG = /(\bnpm\s+config\s+set\s+\S*_auth(?:Token)?)(\s+|=)\S+/gu;
const QUOTED_WINDOWS_USER_PATH = /(["'])[A-Za-z]:\\(?:Users|Temp)\\(?:(?!\1)[^\n])*\1/giu;
const QUOTED_POSIX_USER_PATH = /(["'])\/(?:Users|home|private\/tmp|tmp)\/(?:(?!\1)[^\n])*\1/gu;
const WINDOWS_USER_PATH = /\b[A-Za-z]:\\(?:Users|Temp)\\(?:[^\\\s"'`]+\\)*[^\\\s"'`]*/giu;
const POSIX_USER_PATH = /\/(?:Users|home|private\/tmp|tmp)(?:\/(?:[^\s,;:"'`\\]|\\.)+)+/gu;

function cachedWindowsPathRegex(normalized: string): RegExp {
  const existing = windowsPathRegexCache.get(normalized);
  if (existing) {
    windowsPathRegexCache.delete(normalized);
    windowsPathRegexCache.set(normalized, existing);
    return existing;
  }
  const compiled = new RegExp(escaped(normalized), "giu");
  windowsPathRegexCache.set(normalized, compiled);
  if (windowsPathRegexCache.size > MAX_PATH_REGEX_CACHE) {
    const oldest = windowsPathRegexCache.keys().next().value;
    if (typeof oldest === "string") windowsPathRegexCache.delete(oldest);
  }
  return compiled;
}

function scrubPathPrefix(text: string, path: string | undefined, replacement: string): string {
  const normalized = path?.replace(/[\\/]+$/u, "");
  if (!normalized) return text;
  if (process.platform !== "win32") {
    return text.includes(normalized) ? text.replaceAll(normalized, replacement) : text;
  }
  return text.replace(cachedWindowsPathRegex(normalized), replacement);
}

export const PROVIDER_ACTIVITY_DETAIL_OMISSION = /(\n… \[\d+ or more characters omitted\] …\n)/u;

export function boundProviderActivityDetail(
  value: string,
  maxChars = MAX_PROVIDER_ACTIVITY_DETAIL_CHARS,
): string {
  const limit = Math.max(0, Math.trunc(maxChars));
  if (value.length <= limit) return value;
  if (limit === 0) return "";
  const marker = `\n… [${value.length - limit} or more characters omitted] …\n`;
  if (marker.length >= limit) return value.slice(0, limit);
  const retained = limit - marker.length;
  const headLength = Math.ceil(retained * 0.65);
  return `${value.slice(0, headLength)}${marker}${value.slice(-(retained - headLength))}`;
}

/**
 * Scrubs provider-authored technical output before it crosses the persistence
 * boundary. This deliberately reuses the subagent secret scrubber because
 * both payloads can originate in tool output.
 */
const CREDENTIAL_ENVIRONMENT_KEY = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/iu;

export function launchCredentialValues(environment: NodeJS.ProcessEnv): string[] {
  return [...new Set(Object.entries(environment)
    .filter(([key, value]) => CREDENTIAL_ENVIRONMENT_KEY.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string))]
    .sort((left, right) => right.length - left.length);
}

export function redactExactCredentials(value: string, credentials: readonly string[]): string {
  return credentials.reduce((text, credential) => text.replaceAll(credential, "[redacted]"), value);
}

/**
 * Removes terminal escape sequences and C0/C1 control characters. Exact
 * credential matching must run on this form: a child that colours or splits a
 * secret with escape codes would otherwise pass the matcher and be re-joined by
 * the later sanitizer.
 */
const TERMINAL_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

export function stripTerminalControlSequences(value: string): string {
  if (!TERMINAL_CONTROL.test(value)) return value;
  let text = value.replace(/\r\n?/gu, "\n");
  for (const pattern of ANSI_ESCAPE) text = text.replace(pattern, "");
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "");
}

/** Encodings under which a launch credential can appear verbatim in output. */
export function credentialEncodings(credentials: readonly string[]): string[] {
  const values = new Set<string>();
  for (const credential of credentials) {
    if (!credential) continue;
    values.add(credential);
    values.add(Buffer.from(credential, "utf8").toString("base64"));
    values.add(Buffer.from(credential, "utf8").toString("base64url"));
    values.add(encodeURIComponent(credential));
    values.add(JSON.stringify(credential).slice(1, -1));
  }
  return [...values].filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
}

/**
 * Failure detail built from provider output that can echo a launch credential
 * (raw errors, stderr tails, result errors). Terminal controls are stripped
 * first so a secret split by an escape sequence still matches, every encoding
 * of each credential is redacted, and the usual sanitizer runs last. Provider
 * paths use this instead of composing the steps themselves: composing them in
 * the other order re-joins a split secret after the exact match has run.
 */
export function sanitizeProviderFailureDetail(
  value: unknown,
  launchCredentials: readonly string[],
  options: {
    workspaceRoot?: string;
    homeDirectory?: string;
    maxChars?: number;
  } = {},
): string | null {
  if (typeof value !== "string") return null;
  return sanitizeProviderActivityDetail(
    redactExactCredentials(
      stripTerminalControlSequences(value),
      credentialEncodings(launchCredentials),
    ),
    options,
  );
}

export function sanitizeProviderActivityDetail(
  value: unknown,
  options: {
    workspaceRoot?: string;
    homeDirectory?: string;
    maxChars?: number;
    preserveWhitespace?: boolean;
  } = {},
): string | null {
  if (typeof value !== "string") return null;
  let text = stripTerminalControlSequences(value);
  if (text.includes("<") && text.includes(">")) {
    text = text.replace(SYSTEM_PROMPT_TAG, "system_prompt=[redacted]");
  }
  const hasColon = text.includes(":");
  const hasEquals = text.includes("=");
  const hasColonOrEquals = hasColon || hasEquals;
  if (hasColonOrEquals) {
    text = text.replace(
      LABELED_PROMPT_LINE,
      (match) => `${match.startsWith("\n") ? "\n" : ""}system_prompt=[redacted]`,
    );
  }
  if (
    text.includes("?")
    || text.includes("&")
    || text.includes("#")
    || text.includes(";")
    || text.includes("%")
  ) {
    text = text.replace(QUERY_SECRET_PARAM, "$1[redacted]");
  }
  if (text.includes("_") || text.includes("-")) {
    text = text.replace(PLATFORM_TOKEN, "[redacted]");
  }
  if (text.includes("eyJ")) {
    text = text.replace(JWT_TOKEN, "[redacted]");
  }
  if (text.includes("sk-")) {
    text = text.replace(SK_TOKEN, "[redacted]");
  }
  if (hasColonOrEquals) {
    text = text.replace(KEY_VALUE_SECRET, "$1=[redacted]");
  }
  if (hasEquals) {
    text = text.replace(ENV_ASSIGNMENT_SECRET, "$1=[redacted]");
  }
  if (hasColon && (text.includes("-u") || text.includes("--user"))) {
    text = text.replace(
      USER_PASS_FLAG,
      (match, lead: string, flag: string, gap: string, user: string, password: string) =>
        /^\d+$/u.test(user) && /^\d+$/u.test(password)
          ? match
          : `${lead}${flag}${gap}${user}:[redacted]`,
    );
  }
  if (text.includes("--")) {
    text = text.replace(CLI_SECRET_FLAG, "$1--$2=[redacted]");
  }
  if (text.includes("-p")) {
    text = text.replace(MYSQL_PASSWORD_FLAG, "$1-p[redacted]");
  }
  if (text.includes("-p") || text.includes("-a")) {
    text = text.replace(CLI_TOOL_PASSWORD_FLAG, "$1 [redacted]");
  }
  if (text.includes("_")) {
    text = text.replace(AWS_CONFIGURE_SECRET, "$1[redacted]");
  }
  if (text.includes("_auth")) {
    text = text.replace(NPM_AUTH_CONFIG, "$1$2[redacted]");
  }
  // Scrubbing can lengthen the text, so only the caller's bound below cuts it.
  text = scrubSubagentSecrets(options.preserveWhitespace ? text : text.trim());
  text = scrubPathPrefix(text, options.workspaceRoot, "<workspace>");
  text = scrubPathPrefix(text, options.homeDirectory ?? DEFAULT_HOME_DIRECTORY, "<home>");
  if (text.includes(":\\")) {
    text = text
      .replace(QUOTED_WINDOWS_USER_PATH, "$1<path>$1")
      .replace(WINDOWS_USER_PATH, "<path>");
  }
  if (text.includes("/")) {
    text = text
      .replace(QUOTED_POSIX_USER_PATH, "$1<path>$1")
      .replace(POSIX_USER_PATH, "<path>");
  }
  if (!options.preserveWhitespace) text = text.trim();
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
  if (type === "content") {
    return officialToolResultText(record.content);
  }
  if (type === "diff") {
    const path = typeof record.path === "string" ? record.path : null;
    const oldText = typeof record.oldText === "string" ? record.oldText : null;
    const newText = typeof record.newText === "string" ? record.newText : null;
    const sections = [
      path ? `File: ${path}` : null,
      oldText !== null ? `Before:\n${oldText}` : null,
      newText !== null ? `After:\n${newText}` : null,
    ].filter((entry): entry is string => entry !== null);
    return sections.length > 0 ? sections.join("\n\n") : null;
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
    command ? `Command:\n${scrubCommandSecrets(command)}` : null,
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

const OUTPUT_BOUNDARY_RESCAN_CHARS = 1_024;

export function appendProviderActivityOutput(
  previous: string | null,
  output: string,
  continuing: boolean,
): string {
  if (!previous) return `Output:\n${output}`;
  if (!continuing) return `${previous}\n\nOutput:\n${output}`;
  const boundary = Math.max(
    previous.lastIndexOf("\n"),
    previous.length - OUTPUT_BOUNDARY_RESCAN_CHARS,
    0,
  );
  return previous.slice(0, boundary) + (sanitizeProviderActivityDetail(
    previous.slice(boundary) + output,
    { maxChars: Number.MAX_SAFE_INTEGER, preserveWhitespace: true },
  ) ?? "");
}

function withinTurnBudget(
  previous: string | null,
  currentTurnChars: number,
  candidate: string | null,
): { detail: string | null; totalChars: number } {
  const baseChars = Math.max(0, currentTurnChars - (previous?.length ?? 0));
  const remaining = Math.max(
    0,
    MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS - baseChars,
  );
  const detail = previous
    && candidate
    && candidate.length > remaining
    && remaining < MAX_PROVIDER_ACTIVITY_DETAIL_CHARS
    ? previous
    : boundProviderActivityDetail(
      candidate ?? "",
      Math.min(MAX_PROVIDER_ACTIVITY_DETAIL_CHARS, remaining),
    ) || null;
  return {
    detail,
    totalChars: baseChars + (detail?.length ?? 0),
  };
}

export function mergeProviderActivityDetailWithinTurnBudget(
  previous: string | null,
  next: string | null,
  currentTurnChars: number,
): { detail: string | null; totalChars: number } {
  return withinTurnBudget(
    previous,
    currentTurnChars,
    joinProviderActivityDetail(previous, next, Number.MAX_SAFE_INTEGER),
  );
}

export function mergeProviderActivityOutputWithinTurnBudget(
  previous: string | null,
  output: string,
  continuing: boolean,
  currentTurnChars: number,
): { detail: string | null; totalChars: number } {
  return withinTurnBudget(
    previous,
    currentTurnChars,
    appendProviderActivityOutput(previous, output, continuing),
  );
}
