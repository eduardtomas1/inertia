import type { ProviderId } from "@shared/contracts";

const MAX_PROVIDER_AUTH_URL_LENGTH = 4_096;
const PROVIDER_AUTH_SCAN_LENGTH = MAX_PROVIDER_AUTH_URL_LENGTH * 2;
// A PTY chunk may end in the middle of the query string. Requiring a stream
// delimiter keeps us from opening a syntactically valid but truncated URL.
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
    const allowedPaths = CLAUDE_AUTH_ENDPOINTS[url.origin.toLowerCase()];
    const redirectUris = url.searchParams.getAll("redirect_uri");
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.hash
      || !url.search
      || !allowedPaths?.has(url.pathname)
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
 * Claude can split its printed OAuth URL across arbitrary PTY chunks. Retain
 * only enough transient tail data to reassemble one bounded URL.
 */
export class ProviderAuthBrowserUrlDetector {
  private buffer = "";

  constructor(private readonly providerId: ProviderId) {}

  push(output: string): string | null {
    this.buffer = `${this.buffer}${output}`.slice(-PROVIDER_AUTH_SCAN_LENGTH);
    for (const match of this.buffer.matchAll(COMPLETE_HTTPS_URL_PATTERN)) {
      const url = providerAuthBrowserUrl(this.providerId, match[0]);
      if (url) return url;
    }
    return null;
  }

  clear(): void {
    this.buffer = "";
  }
}
