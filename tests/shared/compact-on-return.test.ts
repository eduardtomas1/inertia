import { describe, expect, it } from "vitest";

import {
  COMPACT_ON_RETURN_SETTINGS,
  COMPACT_ON_RETURN_TOKEN_THRESHOLD,
  DEFAULT_COMPACT_ON_RETURN,
  IDLE_CONVERSATION_COMPACTION,
  PROMPT_CACHE_LIFETIMES_MS,
  PROMPT_CACHE_TTLS,
  compactOnReturnEligibility,
  compactOnReturnOffer,
  promptCacheTtlAllowed,
} from "../../src/shared/compact-on-return";

const anthropicKey = { harnessId: "claude-agent-sdk", preset: "anthropic-api-key", protocol: "anthropic-messages" } as const;
const openaiKey = { harnessId: "codex-app-server", preset: "openai-api-key", protocol: "openai-responses" } as const;
const nativeClaude = { harnessId: "claude-agent-sdk", preset: "native", protocol: "anthropic-messages" } as const;
const now = Date.parse("2030-01-01T12:00:00.000Z");
const minutesAgo = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();
const ready = {
  eligible: true,
  lifetimeMs: PROMPT_CACHE_LIFETIMES_MS.anthropic5m,
  usedTokens: COMPACT_ON_RETURN_TOKEN_THRESHOLD,
  lastRequestStartedAt: minutesAgo(5),
  now,
  setting: "offer",
  compactionState: "idle",
  turnActive: false,
} as const;

describe("compact on return constants", () => {
  it("names the documented threshold, lifetimes, settings and cache options", () => {
    expect(COMPACT_ON_RETURN_TOKEN_THRESHOLD).toBe(200_000);
    expect(PROMPT_CACHE_LIFETIMES_MS).toEqual({ anthropic5m: 300_000, anthropic1h: 3_600_000, openai: 1_800_000 });
    expect(COMPACT_ON_RETURN_SETTINGS).toEqual(["offer", "never"]);
    expect(DEFAULT_COMPACT_ON_RETURN).toBe("offer");
    expect(PROMPT_CACHE_TTLS).toEqual(["5m", "1h"]);
    expect(IDLE_CONVERSATION_COMPACTION).toEqual({ state: "idle", trigger: null, startedAt: null });
  });
});

describe("compact on return eligibility", () => {
  it("includes the Anthropic API key preset with the default or longer cache", () => {
    expect(compactOnReturnEligibility(anthropicKey)).toEqual({ eligible: true, lifetimeMs: 300_000 });
    expect(compactOnReturnEligibility({ ...anthropicKey, promptCacheTtl: "5m" })).toEqual({ eligible: true, lifetimeMs: 300_000 });
    expect(compactOnReturnEligibility({ ...anthropicKey, promptCacheTtl: "1h" })).toEqual({ eligible: true, lifetimeMs: 3_600_000 });
    expect(compactOnReturnEligibility({ ...anthropicKey, promptCacheTtl: null, routeKind: "api-key" })).toEqual({ eligible: true, lifetimeMs: 300_000 });
  });

  it("includes the OpenAI API key preset on the Codex harness", () => {
    expect(compactOnReturnEligibility(openaiKey)).toEqual({ eligible: true, lifetimeMs: 1_800_000 });
  });

  it("includes native Claude only on a Console API key", () => {
    expect(compactOnReturnEligibility({ ...nativeClaude, accountKind: "Console API key" })).toEqual({ eligible: true, lifetimeMs: 300_000 });
    expect(compactOnReturnEligibility({ ...nativeClaude, accountKind: "Console API key", promptCacheTtl: "1h" })).toEqual({ eligible: true, lifetimeMs: 3_600_000 });
    expect(compactOnReturnEligibility({ ...nativeClaude, preset: null, routeKind: "account", accountKind: "Console API key" })).toEqual({ eligible: true, lifetimeMs: 300_000 });
    for (const accountKind of ["Claude account", null, undefined]) {
      const result = compactOnReturnEligibility({ ...nativeClaude, accountKind });
      expect(result).toMatchObject({ eligible: false, lifetimeMs: null });
      expect(result.reason).toMatch(/Console API key/u);
    }
  });

  it("excludes Kimi and custom gateways with plain reasons", () => {
    const kimi = compactOnReturnEligibility({ ...anthropicKey, preset: "kimi-code" });
    expect(kimi).toMatchObject({ eligible: false, lifetimeMs: null });
    expect(kimi.reason).toMatch(/Kimi/u);
    for (const route of [{ ...anthropicKey, preset: "custom" }, { ...openaiKey, preset: "custom" }]) {
      const result = compactOnReturnEligibility(route);
      expect(result).toMatchObject({ eligible: false, lifetimeMs: null });
      expect(result.reason).toMatch(/[Cc]ustom gateways/u);
    }
  });

  it("excludes native Codex, CLI harnesses, other providers and mismatched routes", () => {
    for (const route of [
      { harnessId: "codex-app-server", preset: "native", protocol: "openai-responses", accountKind: "OpenAI API key" },
      { ...openaiKey, harnessId: "codex-cli" },
      { ...anthropicKey, harnessId: "claude-cli" },
      { ...nativeClaude, harnessId: "claude-cli", accountKind: "Console API key" },
      { ...anthropicKey, protocol: "openai-responses" },
      { ...openaiKey, protocol: "anthropic-messages" },
      { harnessId: "kimi-acp", preset: "native", protocol: "kimi-managed" },
      { harnessId: "opencode-sdk", preset: "native", protocol: "opencode-native" },
      { harnessId: "cursor-acp", preset: "native", protocol: "cursor-managed" },
      { harnessId: "antigravity-cli", preset: "native", protocol: "antigravity-managed" },
      { ...anthropicKey, preset: null },
      { ...nativeClaude, preset: null, routeKind: "api-key", accountKind: "Console API key" },
    ] as const) {
      const result = compactOnReturnEligibility(route);
      expect(result).toMatchObject({ eligible: false, lifetimeMs: null });
      expect(result.reason?.length).toBeGreaterThan(0);
    }
  });
});

