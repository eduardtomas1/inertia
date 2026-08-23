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

const CONTROL_OR_BIDI = /[\p{Cc}\p{Default_Ignorable_Code_Point}]+/gu;
const HTTP_SCHEME = /https?:\/\//iu;
const URL_TOKEN = /https?:\/\/[^\s<>"'`]+/giu;
const AUTHORITY_URI_TOKEN = /(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^\s<>"'`]+/giu;
const FILE_URL = /(?<![A-Za-z0-9])file:\/\/[^\s<>"'`]+/giu;
const POSIX_PATH = /(?<![A-Za-z0-9])\/(?:[^/\s,;:)"']+\/)+[^/\s,;:)"']+/gu;
const RELATIVE_FILE_PATH = /(^|[\s(=:"'])(?:(?:\.{1,2}|[^/\s,;:)"']+)\/)+[^/\s,;:)"']+\.[A-Za-z0-9]{1,12}(?=$|[\s,;:)"'])/gu;
const RELATIVE_EXTENSIONLESS_PATH = /(^|[\s(=:"'])(?:(?:\.{1,2})\/[^/\s,;:)"']+|(?:[^/\s,;:)"']+\/){2,}[^/\s,;:)"']+|(?:[^/\s,;:)"']+\/)+\.[A-Za-z0-9][^/\s,;:)"']*)(?=$|[\s,;:)"'])/gu;
const RELATIVE_WINDOWS_PATH = /(^|[\s(=:"'])(?:(?:\.{1,2})\\[^\\/\s,;:)"']+|(?:[^\\/\s,;:)"']+\\){2,}[^\\/\s,;:)"']+|(?:[^\\/\s,;:)"']+\\)+(?:\.[A-Za-z0-9][^\\/\s,;:)"']*|[^\\/\s,;:)"']+\.[A-Za-z0-9]{1,12}))(?=$|[\s,;:)"'])/gu;
const COMMON_ROOT_RELATIVE_PATH = /(^|[\s(=:"'])(?:app|assets|bin|build|config|configs|dist|docs|lib|out|packages|public|resources|scripts|src|spec|specs|test|tests)[\\/][^\\/\s,;:)"']+(?:[\\/][^\\/\s,;:)"']+)*(?=$|[\s,;:)"'])/giu;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\\\s,;:)"']+\\)*[^\\\s,;:)"']*/gu;
const UNC_OR_HOME_PATH = /(?:\\\\[^\\\s]+\\[^\s,;:)"']+|~\/(?:[^\s,;:)"']+\/)*[^\s,;:)"']+)/gu;
const WINDOWS_OR_UNC_PATH_PREFIX = /(?:(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|(?:^|[\s(="'])\/\/)/u;
const DRIVE_RELATIVE_WINDOWS_PATH = /(?:^|[\s(="'])[A-Za-z]:(?![\\/])(?:[^\\/\s,;:)"']+[\\/][^\\/\s,;:)"']+|(?:\.[A-Za-z0-9][^\\/\s,;:)"']*|[^\\/\s,;:)"']+\.[A-Za-z0-9]{1,12}))(?=$|[\s,;:)"']|[\\/])/gu;
const CREDENTIAL_ASSIGNMENT =
  /(?<![A-Za-z0-9])(api[-_ ]?key|authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|credential|passcode|passphrase|password|passwd|pgpassword|pwd|secret|session|token)(?![A-Za-z0-9])["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTHORIZATION_VALUE = /(?<![A-Za-z0-9])(Bearer|Basic)\s+[^\s,;]+/giu;
const PREFIXED_SECRET =
  /(?<![A-Za-z0-9])(?:(?:sk|rk|pk|ghp|github_pat|glpat|npm|pypi|hf|xox[baprs]|api|key|token)[-_][A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})(?![A-Za-z0-9])/gu;
const JWT = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])/gu;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu;
const LONG_OPAQUE_VALUE = /(?<![A-Za-z0-9])(?=[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9]))(?=[A-Za-z0-9+/_=-]*[A-Za-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]+/gu;
const TRAILING_SECRET_FRAGMENT =
  /(?<![A-Za-z0-9])(?:(?:sk|rk|pk|ghp|github_pat|xox[baprs]|api|key|token)[-_][A-Za-z0-9_-]*|eyJ[A-Za-z0-9_.-]*|(?:Bearer|Basic)\s+\S*)$/iu;
const SENSITIVE_FIELD =
  /(?<![A-Za-z0-9])(?:(?:access|auth|id|refresh)[-_ ]?token|api[-_ ]?key|authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|credential|password|passwd|(?:passcode|passphrase|pgpassword|pwd)(?=\s*["']?\s*[:=])|private[-_ ]?key|request[-_ ]?body|secret|session|token)(?![A-Za-z0-9])/iu;
const CAMEL_CASE_CREDENTIAL_ASSIGNMENT =
  /(?<![A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9]*?)?(?:AccessKey|AccessToken|APIKey|ApiKey|AuthHeader|AuthToken|Authorization|AuthorizationHeader|Cookie|Credential|Credentials|EncryptionKey|IDToken|IdToken|PAT|Pat|PGPassword|Passcode|Passphrase|Password|Passwd|PrivateKey|Pwd|RefreshToken|RequestBody|Secret|SecretKey|Session|SessionId|SigningKey|Token)(?:Value|Values)?(?![A-Za-z0-9])["']?\s*[:=]/giu;
const SECRET_HOST_FRAGMENT =
  /(?:(?:sk|rk|pk|ghp|github[-_]?pat|glpat|npm|pypi|hf|xox[baprs]|api|key|token)[-_][a-z0-9_-]{8,}|(?:akia|asia)[a-z0-9]{16}|aiza[a-z0-9_-]{20,})/iu;
const MAX_PERCENT_DECODE_PASSES = 4;
const MAX_INSPECTION_REPRESENTATIONS = 8;

function boundedInput(value: string, maximum: number): string {
  return value.slice(0, Math.max(maximum + 4_096, 4_096));
}

function patternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function withoutHttpUrls(value: string): string {
  URL_TOKEN.lastIndex = 0;
  const remaining = value.replace(URL_TOKEN, "");
  URL_TOKEN.lastIndex = 0;
  return remaining;
}

function parsedAuthorityUri(value: string): URL | null {
  const candidate = value.replace(/[),.;!?]+$/u, "");
  try {
    return new URL(candidate.startsWith("//") ? `evidence:${candidate}` : candidate);
  } catch {
    return null;
  }
}

function hasCredentialBearingUri(value: string): boolean {
  AUTHORITY_URI_TOKEN.lastIndex = 0;
  for (const match of value.matchAll(AUTHORITY_URI_TOKEN)) {
    if (parsedAuthorityUri(match[0])?.password) {
      AUTHORITY_URI_TOKEN.lastIndex = 0;
      return true;
    }
  }
  AUTHORITY_URI_TOKEN.lastIndex = 0;
  return false;
}

function withoutAuthorityUris(value: string): string {
  AUTHORITY_URI_TOKEN.lastIndex = 0;
  const remaining = value.replace(AUTHORITY_URI_TOKEN, "");
  AUTHORITY_URI_TOKEN.lastIndex = 0;
  return remaining;
}

function withoutControlOrBidi(value: string): string {
  CONTROL_OR_BIDI.lastIndex = 0;
  const normalized = value.replace(CONTROL_OR_BIDI, "");
  CONTROL_OR_BIDI.lastIndex = 0;
  return normalized;
}

function hasFilesystemPathCandidate(value: string): boolean {
  return patternMatches(FILE_URL, value)
    || patternMatches(POSIX_PATH, value)
    || patternMatches(RELATIVE_FILE_PATH, value)
    || patternMatches(RELATIVE_EXTENSIONLESS_PATH, value)
    || patternMatches(RELATIVE_WINDOWS_PATH, value)
    || patternMatches(COMMON_ROOT_RELATIVE_PATH, value)
    || patternMatches(WINDOWS_OR_UNC_PATH_PREFIX, value)
    || patternMatches(DRIVE_RELATIVE_WINDOWS_PATH, value)
    || patternMatches(UNC_OR_HOME_PATH, value);
}

interface BrowserEvidenceInspectionDecision {
  authorityProjectionSignature: string;
  authorityProjectionRequired: boolean;
  failClosed: boolean;
  secretProjectionRequired: boolean;
}

function authorityProjectionSignature(value: string): string {
  AUTHORITY_URI_TOKEN.lastIndex = 0;
  const matches = Array.from(value.matchAll(AUTHORITY_URI_TOKEN), (match) => match[0]);
  AUTHORITY_URI_TOKEN.lastIndex = 0;
  return JSON.stringify(matches.map((match) =>
    replaceAuthorityUri(replaceUrl(match).value).value
  ));
}

function inspectBrowserEvidenceRepresentation(
  value: string,
): BrowserEvidenceInspectionDecision {
  const outsideAuthorityUris = withoutAuthorityUris(value);
  const outsideHttpUrls = withoutHttpUrls(value);
  const authorityProjected = replaceAuthorityUri(replaceUrl(value).value).value;
  return {
    authorityProjectionSignature: authorityProjectionSignature(value),
    authorityProjectionRequired: authorityProjected !== value,
    failClosed: patternMatches(HTTP_SCHEME, outsideHttpUrls)
    || patternMatches(SENSITIVE_FIELD, value)
    || patternMatches(CREDENTIAL_ASSIGNMENT, value)
    || patternMatches(CAMEL_CASE_CREDENTIAL_ASSIGNMENT, value)
    || patternMatches(AUTHORIZATION_VALUE, value)
    || hasCredentialBearingUri(value)
    || patternMatches(FILE_URL, value)
    || patternMatches(WINDOWS_OR_UNC_PATH_PREFIX, value)
    || patternMatches(DRIVE_RELATIVE_WINDOWS_PATH, value)
    || hasFilesystemPathCandidate(outsideAuthorityUris),
    secretProjectionRequired: patternMatches(PREFIXED_SECRET, value)
      || patternMatches(JWT, value)
      || patternMatches(PRIVATE_KEY, value)
      || patternMatches(LONG_OPAQUE_VALUE, value),
  };
}

function boundedNormalizedInspection(
  value: string,
  maximum: number,
): string | null {
  const normalized = withoutControlOrBidi(value).normalize("NFKC");
  return normalized.length <= maximum ? normalized : null;
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

function boundedInspectionRepresentations(
  value: string,
  maximum: number,
): string[] | null {
  const representations = [value];
  const seen = new Set(representations);
  for (let index = 0; index < representations.length; index += 1) {
    const representation = representations[index]!;
    const decoded = boundedPercentDecode(representation);
    const normalized = boundedNormalizedInspection(representation, maximum);
    if (decoded === null || normalized === null) return null;
    for (const candidate of [decoded, normalized]) {
      if (seen.has(candidate)) continue;
      if (representations.length >= MAX_INSPECTION_REPRESENTATIONS) return null;
      seen.add(candidate);
      representations.push(candidate);
    }
  }
  return representations;
}

function suspiciousHostname(hostname: string): boolean {
  return hostname.split(".").some((label) =>
    SECRET_HOST_FRAGMENT.test(label)
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

function replaceAuthorityUri(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  AUTHORITY_URI_TOKEN.lastIndex = 0;
  const replaced = value.replace(AUTHORITY_URI_TOKEN, (match) => {
    const url = parsedAuthorityUri(match);
    if (!url || url.password || !url.hostname || suspiciousHostname(url.hostname)) {
      redacted = true;
      return "<redacted-url>";
    }
    const directHttp = url.protocol === "http:" || url.protocol === "https:";
    if (directHttp) return match;
    redacted = true;
    const protocol = match.startsWith("//") ? "" : url.protocol;
    return `${protocol}//${url.host}`;
  });
  AUTHORITY_URI_TOKEN.lastIndex = 0;
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
  const inspectionMaximum = Math.max(limit + 4_096, 4_096);
  const inspectionRepresentations = boundedInspectionRepresentations(
    inspected,
    inspectionMaximum,
  );
  if (inspectionRepresentations === null) {
    return { text: fallback.slice(0, limit), redacted: true };
  }
  // Decode and normalize to a bounded fixpoint, then inspect every distinct
  // representation through one cached decision. Only the raw view may rely
  // on projection; a derived view that newly needs it must fail closed.
  const decisions = new Map<string, BrowserEvidenceInspectionDecision>();
  const decisionFor = (representation: string): BrowserEvidenceInspectionDecision => {
    const cached = decisions.get(representation);
    if (cached) return cached;
    const decision = inspectBrowserEvidenceRepresentation(representation);
    decisions.set(representation, decision);
    return decision;
  };
  const rawDecision = decisionFor(inspected);
  if (rawDecision.failClosed) {
    return { text: fallback.slice(0, limit), redacted: true };
  }
  for (const representation of inspectionRepresentations.slice(1)) {
    const decision = decisionFor(representation);
    if (
      decision.failClosed
      || decision.secretProjectionRequired
      || (
        decision.authorityProjectionRequired
        && (
          !rawDecision.authorityProjectionRequired
          || decision.authorityProjectionSignature
            !== rawDecision.authorityProjectionSignature
        )
      )
    ) {
      return { text: fallback.slice(0, limit), redacted: true };
    }
  }
  let redacted = inspected.length < value.length;
  let text = inspected.replace(CONTROL_OR_BIDI, () => {
    redacted = true;
    return " ";
  });
  const url = replaceUrl(text);
  text = url.value;
  redacted ||= url.redacted;
  const authorityUri = replaceAuthorityUri(text);
  text = authorityUri.value;
  redacted ||= authorityUri.redacted;
  const replacements: ReadonlyArray<readonly [RegExp, string]> = [
    [FILE_URL, "<path>"],
    [POSIX_PATH, "$1<path>"],
    [RELATIVE_FILE_PATH, "$1<path>"],
    [RELATIVE_EXTENSIONLESS_PATH, "$1<path>"],
    [RELATIVE_WINDOWS_PATH, "$1<path>"],
    [COMMON_ROOT_RELATIVE_PATH, "$1<path>"],
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
  const projectedDecision = decisionFor(text);
  if (
    projectedDecision.failClosed
    || projectedDecision.authorityProjectionRequired
    || projectedDecision.secretProjectionRequired
  ) {
    return { text: fallback.slice(0, limit), redacted: true };
  }
  return { text: text || fallback.slice(0, limit), redacted };
}
