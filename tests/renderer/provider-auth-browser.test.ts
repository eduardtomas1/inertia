import { describe, expect, it } from "vitest";

import {
  ProviderAuthBrowserUrlDetector,
  providerAuthBrowserUrl,
} from "../../src/renderer/src/utils/providerAuthBrowser";

const AUTH_URL = "https://claude.com/cai/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge";

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

  it("ignores hostile output and can clear a cancelled login attempt", () => {
    const detector = new ProviderAuthBrowserUrlDetector("claude");

    expect(detector.push("Open javascript:alert(1) or https://evil.test/oauth/authorize?state=fixture"))
      .toBeNull();
    expect(detector.push("https://claude.com/cai/oauth/auth")).toBeNull();
    detector.clear();
    expect(detector.push("orize?state=cancelled")).toBeNull();
  });
});
