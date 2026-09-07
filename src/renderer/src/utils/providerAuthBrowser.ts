import type { Terminal } from "@xterm/xterm";
import type { ProviderId } from "@shared/contracts";

const MAX_PROVIDER_AUTH_URL_LENGTH = 4_096;
const PROVIDER_AUTH_SCAN_LENGTH = MAX_PROVIDER_AUTH_URL_LENGTH * 2;
// The cursor may still be in the middle of a query string. Require a printed
// delimiter instead of opening a syntactically valid but truncated URL.
const COMPLETE_HTTPS_URL_PATTERN =
  /https:\/\/[^\s\u0000-\u001f\u007f]+(?=[\s\u0000-\u001f\u007f])/gu;

const CLAUDE_AUTH_ENDPOINTS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    "https://claude.com": new Set(["/cai/oauth/authorize"]),
    "https://platform.claude.com": new Set(["/oauth/authorize"]),
  });
const CLAUDE_MANUAL_REDIRECT_URL =
  "https://platform.claude.com/oauth/code/callback";
const GEMINI_AUTH_ORIGIN = "https://accounts.google.com";
const GEMINI_AUTH_PATH = "/o/oauth2/v2/auth";
const GEMINI_OAUTH_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_MANUAL_REDIRECT_URL = "https://codeassist.google.com/authcode";
const GEMINI_OAUTH_SCOPES = new Set([
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);
const GEMINI_LOOPBACK_AUTH_PARAMETERS = new Set([
  "access_type",
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
]);
const GEMINI_MANUAL_AUTH_PARAMETERS = new Set([
  ...GEMINI_LOOPBACK_AUTH_PARAMETERS,
  "code_challenge",
  "code_challenge_method",
]);

function isClaudeRedirectUri(value: string): boolean {
  if (value === CLAUDE_MANUAL_REDIRECT_URL) return true;
  try {
    const redirect = new URL(value);
    return redirect.protocol === "http:"
      && redirect.hostname === "localhost"
      && redirect.port !== ""
      && redirect.pathname === "/callback"
      && !redirect.username
      && !redirect.password
      && !redirect.search
      && !redirect.hash;
  } catch {
    return false;
  }
}

function hasSingleParameter(
  url: URL,
  name: string,
  expected?: string,
): boolean {
  const values = url.searchParams.getAll(name);
  return values.length === 1
    && values[0] !== ""
    && (expected === undefined || values[0] === expected);
}

function hasOnlyParameters(url: URL, expected: ReadonlySet<string>): boolean {
  const names = [...url.searchParams.keys()];
  return names.length === expected.size
    && names.every((name) => expected.has(name));
}

function isGeminiLoopbackRedirectUri(value: string): boolean {
  try {
    const redirect = new URL(value);
    return redirect.protocol === "http:"
      && redirect.hostname === "127.0.0.1"
      && redirect.port !== ""
      && Number.isSafeInteger(Number(redirect.port))
      && Number(redirect.port) > 0
      && Number(redirect.port) <= 65_535
      && redirect.pathname === "/oauth2callback"
      && !redirect.username
      && !redirect.password
      && !redirect.search
      && !redirect.hash;
  } catch {
    return false;
  }
}

function isGeminiAuthUrl(url: URL): boolean {
  if (
    url.origin.toLowerCase() !== GEMINI_AUTH_ORIGIN
    || url.pathname !== GEMINI_AUTH_PATH
    || !hasSingleParameter(url, "client_id", GEMINI_OAUTH_CLIENT_ID)
    || !hasSingleParameter(url, "response_type", "code")
    || !hasSingleParameter(url, "access_type", "offline")
    || !hasSingleParameter(url, "state")
    || !/^[0-9a-f]{64}$/u.test(url.searchParams.get("state") ?? "")
    || !hasSingleParameter(url, "scope")
  ) return false;

  const scopes = new Set((url.searchParams.get("scope") ?? "").split(" "));
  if (
    scopes.size !== GEMINI_OAUTH_SCOPES.size
    || [...GEMINI_OAUTH_SCOPES].some((scope) => !scopes.has(scope))
  ) return false;

  const redirectUris = url.searchParams.getAll("redirect_uri");
  if (redirectUris.length !== 1) return false;
  const redirectUri = redirectUris[0]!;
  if (redirectUri === GEMINI_MANUAL_REDIRECT_URL) {
    return hasSingleParameter(url, "code_challenge")
      && /^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("code_challenge") ?? "")
      && hasSingleParameter(url, "code_challenge_method", "S256")
      && hasOnlyParameters(url, GEMINI_MANUAL_AUTH_PARAMETERS);
  }
  return isGeminiLoopbackRedirectUri(redirectUri)
    && url.searchParams.getAll("code_challenge").length === 0
    && url.searchParams.getAll("code_challenge_method").length === 0
    && hasOnlyParameters(url, GEMINI_LOOPBACK_AUTH_PARAMETERS);
}

/**
 * Accept only the official authorization endpoint for the provider whose
 * owned login flow produced the terminal output. The URL carries ephemeral
 * OAuth state, so callers must keep it in memory and never log or persist it.
 */
export function providerAuthBrowserUrl(
  providerId: ProviderId,
  value: unknown,
): string | null {
  if (
    (providerId !== "claude" && providerId !== "gemini")
    || typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PROVIDER_AUTH_URL_LENGTH
  ) return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.hash
      || !url.search
    ) return null;
    if (providerId === "gemini") {
      return isGeminiAuthUrl(url) ? url.toString() : null;
    }
    const allowedPaths = CLAUDE_AUTH_ENDPOINTS[url.origin.toLowerCase()];
    const redirectUris = url.searchParams.getAll("redirect_uri");
    if (
      !allowedPaths?.has(url.pathname)
      || redirectUris.length > 1
      || (redirectUris[0] !== undefined
        && !isClaudeRedirectUri(redirectUris[0]))
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Read only the bounded text the terminal has actually parsed. ConPTY can
 * insert cursor/style controls inside a URL: scanning raw PTY bytes misses
 * those links, or treats an escape as the end of an incomplete query. xterm
 * already owns VT parsing, cursor edits, hidden OSC payloads, and soft wraps.
 * Call after a terminal.write callback, never before its data has been parsed.
 */
export function providerAuthBrowserUrlFromTerminal(
  providerId: ProviderId,
  terminal: Pick<Terminal, "buffer" | "cols">,
): string | null {
  if (providerId !== "claude" && providerId !== "gemini") return null;
  const buffer = terminal.buffer.active;
  const cursorRow = Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY);
  let text = "";
  let separator = "";
  for (let row = cursorRow, scanned = 0;
    row >= 0 && scanned < PROVIDER_AUTH_SCAN_LENGTH && text.length < PROVIDER_AUTH_SCAN_LENGTH;
    row -= 1, scanned += 1) {
    const line = buffer.getLine(row);
    if (!line) break;
    // Padding beyond the cursor is not a printed URL delimiter. Conversely,
    // spaces explicitly written before it (including at a soft wrap) are.
    const endColumn = row === cursorRow ? buffer.cursorX : terminal.cols;
    text = line.translateToString(false, 0, endColumn) + separator + text;
    separator = line.isWrapped ? "" : "\n";
  }
  for (const match of text.slice(-PROVIDER_AUTH_SCAN_LENGTH).matchAll(COMPLETE_HTTPS_URL_PATTERN)) {
    const url = providerAuthBrowserUrl(providerId, match[0]);
    if (url) return url;
  }
  return null;
}
