import { describe, expect, it } from "vitest";

import {
  ProviderAuthBrowserUrlDetector,
  providerAuthBrowserUrl,
} from "../../src/renderer/src/utils/providerAuthBrowser";

const AUTH_URL = "https://claude.com/cai/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge";
const GEMINI_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_STATE = "a".repeat(64);
const GEMINI_CODE_CHALLENGE = "b".repeat(43);
const GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

function geminiAuthUrl(
  redirectUri = "https://codeassist.google.com/authcode",
): string {
  const parameters = new URLSearchParams({
    access_type: "offline",
    client_id: GEMINI_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GEMINI_SCOPES.join(" "),
    state: GEMINI_STATE,
  });
  if (redirectUri === "https://codeassist.google.com/authcode") {
    parameters.set("code_challenge", GEMINI_CODE_CHALLENGE);
    parameters.set("code_challenge_method", "S256");
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${parameters.toString()}`;
}

function geminiAuthUrlWith(
  mutate: (url: URL) => void,
  redirectUri?: string,
): string {
  const url = new URL(geminiAuthUrl(redirectUri));
  mutate(url);
  return url.toString();
}

describe("provider authentication browser links", () => {
  it("reassembles Claude's official authorization URL across PTY chunks", () => {
    const detector = new ProviderAuthBrowserUrlDetector("claude");

    expect(detector.push("If the browser didn't open, visit: https://claude.com/cai/oauth/auth"))
      .toBeNull();
    expect(detector.push("orize?client_id=fixture&response_type=code&state=fixture"))
      .toBeNull();
    expect(detector.push("-state&code_challenge=fixture-challenge"))
      .toBeNull();
    expect(detector.push("\r\n"))
      .toBe(AUTH_URL);
  });

  it("reassembles Gemini's official manual OAuth URL across PTY chunks", () => {
    const detector = new ProviderAuthBrowserUrlDetector("gemini");
    const authUrl = geminiAuthUrl();
    const first = authUrl.indexOf("redirect_uri");
    const second = authUrl.indexOf("scope");

    expect(detector.push(`Please visit the following URL:\r\n\r\n${authUrl.slice(0, first)}`))
      .toBeNull();
    expect(detector.push(authUrl.slice(first, second))).toBeNull();
    expect(detector.push(authUrl.slice(second))).toBeNull();
    expect(detector.push("\r\n\r\n")).toBe(authUrl);
  });

  it("allows only bounded HTTPS authorization endpoints owned by Claude", () => {
    expect(providerAuthBrowserUrl("claude", AUTH_URL)).toBe(AUTH_URL);
    expect(providerAuthBrowserUrl("claude", "https://platform.claude.com/oauth/authorize?state=fixture"))
      .toBe("https://platform.claude.com/oauth/authorize?state=fixture");
    expect(providerAuthBrowserUrl("claude", "https://claude.com/cai/oauth/authorize?state=fixture"))
      .toBe("https://claude.com/cai/oauth/authorize?state=fixture");
    expect(providerAuthBrowserUrl("codex", AUTH_URL)).toBeNull();
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

  it("allows only Gemini CLI's exact Google OAuth endpoints and redirects", () => {
    const manual = geminiAuthUrl();
    const loopback = geminiAuthUrl("http://127.0.0.1:49152/oauth2callback");

    expect(providerAuthBrowserUrl("gemini", manual)).toBe(manual);
    expect(providerAuthBrowserUrl("gemini", loopback)).toBe(loopback);
    expect(providerAuthBrowserUrl("claude", manual)).toBeNull();
    expect(providerAuthBrowserUrl("codex", manual)).toBeNull();

    const hostile = [
      manual.replace("https://accounts.google.com", "http://accounts.google.com"),
      manual.replace("accounts.google.com", "accounts.google.com.evil.test"),
      manual.replace("/o/oauth2/v2/auth", "/signin/oauth"),
      manual.replace("https://accounts.google.com", "https://user@accounts.google.com"),
      manual.replace("https://accounts.google.com", "https://accounts.google.com:444"),
      `${manual}#redirect`,
      geminiAuthUrlWith((url) => url.searchParams.set("client_id", "attacker.apps.googleusercontent.com")),
      geminiAuthUrlWith((url) => url.searchParams.append("client_id", GEMINI_CLIENT_ID)),
      geminiAuthUrlWith((url) => url.searchParams.set("redirect_uri", "https://evil.test/callback")),
      geminiAuthUrlWith((url) => url.searchParams.append("redirect_uri", "https://codeassist.google.com/authcode")),
      geminiAuthUrlWith((url) => url.searchParams.set("state", "predictable")),
      geminiAuthUrlWith((url) => url.searchParams.set("state", GEMINI_STATE.toUpperCase())),
      geminiAuthUrlWith((url) => url.searchParams.set("response_type", "token")),
      geminiAuthUrlWith((url) => url.searchParams.append("response_type", "code")),
      geminiAuthUrlWith((url) => url.searchParams.delete("code_challenge")),
      geminiAuthUrlWith((url) => url.searchParams.set("code_challenge_method", "plain")),
      geminiAuthUrlWith((url) => url.searchParams.set("scope", `${GEMINI_SCOPES.join(" ")} https://evil.test/scope`)),
      geminiAuthUrlWith((url) => url.searchParams.set("prompt", "consent")),
      geminiAuthUrl("http://localhost:49152/oauth2callback"),
      geminiAuthUrl("http://127.0.0.1/oauth2callback"),
      geminiAuthUrl("http://127.0.0.1:49152/callback"),
      geminiAuthUrlWith(
        (url) => url.searchParams.set("code_challenge", GEMINI_CODE_CHALLENGE),
        "http://127.0.0.1:49152/oauth2callback",
      ),
      geminiAuthUrlWith((url) => url.searchParams.delete("scope")),
      `https://accounts.google.com/o/oauth2/v2/auth?state=${GEMINI_STATE}`,
      `https://accounts.google.com/o/oauth2/v2/auth?state=${"x".repeat(4_096)}`,
    ];
    for (const value of hostile) {
      expect(providerAuthBrowserUrl("gemini", value), value).toBeNull();
    }
  });

  it("ignores hostile output and can clear a cancelled login attempt", () => {
    const detector = new ProviderAuthBrowserUrlDetector("claude");

    expect(detector.push("Open javascript:alert(1) or https://evil.test/oauth/authorize?state=fixture"))
      .toBeNull();
    expect(detector.push("https://claude.com/cai/oauth/auth")).toBeNull();
    detector.clear();
    expect(detector.push("orize?state=cancelled")).toBeNull();

    const geminiDetector = new ProviderAuthBrowserUrlDetector("gemini");
    expect(geminiDetector.push(
      "Open https://accounts.google.com.evil.test/o/oauth2/v2/auth?state=fixture\r\n",
    )).toBeNull();
    const geminiUrl = geminiAuthUrl();
    expect(geminiDetector.push(geminiUrl.slice(0, -10))).toBeNull();
    geminiDetector.clear();
    expect(geminiDetector.push(`${geminiUrl.slice(-10)}\r\n`)).toBeNull();
  });
});