describe("compact on return offer", () => {
  it("offers once the cache lifetime has elapsed on a large eligible chat", () => {
    expect(compactOnReturnOffer(ready)).toEqual({ offer: true, usedTokens: 200_000, idleMs: 300_000 });
    expect(compactOnReturnOffer({ ...ready, lifetimeMs: PROMPT_CACHE_LIFETIMES_MS.openai, lastRequestStartedAt: minutesAgo(31) }))
      .toEqual({ offer: true, usedTokens: 200_000, idleMs: 1_860_000 });
  });

  it("does not offer before the cache expires", () => {
    expect(compactOnReturnOffer({ ...ready, lastRequestStartedAt: minutesAgo(4.99) })).toMatchObject({ offer: false, idleMs: 299_400 });
    expect(compactOnReturnOffer({ ...ready, lifetimeMs: PROMPT_CACHE_LIFETIMES_MS.anthropic1h, lastRequestStartedAt: minutesAgo(59) }).offer).toBe(false);
  });

  it("treats an unknown or unreadable last request as not idle", () => {
    expect(compactOnReturnOffer({ ...ready, lastRequestStartedAt: null })).toEqual({ offer: false, usedTokens: 200_000, idleMs: null });
    expect(compactOnReturnOffer({ ...ready, lastRequestStartedAt: "yesterday" })).toEqual({ offer: false, usedTokens: 200_000, idleMs: null });
  });

  it("clamps a last request in the future to zero idle time", () => {
    expect(compactOnReturnOffer({ ...ready, lastRequestStartedAt: minutesAgo(-1) })).toEqual({ offer: false, usedTokens: 200_000, idleMs: 0 });
  });

  it("does not offer below the threshold or without a reported size", () => {
    expect(compactOnReturnOffer({ ...ready, usedTokens: 199_999 })).toMatchObject({ offer: false, usedTokens: 199_999 });
    expect(compactOnReturnOffer({ ...ready, usedTokens: null })).toMatchObject({ offer: false, usedTokens: null });
  });

  it("respects the setting, eligibility and a missing lifetime", () => {
    expect(compactOnReturnOffer({ ...ready, setting: "never" }).offer).toBe(false);
    expect(compactOnReturnOffer({ ...ready, eligible: false }).offer).toBe(false);
    expect(compactOnReturnOffer({ ...ready, lifetimeMs: null }).offer).toBe(false);
  });

  it("does not offer while a turn or compaction is active", () => {
    expect(compactOnReturnOffer({ ...ready, turnActive: true }).offer).toBe(false);
    expect(compactOnReturnOffer({ ...ready, compactionState: "compacting" }).offer).toBe(false);
  });
});

describe("prompt cache lifetime option", () => {
  it("is available only on the Claude Agent SDK with Anthropic Messages", () => {
    expect(promptCacheTtlAllowed({ harnessId: "claude-agent-sdk", protocol: "anthropic-messages" })).toBe(true);
    expect(promptCacheTtlAllowed({ harnessId: "claude-cli", protocol: "anthropic-messages" })).toBe(false);
    expect(promptCacheTtlAllowed({ harnessId: "codex-app-server", protocol: "openai-responses" })).toBe(false);
    expect(promptCacheTtlAllowed({ harnessId: "claude-agent-sdk", protocol: "openai-responses" })).toBe(false);
  });

  it("is never available on the Kimi preset, which is billed by quota and manages its own context", () => {
    expect(promptCacheTtlAllowed({ harnessId: "claude-agent-sdk", protocol: "anthropic-messages", preset: "kimi-code" })).toBe(false);
    expect(promptCacheTtlAllowed({ harnessId: "claude-agent-sdk", protocol: "anthropic-messages", preset: "anthropic-api-key" })).toBe(true);
    expect(promptCacheTtlAllowed({ harnessId: "claude-agent-sdk", protocol: "anthropic-messages", preset: "custom" })).toBe(true);
  });
});
