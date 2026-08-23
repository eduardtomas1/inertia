export const MAX_BROWSER_EVIDENCE_ENTRIES = 100;
export const MAX_BROWSER_EVIDENCE_METADATA_BYTES = 128 * 1024;
export const MAX_BROWSER_EVIDENCE_SCREENSHOTS = 8;
export const MAX_BROWSER_EVIDENCE_THUMBNAIL_BYTES = 256 * 1024;
export const MAX_BROWSER_EVIDENCE_THUMBNAIL_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_BROWSER_EVIDENCE_TEXT_CHARS = 600;

export type BrowserEvidenceKind =
  | "navigation"
  | "console-error"
  | "network-failure"
  | "agent-action"
  | "screenshot";

export interface BrowserEvidenceScreenshot {
  available: boolean;
  width: number;
  height: number;
}

export interface BrowserEvidenceEntry {
  id: string;
  sequence: number;
  kind: BrowserEvidenceKind;
  tabId: string;
  pageNumber: number;
  documentSequence: number;
  runId: string | null;
  turnId: string | null;
  occurredAt: string;
  summary: string;
  detail: string | null;
  origin: string | null;
  redacted: boolean;
  occurrences: number;
  screenshot?: BrowserEvidenceScreenshot;
}

export interface BrowserEvidenceSnapshot {
  revision: number;
  entries: BrowserEvidenceEntry[];
  omitted: boolean;
}

export interface BrowserEvidenceImage {
  mimeType: "image/png";
  data: string;
}

export interface SanitizedBrowserEvidenceText {
  text: string;
  redacted: boolean;
}

