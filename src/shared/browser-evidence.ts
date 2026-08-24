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
const FILE_URL = /(?<![A-Za-z0-9])file:\/\/[^\s<>"'`]+/giu;
const CREDENTIAL_ASSIGNMENT =
  /(?<![A-Za-z0-9])(api[-_ ]?key|authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|credential|pass(?:[-_ ]?values?)?|passcode|passphrase|password|passwd|pgpassword|pwd|secret|session|token)(?![A-Za-z0-9])["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTHORIZATION_VALUE = /(?<![A-Za-z0-9])(Bearer|Basic)\s+[^\s,;]+/giu;
const PREFIXED_SECRET =
  /(?<![A-Za-z0-9])(?:(?:sk|rk|pk|gh[opusr]|github_pat|glpat|npm|pypi|hf|xox[baprs]|api|key|token)[-_][A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})(?![A-Za-z0-9])/gu;
const JWT = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])/gu;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu;
const LONG_OPAQUE_VALUE = /(?<![A-Za-z0-9])(?=[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9]))(?=[A-Za-z0-9+/_=-]*[A-Za-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]+/gu;
const TRAILING_SECRET_FRAGMENT =
  /(?<![A-Za-z0-9])(?:(?:sk|rk|pk|gh[opusr]|github_pat|xox[baprs]|api|key|token)[-_][A-Za-z0-9_-]*|eyJ[A-Za-z0-9_.-]*|(?:Bearer|Basic)\s+\S*)$/iu;
const SENSITIVE_FIELD =
  /(?<![A-Za-z0-9])(?:(?:access|auth|id|refresh)[-_ ]?token|(?:secret[-_ ]+)?access[-_ ]+key(?:[-_ ]+id)?|api[-_ ]?key|authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|credential|password|passwd|(?:pass(?:[-_ ]?values?)?|passcode|passphrase|pgpassword|pwd)(?=\s*["']?\s*[:=])|private[-_ ]?key|request[-_ ]?body|secret|session|token)(?![A-Za-z0-9])/iu;
const CAMEL_CASE_CREDENTIAL_ASSIGNMENT =
  /(?<![A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9]*?)?(?:AccessKey|AccessToken|APIKey|ApiKey|AuthHeader|AuthToken|Authorization|AuthorizationHeader|Cookie|Credential|Credentials|EncryptionKey|IDToken|IdToken|PAT|Pat|PGPassword|Passcode|Passphrase|Password|Passwd|PrivateKey|Pwd|RefreshToken|RequestBody|Secret|SecretKey|Session|SessionId|SigningKey|Token)(?:Value|Values)?(?![A-Za-z0-9])["']?\s*[:=]/giu;
const SECRET_HOST_FRAGMENT =
  /(?:(?:sk|rk|pk|gh[opusr]|github[-_]?pat|glpat|npm|pypi|hf|xox[baprs]|api|key|token)[-_][a-z0-9_-]{8,}|(?:akia|asia)[a-z0-9]{16}|aiza[a-z0-9_-]{20,})/iu;
const MAX_PERCENT_DECODE_PASSES = 4;
const MAX_INSPECTION_REPRESENTATIONS = 8;
const CONCATENATED_PASS_NAMESPACES = new Set([
  "account",
  "admin",
  "app",
  "application",
  "auth",
  "backup",
  "client",
  "database",
  "db",
  "dev",
  "email",
  "ftp",
  "guest",
  "ldap",
  "login",
  "mail",
  "master",
  "mongo",
  "mongodb",
  "my",
  "mysql",
  "network",
  "oracle",
  "portal",
  "postgres",
  "postgresql",
  "prod",
  "proxy",
  "redis",
  "root",
  "server",
  "service",
  "smtp",
  "ssh",
  "tenant",
  "user",
  "username",
  "vpn",
  "web",
  "wifi",
]);
const COMMON_RELATIVE_PATH_ROOTS = new Set([
  "app", "assets", "bin", "build", "config", "configs", "dist", "docs",
  "lib", "out", "packages", "projects", "public", "resources", "scripts",
  "spec", "specs", "src", "test", "tests", "workspace",
]);

interface TextRange {
  start: number;
  end: number;
}

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

function asciiLetter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z]/u.test(character);
}

function uriSchemeCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9+.-]/u.test(character);
}

function authorityTokenTerminator(character: string): boolean {
  return /[\s<>"'`]/u.test(character);
}

/**
 * Finds hierarchical-URI tokens in one monotonic pass. In particular, a long
 * scheme-shaped near miss is never retried from each subsequent character.
 */
function authorityUriTokenRanges(value: string): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;
  while (index + 2 < value.length) {
    if (value[index] !== "/" || value[index + 1] !== "/") {
      index += 1;
      continue;
    }
    let start = index;
    if (value[index - 1] === ":") {
      let schemeRunStart = index - 2;
      while (schemeRunStart >= 0 && uriSchemeCharacter(value[schemeRunStart])) {
        schemeRunStart -= 1;
      }
      schemeRunStart += 1;
      while (schemeRunStart < index - 1 && !asciiLetter(value[schemeRunStart])) {
        schemeRunStart += 1;
      }
      if (schemeRunStart < index - 1) start = schemeRunStart;
    }
    let end = index + 2;
    while (end < value.length && !authorityTokenTerminator(value[end]!)) end += 1;
    if (end === index + 2) {
      index += 2;
      continue;
    }
    ranges.push({ start, end });
    index = end;
  }
  return ranges;
}

function textWithoutRanges(value: string, ranges: readonly TextRange[]): string {
  if (ranges.length === 0) return value;
  let result = "";
  let copiedUntil = 0;
  for (const range of ranges) {
    result += value.slice(copiedUntil, range.start);
    copiedUntil = range.end;
  }
  return result + value.slice(copiedUntil);
}

function parsedAuthorityUri(value: string): URL | null {
  const candidate = value.replace(/[),.;!?]+$/u, "");
  try {
    return new URL(candidate.startsWith("//") ? `evidence:${candidate}` : candidate);
  } catch {
    return null;
  }
}

