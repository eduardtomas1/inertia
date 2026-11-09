import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompactOnReturnRoute, PromptCacheFacts } from "../../src/shared/compact-on-return";
import type { IdleCompactionCandidate } from "../../src/server/persistence/idle-compaction-candidate-repository";
import type { IdleCompactionExpectation } from "../../src/server/runtime/commands/conversation-compaction-commands";
import {
  createIdleCompactionScheduler,
  IDLE_COMPACTION_SWEEP_MS,
  MAX_CONCURRENT_IDLE_COMPACTIONS,
  type IdleCompactionSchedulerDependencies,
} from "../../src/server/runtime/idle-compaction-scheduler";

const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const startedAt = Date.parse("2026-11-09T08:00:00.000Z");

const subscription: CompactOnReturnRoute = {
  harnessId: "claude-agent-sdk",
  preset: "native",
  protocol: "anthropic-messages",
  accountKind: "Claude account",
  routeKind: "account",
};

function candidate(
  conversationId: string,
  overrides: { usedTokens?: number; promptCache?: Partial<PromptCacheFacts> } = {},
): IdleCompactionCandidate {
  return {
    conversationId,
    usedTokens: overrides.usedTokens ?? 420_000,
    promptCache: {
      lastRequestStartedAt: new Date(startedAt).toISOString(),
      lifetimeMs: HOUR,
      source: "reported",
      ...overrides.promptCache,
    },
  };
}

