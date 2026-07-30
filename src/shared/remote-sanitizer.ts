const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk|api|key|token)[-_][A-Za-z0-9_-]{12,}\b/giu,
  /\b(?:ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\b(Bearer|Basic)\s+\S+/giu,
] as const;

const UNIX_ABSOLUTE_PATH =
  /(^|[\s("'`])\/(?:Users|home|private|tmp|var|opt|run|etc|Volumes)(?:\/[^\s"'`),;:]+)+/gmu;
const WINDOWS_ABSOLUTE_PATH =
  /\b[A-Za-z]:\\(?:[^\\\s"'`]+\\)*[^\\\s"'`),;:]*/gu;
const CREDENTIAL_URL =
  /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s@]+)@/giu;
const CODE_FENCE = /```[\s\S]*?```/gu;
const HTML_BLOCK = /<([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gu;
const DIRECTIONAL_FORMATTING =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]+/gu;

/**
 * Remote Companion deliberately omits code/source blocks, absolute paths,
 * credentials, and URL user-info. The result is still untrusted text and the
 * web client must render it through its strict Markdown allowlist.
 */
export function sanitizeRemoteContent(
  value: string,
  maximumCharacters = 64 * 1024,
): string {
  let text = value
    .replace(CODE_FENCE, "[Code omitted on Remote Companion]")
    .replace(HTML_BLOCK, "[HTML omitted on Remote Companion]")
    .replace(CREDENTIAL_URL, "$1<redacted>@")
    .replace(UNIX_ABSOLUTE_PATH, "$1<local-path>")
    .replace(WINDOWS_ABSOLUTE_PATH, "<local-path>");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) =>
      /^(Bearer|Basic)\s/iu.test(match)
        ? `${match.split(/\s/u)[0]} <redacted>`
        : "<redacted-secret>");
  }
  return text.slice(0, maximumCharacters);
}

export function sanitizeRemoteLabel(
  value: string | null | undefined,
  maximumCharacters = 240,
): string | null {
  if (typeof value !== "string") return null;
  const text = sanitizeRemoteContent(
    value.normalize("NFKC"),
    maximumCharacters,
  )
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(DIRECTIONAL_FORMATTING, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text || null;
}