function hasCredentialBearingUri(
  value: string,
  ranges: readonly TextRange[],
): boolean {
  return ranges.some((range) =>
    Boolean(parsedAuthorityUri(value.slice(range.start, range.end))?.password));
}

function withoutAuthorityUris(
  value: string,
  ranges: readonly TextRange[],
): string {
  return textWithoutRanges(value, ranges);
}

function withoutControlOrBidi(value: string): string {
  CONTROL_OR_BIDI.lastIndex = 0;
  const normalized = value.replace(CONTROL_OR_BIDI, "");
  CONTROL_OR_BIDI.lastIndex = 0;
  return normalized;
}

function alphanumeric(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9]/u.test(character);
}

function pathTokenTerminator(character: string): boolean {
  return /[\s,;:()="']/u.test(character);
}

function pathSeparator(character: string | undefined): boolean {
  return character === "/" || character === "\\";
}

function hasFileExtension(component: string): boolean {
  const dot = component.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = component.slice(dot + 1);
  return extension.length >= 1
    && extension.length <= 12
    && /^[A-Za-z0-9]+$/u.test(extension);
}

function relativePathToken(value: string): boolean {
  if (
    value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith(".\\")
    || value.startsWith("..\\")
  ) return value.length > (value[1] === "." ? 3 : 2);

  let separators = 0;
  let firstSeparator = -1;
  let lastSeparator = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (!pathSeparator(value[index])) continue;
    separators += 1;
    if (firstSeparator < 0) firstSeparator = index;
    lastSeparator = index;
  }
  if (separators >= 2) return true;
  if (separators === 0 || lastSeparator === value.length - 1) return false;
  const root = value.slice(0, firstSeparator).toLowerCase();
  const leaf = value.slice(lastSeparator + 1);
  return COMMON_RELATIVE_PATH_ROOTS.has(root)
    || (leaf.startsWith(".") && leaf.length > 1)
    || hasFileExtension(leaf);
}