function scheduler(options: {
  candidates?: IdleCompactionCandidate[];
  now?: number;
  routes?: Record<string, CompactOnReturnRoute | null>;
  settings?: Partial<ReturnType<IdleCompactionSchedulerDependencies["settings"]>>;
  busy?: string[];
  compact?: IdleCompactionSchedulerDependencies["compact"];
} = {}) {
  const clock = { now: options.now ?? startedAt + HOUR - MINUTE };
  const compact = vi.fn(options.compact ?? (async (_conversationId: string, _expected: IdleCompactionExpectation) => undefined));
  const onFailure = vi.fn();
  const candidates = vi.fn((_input: Parameters<IdleCompactionSchedulerDependencies["candidates"]>[0]) => options.candidates ?? [candidate("chat")]);
  const busyConversations = vi.fn(() => (conversationId: string) => options.busy?.includes(conversationId) ?? false);
  const instance = createIdleCompactionScheduler({
    settings: () => ({ compactOnReturn: "offer", compactBeforeCacheExpires: true, ...options.settings }),
    candidates,
    route: (conversationId) => options.routes && conversationId in options.routes ? options.routes[conversationId]! : subscription,
    busyConversations,
    compact,
    now: () => clock.now,
    onFailure,
  });
  return { instance, compact, onFailure, candidates, busyConversations, clock };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("idle compaction scheduler", () => {
  it("compacts a large Claude chat in the two minutes before its one-hour cache expires and says what it expects to find", async () => {
    const { instance, compact, candidates, clock } = scheduler();
    expect(instance.sweep()).toBe(1);
    await instance.settled();
    expect(compact).toHaveBeenCalledExactlyOnceWith("chat", {
      lastRequestStartedAt: new Date(startedAt).toISOString(),
      closesAt: startedAt + HOUR - 30_000,
      now: expect.any(Function),
    });
    expect(candidates).toHaveBeenCalledExactlyOnceWith({
      startedSince: new Date(clock.now - HOUR + 30_000).toISOString(),
      startedBefore: new Date(clock.now - HOUR + 2 * MINUTE).toISOString(),
      minimumTokens: 200_000,
    });
  });

  it("does nothing unless the setting asks for it", () => {
    for (const settings of [{ compactBeforeCacheExpires: false }, { compactOnReturn: "never" as const }]) {
      const { instance, compact, candidates } = scheduler({ settings });
      expect(instance.sweep()).toBe(0);
      expect(compact).not.toHaveBeenCalled();
      expect(candidates).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["before the window opens", { now: startedAt + HOUR - 3 * MINUTE }],
    ["once the cache is about to expire", { now: startedAt + HOUR - 20_000 }],
    ["after the cache expired", { now: startedAt + HOUR + MINUTE }],
  ])("leaves a chat alone %s", (_case, options) => {
    const { instance, compact } = scheduler(options);
    expect(instance.sweep()).toBe(0);
    expect(compact).not.toHaveBeenCalled();
  });

  it.each([
    ["a chat under 200K tokens", { candidates: [candidate("chat", { usedTokens: 150_000 })] }],
    ["a five-minute cache", { candidates: [candidate("chat", { promptCache: { lifetimeMs: 5 * MINUTE } })], now: startedAt + 4 * MINUTE }],
    ["a chat that is busy", { busy: ["chat"] }],
    ["a Codex chat", { routes: { chat: { harnessId: "codex-app-server", preset: "openai-api-key", protocol: "openai-responses" } } }],
    ["a chat whose Claude sign-in is unknown", { routes: { chat: { ...subscription, accountKind: null } } }],
    ["a chat that no longer exists", { routes: { chat: null } }],
  ])("skips %s", (_case, options) => {
    const { instance, compact } = scheduler(options);
    expect(instance.sweep()).toBe(0);
    expect(compact).not.toHaveBeenCalled();
  });

  it("trusts the subscription's one-hour cache when the lifetime was only assumed", async () => {
    const { instance, compact } = scheduler({ candidates: [candidate("chat", { promptCache: { lifetimeMs: 5 * MINUTE, source: "assumed" } })] });
    expect(instance.sweep()).toBe(1);
    await instance.settled();
    expect(compact).toHaveBeenCalledOnce();
  });

  it("starts chats that are due at the same moment side by side, up to the limit", async () => {
    const releases: Array<() => void> = [];
    const chats = ["a", "b", "c", "d"].map((id) => candidate(id));
    const { instance, compact } = scheduler({
      candidates: chats,
      compact: () => new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
    });
    expect(instance.sweep()).toBe(MAX_CONCURRENT_IDLE_COMPACTIONS);
    await Promise.resolve();
    expect(compact.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
    expect(instance.sweep()).toBe(0);
    releases.shift()!();
    await vi.waitFor(() => expect(instance.sweep()).toBe(1));
    await Promise.resolve();
    expect(compact.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c", "d"]);
    for (const release of releases.splice(0)) release();
    await instance.settled();
  });

  it("tries a chat once per request and again after the chat makes a new request", async () => {
    const candidates = [candidate("chat")];
    const { instance, compact, clock } = scheduler({ candidates, compact: async () => Promise.reject(new Error("Claude could not compact the context.")) });
    instance.sweep();
    await instance.settled();
    instance.sweep();
    await instance.settled();
    expect(compact).toHaveBeenCalledOnce();

    const next = startedAt + 2 * HOUR;
    candidates[0] = candidate("chat", { promptCache: { lastRequestStartedAt: new Date(next).toISOString() } });
    clock.now = next + HOUR - MINUTE;
    instance.sweep();
    await instance.settled();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("reports a failed compaction and still compacts the other chats", async () => {
    const failure = new Error("Claude could not compact the context.");
    const { instance, compact, onFailure } = scheduler({
      candidates: [candidate("first"), candidate("second")],
      compact: async (conversationId) => {
        if (conversationId === "first") throw failure;
      },
    });
    expect(instance.sweep()).toBe(2);
    await instance.settled();
    expect(compact.mock.calls.map(([conversationId]) => conversationId)).toEqual(["first", "second"]);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("first", failure);
  });

  it("reads which chats are busy once per sweep", () => {
    const { instance, busyConversations } = scheduler({ candidates: [candidate("a"), candidate("b")] });
    instance.sweep();
    expect(busyConversations).toHaveBeenCalledOnce();
  });

  it("sweeps on its interval until stopped", async () => {
    vi.useFakeTimers();
    const { instance, candidates } = scheduler({ candidates: [] });
    instance.start();
    await vi.advanceTimersByTimeAsync(IDLE_COMPACTION_SWEEP_MS * 2);
    expect(candidates).toHaveBeenCalledTimes(2);
    instance.stop();
    await vi.advanceTimersByTimeAsync(IDLE_COMPACTION_SWEEP_MS * 2);
    expect(candidates).toHaveBeenCalledTimes(2);
  });
});
