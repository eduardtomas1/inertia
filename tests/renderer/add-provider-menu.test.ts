import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import {
  addProviderFooter,
  addProviderMenuItems,
  addProviderNote,
  nextAddProviderMenuIndex,
} from "../../src/renderer/src/components/settings/addProviderMenuModel";

function provider(id: ProviderInfo["id"], authState: ProviderInfo["authState"], canRun: boolean): ProviderInfo {
  const metadata = {
    freshness: "unavailable" as const,
    provenance: null,
    updatedAt: null,
    lastAttemptedAt: null,
    refreshing: false,
  };
  return {
    id,
    label: id,
    command: id,
    available: true,
    version: "1.0.0",
    installState: "installed",
    authState,
    canRun,
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

describe("add provider menu", () => {
  it("lists every supported provider and keeps arrow keys on the two-column grid", () => {
    expect(addProviderMenuItems([]).map(({ id, label, stateLabel }) => [id, label, stateLabel])).toEqual([
      ["codex", "Codex", "Not detected"],
      ["claude", "Claude", "Not detected"],
      ["cursor", "Cursor", "Not detected"],
      ["grok", "Grok", "Not detected"],
      ["opencode", "OpenCode", "Not detected"],
      ["antigravity", "Antigravity", "Not detected"],
      ["kimi", "Kimi Code", "Not detected"],
    ]);
    expect(nextAddProviderMenuIndex(0, "ArrowRight", 6, 2)).toBe(1);
    expect(nextAddProviderMenuIndex(0, "ArrowDown", 6, 2)).toBe(2);
    expect(nextAddProviderMenuIndex(1, "ArrowDown", 6, 2)).toBe(3);
    expect(nextAddProviderMenuIndex(5, "ArrowDown", 6, 2)).toBe(5);
    expect(nextAddProviderMenuIndex(4, "ArrowDown", 6, 1)).toBe(5);
    expect(nextAddProviderMenuIndex(3, "Home", 6, 2)).toBe(0);
    expect(nextAddProviderMenuIndex(0, "End", 6, 2)).toBe(5);
    expect(nextAddProviderMenuIndex(0, "Enter", 6, 2)).toBeNull();
  });

  it("offers ChatGPT for a signed-out Codex and an API key once that account is ready", () => {
    const signedOut = provider("codex", "unauthenticated", false);
    const ready = provider("codex", "authenticated", true);
    expect(addProviderNote("codex", signedOut).text).toContain("ChatGPT account");
    expect(addProviderNote("codex", signedOut).more).toContain("one Codex installation");
    expect(addProviderNote("codex", ready).text).toContain("already signed in");
    expect(addProviderFooter({
      step: 0,
      providerId: "codex",
      provider: signedOut,
      route: "account",
      claudeMethod: "account",
    }).map(({ label }) => label)).toEqual(["Cancel", "Configure manually", "Continue with ChatGPT"]);
    expect(addProviderFooter({
      step: 0,
      providerId: "codex",
      provider: ready,
      route: "account",
      claudeMethod: "account",
    }).map(({ label }) => label)).toEqual(["Cancel", "Configure manually", "Add API key"]);
    expect(addProviderFooter({
      step: 0,
      providerId: "claude",
      provider: provider("claude", "unauthenticated", false),
      route: "account",
      claudeMethod: "account",
    }).map(({ label }) => label)).toEqual(["Cancel", "Next"]);
    const grok = provider("grok", "unauthenticated", false);
    expect(addProviderNote("grok", grok).text).toContain("grok login");
    expect(addProviderNote("grok", grok).text).not.toContain("Kimi");
    expect(addProviderFooter({
      step: 2,
      providerId: "grok",
      provider: grok,
      route: "account",
      claudeMethod: "account",
    }).map(({ label }) => label)).toEqual(["Back", "Sign in through Grok"]);
    expect(addProviderFooter({
      step: 2,
      providerId: "grok",
      provider: provider("grok", "unknown", true),
      route: "account",
      claudeMethod: "account",
    }).at(-1)?.label).toBe("Sign in through Grok");
    expect(addProviderFooter({
      step: 2,
      providerId: "grok",
      provider: provider("grok", "authenticated", true),
      route: "account",
      claudeMethod: "account",
    }).at(-1)?.label).toBe("Done");
  });

  it("keeps the config step on the route the account step chose", () => {
    const claude = provider("claude", "unauthenticated", false);
    expect(addProviderFooter({
      step: 2,
      providerId: "claude",
      provider: claude,
      route: "account",
      claudeMethod: "console",
    }).map(({ label }) => label)).toEqual(["Back", "Sign in for API billing"]);
    expect(addProviderFooter({
      step: 2,
      providerId: "claude",
      provider: claude,
      route: "api-key",
      claudeMethod: "account",
    }).map(({ label }) => label)).toEqual(["Back", "Add API key"]);
    expect(addProviderFooter({
      step: 2,
      providerId: "cursor",
      provider: provider("cursor", "authenticated", true),
      route: "api-key",
      claudeMethod: "account",
    }).at(-1)?.label).toBe("Done");
  });
});