const CONTROL_OR_BIDI =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]+/gu;
const URL_TOKEN = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const FILE_URL = /\bfile:\/\/[^\s<>"'`]+/giu;
const POSIX_PATH = /(^|[\s(=:"'])\/(?:[^/\s,;:)"']+\/)*[^/\s,;:)"']+/gu;
const RELATIVE_FILE_PATH = /(^|[\s(=:"'])(?:(?:\.{1,2}|[^/\s,;:)"']+)\/)+[^/\s,;:)"']+\.[A-Za-z0-9]{1,12}(?=$|[\s,;:)"'])/gu;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\\\s,;:)"']+\\)*[^\\\s,;:)"']*/gu;
const UNC_OR_HOME_PATH = /(?:\\\\[^\\\s]+\\[^\s,;:)"']+|~\/(?:[^\s,;:)"']+\/)*[^\s,;:)"']+)/gu;
const WINDOWS_OR_UNC_PATH_PREFIX = /(?:(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|(?:^|[\s(="'])\/\/)/u;
const CREDENTIAL_ASSIGNMENT =
  /\b(api[-_ ]?key|authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|credential|password|passwd|secret|session|token)\b\s*[:=]\s*(?:(?:Bearer|Basic)\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[^\s,;]+/giu;
const PREFIXED_SECRET =
  /\b(?:(?:sk|rk|pk|ghp|github_pat|glpat|npm|pypi|hf|xox[baprs]|api|key|token)[-_][A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu;
const LONG_OPAQUE_VALUE = /\b(?=[A-Za-z0-9+/_=-]{32,}\b)(?=[A-Za-z0-9+/_=-]*[A-Za-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]+/gu;
const TRAILING_SECRET_FRAGMENT =
  /(?:\b(?:sk|rk|pk|ghp|github_pat|xox[baprs]|api|key|token)[-_][A-Za-z0-9_-]*|\beyJ[A-Za-z0-9_.-]*|\b(?:Bearer|Basic)\s+\S*)$/iu;
const SENSITIVE_FIELD =
  /\b(?:api[-_ ]?key|authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|credential|password|passwd|private[-_ ]?key|request[-_ ]?body|secret|session|token)\b/iu;
const SECRET_HOST_LABEL =
  /^(?:(?:sk|rk|pk|ghp|github[-_]?pat|glpat|npm|pypi|hf|xox[baprs]|api|key|token)[-_][a-z0-9_-]{8,}|(?:akia|asia)[a-z0-9]{16}|aiza[a-z0-9_-]{20,})$/iu;
const MAX_PERCENT_DECODE_PASSES = 4;

function boundedInput(value: string, maximum: number): string {
  return value.slice(0, Math.max(maximum + 4_096, 4_096));
}

function patternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function boundedPercentDecode(value: string): string | null {
  let decoded = value;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    if (!decoded.includes("%")) return decoded;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded.includes("%") ? null : decoded;
}

function suspiciousHostname(hostname: string): boolean {
  return hostname.split(".").some((label) =>
    SECRET_HOST_LABEL.test(label)
    || (
      label.length >= 32
      && /[A-Za-z]/u.test(label)
      && /\d/u.test(label)
    ));
}

/**
 * Browser evidence deliberately keeps only an HTTP(S) origin. User info,
 * paths, queries, and fragments are never part of the local ledger.
 */
export function browserEvidenceOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || suspiciousHostname(url.hostname)
    ) return null;
    return url.origin.slice(0, 300);
  } catch {
    return null;
  }
}

function replaceUrl(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  const replaced = value.replace(URL_TOKEN, (match) => {
    redacted = true;
    const origin = browserEvidenceOrigin(match.replace(/[),.;!?]+$/u, ""));
    return origin ?? "<redacted-url>";
  });
  return { value: replaced, redacted };
}

/**
 * Sanitizes page-authored evidence before it enters main-process storage.
 * This is intentionally lossy: uncertain credential-bearing fields fail
 * closed to a fixed message rather than attempting to preserve their value.
 */
export function sanitizeBrowserEvidenceText(
  value: unknown,
  fallback: string,
  maximum = MAX_BROWSER_EVIDENCE_TEXT_CHARS,
): SanitizedBrowserEvidenceText {
  const limit = Math.max(1, Math.min(Math.trunc(maximum), MAX_BROWSER_EVIDENCE_TEXT_CHARS));
  if (typeof value !== "string") return { text: fallback.slice(0, limit), redacted: true };
  const inspected = boundedInput(value, limit);
  const decoded = boundedPercentDecode(inspected);
  if (decoded === null) {
    return { text: fallback.slice(0, limit), redacted: true };
  }
  if (
    SENSITIVE_FIELD.test(inspected)
    || patternMatches(AUTHORIZATION_VALUE, inspected)
    || patternMatches(WINDOWS_OR_UNC_PATH_PREFIX, inspected)
    || (
      decoded !== inspected
      && (
        SENSITIVE_FIELD.test(decoded)
        || patternMatches(AUTHORIZATION_VALUE, decoded)
        || patternMatches(PREFIXED_SECRET, decoded)
        || patternMatches(JWT, decoded)
        || patternMatches(PRIVATE_KEY, decoded)
        || patternMatches(POSIX_PATH, decoded)
        || patternMatches(RELATIVE_FILE_PATH, decoded)
        || patternMatches(WINDOWS_OR_UNC_PATH_PREFIX, decoded)
        || patternMatches(UNC_OR_HOME_PATH, decoded)
      )
    )
  ) {
    return { text: fallback.slice(0, limit), redacted: true };
  }
  let redacted = inspected.length < value.length;
  let text = inspected.replace(CONTROL_OR_BIDI, () => {
    redacted = true;
    return " ";
  });
  const url = replaceUrl(text);
  text = url.value;
  redacted ||= url.redacted;
  const replacements: ReadonlyArray<readonly [RegExp, string]> = [
    [FILE_URL, "<path>"],
    [POSIX_PATH, "$1<path>"],
    [RELATIVE_FILE_PATH, "$1<path>"],
    [WINDOWS_PATH, "<path>"],
    [UNC_OR_HOME_PATH, "<path>"],
    [CREDENTIAL_ASSIGNMENT, "$1=<redacted>"],
    [AUTHORIZATION_VALUE, "$1 <redacted>"],
    [PREFIXED_SECRET, "<redacted>"],
    [JWT, "<redacted>"],
    [PRIVATE_KEY, "<redacted>"],
    [LONG_OPAQUE_VALUE, "<redacted>"],
  ];
  for (const [pattern, replacement] of replacements) {
    if (patternMatches(pattern, text)) redacted = true;
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/gu, " ").trim();
  if (!text) return { text: fallback.slice(0, limit), redacted: true };
  if (text.length > limit) {
    redacted = true;
    text = text.slice(0, limit).replace(TRAILING_SECRET_FRAGMENT, "").trimEnd();
  }
  return { text: text || fallback.slice(0, limit), redacted };
}
