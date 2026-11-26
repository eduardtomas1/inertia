import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

import {
  providerAuthBrowserUrl,
  providerAuthBrowserUrlFromTerminal,
} from "../../src/renderer/src/utils/providerAuthBrowser";

const AUTH_URL = "https://claude.com/cai/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge";
const ANTIGRAVITY_LOOPBACK_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Foauth2callback&state=fixture-state";
const ANTIGRAVITY_IPV4_URL =
  "https://accounts.google.com/o/oauth2/auth?client_id=fixture&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback&state=fixture-state";
const ANTIGRAVITY_WEB_REDIRECT_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth%2Fcallback&state=fixture-state";
const terminals: Terminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

describe("provider authentication browser links", () => {
  it("allows only bounded HTTPS authorization endpoints owned by Claude", () => {
    expect(providerAuthBrowserUrl("claude", AUTH_URL)).toBe(AUTH_URL);
    expect(providerAuthBrowserUrl("claude", "https://platform.claude.com/oauth/authorize?state=fixture"))
      .toBe("https://platform.claude.com/oauth/authorize?state=fixture");
    expect(providerAuthBrowserUrl("claude", "https://claude.com/cai/oauth/authorize?state=fixture"))
      .toBe("https://claude.com/cai/oauth/authorize?state=fixture");
    expect(providerAuthBrowserUrl("codex", AUTH_URL)).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", AUTH_URL)).toBeNull();
    expect(providerAuthBrowserUrl("claude", ANTIGRAVITY_LOOPBACK_URL)).toBeNull();
    expect(providerAuthBrowserUrl("claude", "http://claude.com/oauth/authorize?state=fixture"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com.evil.test/oauth/authorize?state=fixture"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com/account?state=fixture"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com/oauth/authorize?state=fixture"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://user@claude.com/cai/oauth/authorize?state=fixture"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com:444/cai/oauth/authorize?state=fixture"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com/cai/oauth/authorize?state=fixture#redirect"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com/cai/oauth/authorize"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fevil.test%2Fcallback&state=fixture"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=fixture"))
      .not.toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A49152%2Fcallback&state=fixture"))
      .not.toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&state=fixture"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback&state=fixture"))
      .toBeNull();
    expect(providerAuthBrowserUrl("claude", `https://claude.com/cai/oauth/authorize?state=${"x".repeat(4_096)}`))
      .toBeNull();
  });

  it("allows only official Google OAuth endpoints with strict redirect_uri for Antigravity", () => {
    expect(providerAuthBrowserUrl("antigravity", ANTIGRAVITY_LOOPBACK_URL)).toBe(ANTIGRAVITY_LOOPBACK_URL);
    expect(providerAuthBrowserUrl("antigravity", ANTIGRAVITY_IPV4_URL)).toBe(ANTIGRAVITY_IPV4_URL);
    expect(providerAuthBrowserUrl("antigravity", ANTIGRAVITY_WEB_REDIRECT_URL)).toBe(ANTIGRAVITY_WEB_REDIRECT_URL);

    // Wrong provider or scheme/host/path
    expect(providerAuthBrowserUrl("codex", ANTIGRAVITY_LOOPBACK_URL)).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "http://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com.evil.test/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com:444/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/signin?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb")).toBeNull();

    // Missing, duplicate, or untrusted redirect_uri
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth?state=fixture")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", `${ANTIGRAVITY_LOOPBACK_URL}&redirect_uri=https%3A%2F%2Fevil.test%2Fcb`)).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fevil.test%2Fcb&state=fixture")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%2Fcb&state=fixture")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb&state=fixture")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google.evil.test%2Fcb&state=fixture")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%3A444%2Fcb&state=fixture")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Fuser%3Apass%40localhost%3A8085%2Fcb&state=fixture")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb%3Fleak%3D1&state=fixture")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb%23frag&state=fixture")).toBeNull();

    // Credentials, fragment, and oversized URL rejection
    expect(providerAuthBrowserUrl("antigravity", "https://user@accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb")).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", `${ANTIGRAVITY_LOOPBACK_URL}#fragment`)).toBeNull();
    expect(providerAuthBrowserUrl("antigravity", `${ANTIGRAVITY_LOOPBACK_URL}&pad=${"x".repeat(4_096)}`)).toBeNull();
  });

  it("extracts a soft-wrapped Antigravity Google OAuth link from terminal output while ignoring malicious links", async () => {
    const terminal = new Terminal({ cols: 48, rows: 10, allowProposedApi: false });
    terminals.push(terminal);
    const write = async (data: string): Promise<string | null> => {
      await new Promise<void>((resolve) => terminal.write(data, resolve));
      return providerAuthBrowserUrlFromTerminal("antigravity", terminal);
    };

    expect(await write("Ignore https://evil.test/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb\r\n")).toBeNull();
    const split = ANTIGRAVITY_LOOPBACK_URL.indexOf("redirect_uri=");
    expect(await write(`Sign in: ${ANTIGRAVITY_LOOPBACK_URL.slice(0, split)}`)).toBeNull();
    expect(await write(`${ANTIGRAVITY_LOOPBACK_URL.slice(split)}\r\n`)).toBe(ANTIGRAVITY_LOOPBACK_URL);
  });
});