function relativePathAcrossEmbeddedSpaces(value: string): boolean {
  for (const separator of ["/", "\\"] as const) {
    let previous = -1;
    let root = "";
    let whitespaceRuns = 0;
    let inWhitespace = false;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]!;
      if (/[,;:()="'<>`]/u.test(character)) {
        previous = -1;
        root = "";
        whitespaceRuns = 0;
        inWhitespace = false;
        continue;
      }
      if (/\s/u.test(character)) {
        if (previous >= 0 && !inWhitespace) whitespaceRuns += 1;
        inWhitespace = true;
        continue;
      }
      inWhitespace = false;
      if (character !== separator) continue;
      if (
        previous > 0
        && whitespaceRuns > 0
        && index + 1 < value.length
        && !pathTokenTerminator(value[previous - 1]!)
        && !pathTokenTerminator(value[index + 1]!)
      ) {
        let leafEnd = index + 1;
        while (
          leafEnd < value.length
          && !pathTokenTerminator(value[leafEnd]!)
          && !/[,;:()="'<>`]/u.test(value[leafEnd]!)
        ) leafEnd += 1;
        const leaf = value.slice(index + 1, leafEnd);
        const coherentUnlistedCandidate = whitespaceRuns === 1
          && root.length >= 2
          && leaf.length >= 2;
        if (
          coherentUnlistedCandidate
          || COMMON_RELATIVE_PATH_ROOTS.has(root)
          || root === "."
          || root === ".."
          || (leaf.startsWith(".") && leaf.length > 1)
          || hasFileExtension(leaf)
        ) return true;
      }
      if (previous < 0) {
        let rootStart = index;
        while (
          rootStart > 0
          && !pathTokenTerminator(value[rootStart - 1]!)
          && !/[,;:()="'<>`]/u.test(value[rootStart - 1]!)
        ) rootStart -= 1;
        root = value.slice(rootStart, index).toLowerCase();
      }
      previous = index;
      whitespaceRuns = 0;
    }
  }
  return false;
}

function hasNonTrailingPathSeparator(value: string): boolean {
  for (let index = 0; index < value.length - 1; index += 1) {
    if (pathSeparator(value[index])) return true;
  }
  return false;
}

function hasAmbiguousFilesystemPathPrefix(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const previous = value[index - 1];
    const boundary = index === 0 || !alphanumeric(previous);
    if (
      boundary
      && asciiLetter(value[index])
      && value[index + 1] === ":"
    ) {
      if (pathSeparator(value[index + 2])) return true;
      let end = index + 2;
      while (end < value.length && !pathTokenTerminator(value[end]!)) end += 1;
      const relative = value.slice(index + 2, end);
      if (
        (relative.startsWith(".") && relative.length > 1)
        || hasFileExtension(relative)
        || hasNonTrailingPathSeparator(relative)
      ) return true;
    }
    if (value[index] === "\\" && value[index + 1] === "\\") return true;
    if (
      value[index] === "/"
      && value[index + 1] === "/"
      && (
        index === 0
        || previous === " "
        || previous === "("
        || previous === "="
        || previous === "\""
        || previous === "'"
      )
    ) return true;
  }
  return false;
}

