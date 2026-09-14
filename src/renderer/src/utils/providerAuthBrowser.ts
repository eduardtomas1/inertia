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
    providerId !== "claude"
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
  if (providerId !== "claude") return null;
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
