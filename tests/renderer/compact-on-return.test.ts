import { describe, expect, it } from "vitest";

import {
  compactOnReturnChatState,
  compactOnReturnRoute,
  compactOnReturnTooltip,
  promptCacheStatus,
} from "../../src/renderer/src/utils/compactOnReturn";
import { compactTokenCount } from "../../src/renderer/src/utils/usageDisplay";
import { compactOnReturnEligibility } from "../../src/shared/compact-on-return";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const claudeNative = providerNativeModelSelection({
  providerId: "claude",
  modelId: "provider-default",
  reasoningEffort: null,
});
const codexNative = providerNativeModelSelection({
  providerId: "codex",
  modelId: "provider-default",
  reasoningEffort: null,
});

function profile(overrides: Record<string, unknown>) {
  return {
    id: "custom:route",
    preset: "anthropic-api-key",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    routeKind: "api-key",
    ...overrides,
  } as Parameters<typeof compactOnReturnRoute>[0]["profile"];
}

describe("compact on return route", () => {
  it("treats native Claude as eligible only with a Console API key", () => {
    const consoleKey = compactOnReturnRoute({
      selection: claudeNative,
      profile: undefined,
      provider: { accountKind: "Console API key" },
    });
    expect(consoleKey).toMatchObject({ preset: "native", routeKind: "account", accountKind: "Console API key" });
    expect(compactOnReturnEligibility(consoleKey!)).toEqual({ eligible: true, lifetimeMs: 300_000 });

    const account = compactOnReturnRoute({
      selection: claudeNative,
      profile: undefined,
      provider: { accountKind: "Claude account" },
    });
    expect(compactOnReturnEligibility(account!).eligible).toBe(false);
  });

  it("keeps native Codex and ChatGPT accounts quiet", () => {
    const route = compactOnReturnRoute({
      selection: codexNative,
      profile: undefined,
      provider: { accountKind: "ChatGPT account" },
    });
    expect(compactOnReturnEligibility(route!).eligible).toBe(false);
  });

  it("uses the profile's prompt cache length on the Anthropic preset", () => {
    const selection = { ...claudeNative, backendProfileId: "custom:route" };
    const fiveMinutes = compactOnReturnRoute({ selection, profile: profile({}), provider: undefined });
    const oneHour = compactOnReturnRoute({ selection, profile: profile({ promptCacheTtl: "1h" }), provider: undefined });
    expect(compactOnReturnEligibility(fiveMinutes!).lifetimeMs).toBe(300_000);
    expect(compactOnReturnEligibility(oneHour!).lifetimeMs).toBe(3_600_000);
  });

  it("offers Codex on an OpenAI API key a 30-minute cache and refuses Kimi and custom gateways", () => {
    const selection = { ...codexNative, backendProfileId: "custom:route" };
    const openai = compactOnReturnRoute({
      selection,
      profile: profile({ preset: "openai-api-key", harnessId: "codex-app-server", protocol: "openai-responses" }),
      provider: undefined,
    });
    expect(compactOnReturnEligibility(openai!)).toEqual({ eligible: true, lifetimeMs: 1_800_000 });
    for (const preset of ["kimi-code", "custom"]) {
      const route = compactOnReturnRoute({
        selection: { ...claudeNative, backendProfileId: "custom:route" },
        profile: profile({ preset }),
        provider: undefined,
      });
      expect(compactOnReturnEligibility(route!).eligible).toBe(false);
    }
  });

  it("has no route when the selected profile is missing", () => {
    expect(compactOnReturnRoute({
      selection: { ...claudeNative, backendProfileId: "custom:gone" },
      profile: undefined,
      provider: { accountKind: "Console API key" },
    })).toBeNull();
  });
});

describe("compact on return copy", () => {
  it("formats token counts like the usage meter", () => {
    expect(compactTokenCount(252_000)).toBe("252K");
    expect(compactTokenCount(18_300)).toBe("18.3K");
    expect(compactOnReturnTooltip(252_413)).toBe("Summarize 252.4K tokens of history, then send");
  });

  it("describes a warm and an expired prompt cache in minutes", () => {
    const start = Date.parse("2026-10-25T10:00:00.000Z");
    const facts = { lastRequestStartedAt: "2026-10-25T10:00:00.000Z", lifetimeMs: 300_000 };
    expect(promptCacheStatus(facts, start + 60_000)).toBe("Cache warm, expires in 4 min");
    expect(promptCacheStatus(facts, start + 4 * 60_000 + 30_000)).toBe("Cache warm, expires in 1 min");
    expect(promptCacheStatus(facts, start + 5 * 60_000 + 20_000)).toBe("Cache expired just now");
    expect(promptCacheStatus(facts, start + 17 * 60_000)).toBe("Cache expired 12 min ago");
    expect(promptCacheStatus(facts, start + 3 * 3_600_000)).toBe("Cache expired 3 hr ago");
  });

  it("stays quiet without a request time or lifetime", () => {
    expect(promptCacheStatus({ lastRequestStartedAt: null, lifetimeMs: 300_000 }, Date.now())).toBeNull();
    expect(promptCacheStatus({ lastRequestStartedAt: "2026-10-25T10:00:00.000Z", lifetimeMs: null }, Date.now())).toBeNull();
  });
});

describe("compact on return chat state", () => {
  const shell = (id: string, compaction?: object) => ({ id, ...(compaction ? { compaction } : {}) });

  it("reads the compaction state from the chat shell and recognises watcher chats", () => {
    const compacting = { state: "compacting", trigger: "on-return", startedAt: "2026-10-25T10:20:00.000Z" };
    const snapshot = {
      conversations: [shell("watched"), shell("watcher"), shell("busy", compacting)],
      watchers: [{ watcherConversationId: "watcher", watchedConversationId: "watched", status: "active" }],
    } as unknown as Parameters<typeof compactOnReturnChatState>[0];
    expect(compactOnReturnChatState(snapshot, "busy")).toEqual({ compaction: compacting, watcherChat: false });
    expect(compactOnReturnChatState(snapshot, "watcher")).toEqual({ compaction: null, watcherChat: true });
    expect(compactOnReturnChatState(snapshot, "watched")).toEqual({ compaction: null, watcherChat: false });
    expect(compactOnReturnChatState(null, "busy")).toEqual({ compaction: null, watcherChat: false });
  });
});