function hasFilesystemPathCandidate(value: string): boolean {
  if (
    patternMatches(FILE_URL, value)
    || hasAmbiguousFilesystemPathPrefix(value)
    || relativePathAcrossEmbeddedSpaces(value)
  ) {
    return true;
  }
  for (let index = 0; index < value.length;) {
    if (pathTokenTerminator(value[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < value.length && !pathTokenTerminator(value[index]!)) index += 1;
    const token = value.slice(start, index);
    if (token.startsWith("~/") && token.length > 2) return true;
    for (let offset = 0; offset + 1 < token.length; offset += 1) {
      if (
        token[offset] === "/"
        && token[offset + 1] !== "/"
        && (offset === 0 || !alphanumeric(token[offset - 1]))
      ) return true;
    }
    if (relativePathToken(token)) return true;

    for (let offset = 0; offset + 2 < token.length; offset += 1) {
      if (!asciiLetter(token[offset]) || token[offset + 1] !== ":") continue;
      const relative = token.slice(offset + 2);
      if (relativePathToken(relative) || hasFileExtension(relative)) return true;
    }
  }
  return false;
}

function concatenatedPassKey(value: string): boolean {
  const normalized = value.toLowerCase();
  const withoutProjectionSuffix = normalized.endsWith("values")
    ? normalized.slice(0, -"values".length)
    : normalized.endsWith("value")
      ? normalized.slice(0, -"value".length)
      : normalized;
  if (withoutProjectionSuffix === "pass") return true;
  if (!withoutProjectionSuffix.endsWith("pass")) return false;
  return CONCATENATED_PASS_NAMESPACES.has(
    withoutProjectionSuffix.slice(0, -"pass".length),
  );
}

function hasConcatenatedPassAssignment(value: string): boolean {
  for (let index = 0; index < value.length;) {
    if (!asciiLetter(value[index]) || alphanumeric(value[index - 1])) {
      index += 1;
      continue;
    }
    const start = index;
    while (alphanumeric(value[index])) index += 1;
    const key = value.slice(start, index);
    let assignment = index;
    if (value[assignment] === "\"" || value[assignment] === "'") assignment += 1;
    while (/\s/u.test(value[assignment] ?? "")) assignment += 1;
    if (
      concatenatedPassKey(key)
      && (value[assignment] === ":" || value[assignment] === "=")
    ) return true;
  }
  return false;
}

interface BrowserEvidenceInspectionDecision {
  authorityProjectionSignature: string;
  authorityProjectionRequired: boolean;
  failClosed: boolean;
  secretProjectionRequired: boolean;
}

function authorityProjectionSignature(value: string): string {
  const ranges = authorityUriTokenRanges(value);
  return JSON.stringify(ranges.map((range) =>
    replaceAuthorityUri(replaceUrl(value.slice(range.start, range.end)).value).value
  ));
}

function inspectBrowserEvidenceRepresentation(
  value: string,
): BrowserEvidenceInspectionDecision {
  const authorityRanges = authorityUriTokenRanges(value);
  const outsideAuthorityUris = withoutAuthorityUris(value, authorityRanges);
  const outsideHttpUrls = withoutHttpUrls(value);
  const authorityProjected = replaceAuthorityUri(replaceUrl(value).value).value;
  const failClosed = patternMatches(HTTP_SCHEME, outsideHttpUrls)
    || patternMatches(SENSITIVE_FIELD, value)
    || patternMatches(CREDENTIAL_ASSIGNMENT, value)
    || patternMatches(CAMEL_CASE_CREDENTIAL_ASSIGNMENT, value)
    || hasConcatenatedPassAssignment(value)
    || patternMatches(AUTHORIZATION_VALUE, value)
    || hasCredentialBearingUri(value, authorityRanges)
    || patternMatches(FILE_URL, value)
    || hasAmbiguousFilesystemPathPrefix(value)
    || hasFilesystemPathCandidate(outsideAuthorityUris);
  return {
    authorityProjectionSignature: authorityProjectionSignature(value),
    authorityProjectionRequired: authorityProjected !== value,
    failClosed,
    secretProjectionRequired: !failClosed && (
      patternMatches(PREFIXED_SECRET, value)
      || patternMatches(JWT, value)
      || patternMatches(PRIVATE_KEY, value)
      || patternMatches(LONG_OPAQUE_VALUE, value)
    ),
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

function representationContainsSensitiveCredential(value: string): boolean {
  const authorityRanges = authorityUriTokenRanges(value);
  const sensitiveAuthority = authorityRanges.some((range) => {
    const parsed = parsedAuthorityUri(value.slice(range.start, range.end));
    return Boolean(
      parsed
      && (parsed.username || parsed.password || suspiciousHostname(parsed.hostname)),
    );
  });
  return sensitiveAuthority
    || patternMatches(CREDENTIAL_ASSIGNMENT, value)
    || patternMatches(CAMEL_CASE_CREDENTIAL_ASSIGNMENT, value)
    || hasConcatenatedPassAssignment(value)
    || patternMatches(AUTHORIZATION_VALUE, value)
    || patternMatches(PREFIXED_SECRET, value)
    || patternMatches(JWT, value)
    || patternMatches(PRIVATE_KEY, value)
    || patternMatches(LONG_OPAQUE_VALUE, value)
    || patternMatches(TRAILING_SECRET_FRAGMENT, value);
}

/**
 * Classifies visible page text for local screenshot preflight without treating
 * ordinary URL/path projection as a credential. Malformed, oversized, or
 * over-depth representations still fail closed before bitmap capture.
 */
export function browserEvidenceTextContainsSensitiveCredential(
  value: unknown,
  maximum = MAX_BROWSER_EVIDENCE_TEXT_CHARS,
): boolean {
  const limit = Math.max(1, Math.min(Math.trunc(maximum), MAX_BROWSER_EVIDENCE_TEXT_CHARS));
  if (typeof value !== "string" || value.length > limit) return true;
  const representations = boundedInspectionRepresentations(
    value,
    Math.max(limit + 4_096, 4_096),
  );
  return representations === null
    || representations.some(representationContainsSensitiveCredential);
}

/**
 * Classifies a bounded semantic field name independently from its associated
 * value. Screenshot preflight uses this only when the same element also has a
 * nonempty value, so ordinary prose remains readable while credential fields
 * fail closed even when their short values are not recognizable secrets.
 */
export function browserEvidenceFieldNameIsSensitiveCredential(
  value: unknown,
  maximum = MAX_BROWSER_EVIDENCE_TEXT_CHARS,
): boolean {
  const limit = Math.max(1, Math.min(Math.trunc(maximum), MAX_BROWSER_EVIDENCE_TEXT_CHARS));
  if (typeof value !== "string" || value.length > limit) return true;
  if (!/\S/u.test(value)) return false;
  const representations = boundedInspectionRepresentations(
    value,
    Math.max(limit + 4_096, 4_096),
  );
  return representations === null || representations.some((representation) => {
    const assigned = `${representation}=x`;
    return patternMatches(SENSITIVE_FIELD, representation)
      || patternMatches(CAMEL_CASE_CREDENTIAL_ASSIGNMENT, assigned)
      || hasConcatenatedPassAssignment(assigned);
  });
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
  const ranges = authorityUriTokenRanges(value);
  if (ranges.length === 0) return { value, redacted };
  let replaced = "";
  let copiedUntil = 0;
  for (const range of ranges) {
    replaced += value.slice(copiedUntil, range.start);
    const match = value.slice(range.start, range.end);
    const url = parsedAuthorityUri(match);
    if (!url || url.password || !url.hostname || suspiciousHostname(url.hostname)) {
      redacted = true;
      replaced += "<redacted-url>";
      copiedUntil = range.end;
      continue;
    }
    const directHttp = url.protocol === "http:" || url.protocol === "https:";
    if (directHttp) {
      replaced += match;
    } else {
      redacted = true;
      const protocol = match.startsWith("//") ? "" : url.protocol;
      replaced += `${protocol}//${url.host}`;
    }
    copiedUntil = range.end;
  }
  return { value: replaced + value.slice(copiedUntil), redacted };
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
