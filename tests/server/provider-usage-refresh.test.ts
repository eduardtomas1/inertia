import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claudeRateLimitReadResult } from "../../src/server/provider/claude-agent-sdk-metadata";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import {
  createTurnUsageRefresh,
  startIdleRateLimitRefresh,
  type ProviderUsageRefreshDependencies,
} from "../../src/server/runtime/provider-usage-refresh";

describe("Claude rate-limit availability", () => {
  it("records an explicit unavailable answer instead of keeping stale limits", async () => {
    let answer: Awaited<ReturnType<NonNullable<ConstructorParameters<typeof ProviderMetadataCache>[0]>["read"] & object>> = {
      rateLimits: [{
        id: "claude:five_hour",
        label: "Claude · 5 hour",
        usedPercent: 40,
        remainingPercent: 60,
        windowMinutes: 300,
        resetsAt: null,
      }],
    };
    const cache = new ProviderMetadataCache({ read: async () => answer });
    const refresh = () => cache.metadata("claude", "/tools/claude", {}, "/workspace", {
      fields: ["rateLimits"],
      force: true,
    });
    await refresh();
    expect(cache.current("claude").metadataState.rateLimits.freshness).toBe("fresh");

    answer = claudeRateLimitReadResult({ rate_limits_available: false });
    await refresh();
    const current = cache.current("claude");
    expect(current.rateLimits).toEqual([]);
    expect(current.metadataState.rateLimits.freshness).toBe("unavailable");
    expect(current.metadataState.rateLimits.updatedAt).not.toBeNull();
  });

  it("maps Claude usage answers", () => {
    expect(claudeRateLimitReadResult({ rate_limits_available: false }))
      .toEqual({ rateLimits: [], rateLimitsUnavailable: true });
    expect(claudeRateLimitReadResult({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 25, resets_at: null } },
    })).toEqual({
      rateLimits: [expect.objectContaining({ id: "claude:five_hour", usedPercent: 25 })],
    });
  });
});

type ProviderId = "codex" | "claude" | "cursor" | "gemini" | "kimi" | "opencode";
type State = ReturnType<ProviderUsageRefreshDependencies<string>["cachedState"]>;

function fixture(overrides: Partial<ProviderUsageRefreshDependencies<string>> = {}) {
  const states = new Map<ProviderId, State>();
  const stale = (updatedAt: string | null = "2030-01-01T00:00:00.000Z"): State => ({
    models: { freshness: "stale", updatedAt },
    rateLimits: { freshness: updatedAt ? "stale" : "unavailable", updatedAt },
  });
  const reads: Array<[ProviderId, string[]]> = [];
  const applied: string[] = [];
  let broadcasts = 0;
  const abort = new AbortController();
  const dependencies: ProviderUsageRefreshDependencies<string> = {
    enabled: true,
    signal: abort.signal,
    isClosed: () => false,
    cachedState: (providerId) => states.get(providerId as ProviderId) ?? stale(),
    read: async (providerId, fields) => {
      reads.push([providerId as ProviderId, [...fields]]);
      return `metadata:${providerId}`;
    },
    apply: (_providerId, metadata) => { applied.push(metadata); },
    broadcastSnapshot: () => { broadcasts += 1; },
    isExternalTurn: () => false,
    canRun: () => true,
    activeProviderIds: () => new Set(),
    track: async (operation) => await operation(),
    ...overrides,
  };
  return {
    dependencies,
    states,
    stale,
    reads,
    applied,
    abort,
    broadcasts: () => broadcasts,
  };
}

const turn = (providerId: ProviderId, status: "completed" | "failed" | "cancelled") => ({
  providerId,
  conversationId: "conversation",
  turnId: "turn",
  runStartedAt: Date.parse("2030-01-02T00:00:00.000Z"),
  status,
});

describe("provider usage refresh after a turn", () => {
  it("refreshes rate limits after failed and cancelled turns, and the catalog only after success", async () => {
    const value = fixture();
    const refresh = createTurnUsageRefresh(value.dependencies);
    await refresh(turn("claude", "failed"));
    await refresh(turn("codex", "cancelled"));
    await refresh(turn("claude", "completed"));
    expect(value.reads).toEqual([
      ["claude", ["rateLimits"]],
      ["codex", ["rateLimits"]],
      ["claude", ["models", "rateLimits"]],
    ]);
    expect(value.broadcasts()).toBe(3);
  });

  it("skips external backends, disabled providers and already-current usage", async () => {
    const external = fixture({ isExternalTurn: () => true });
    await createTurnUsageRefresh(external.dependencies)(turn("claude", "failed"));
    expect(external.reads).toEqual([]);

    const disabled = fixture({ enabled: false });
    await createTurnUsageRefresh(disabled.dependencies)(turn("claude", "failed"));
    expect(disabled.reads).toEqual([]);

    const current = fixture();
    current.states.set("claude", {
      models: { freshness: "fresh", updatedAt: "2030-01-03T00:00:00.000Z" },
      rateLimits: { freshness: "fresh", updatedAt: "2030-01-03T00:00:00.000Z" },
    });
    await createTurnUsageRefresh(current.dependencies)(turn("claude", "completed"));
    expect(current.reads).toEqual([]);
  });
});

describe("idle rate-limit refresh", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("refreshes stale usage for idle providers that reported limits before", async () => {
    const value = fixture({
      activeProviderIds: () => new Set(["codex"]),
      now: () => Date.now(),
    });
    value.states.set("claude", value.stale());
    value.states.set("codex", value.stale());
    startIdleRateLimitRefresh(value.dependencies, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.reads).toEqual([["claude", ["rateLimits"]]]);
    expect(value.applied).toEqual(["metadata:claude"]);
    value.abort.abort();
  });

  it("never probes a provider that has not reported limits and backs off after failures", async () => {
    let failures = 0;
    const value = fixture({
      now: () => Date.now(),
      read: async (providerId) => {
        failures += 1;
        throw new Error(`${providerId} unavailable`);
      },
    });
    value.states.set("claude", value.stale());
    value.states.set("codex", value.stale(null));
    startIdleRateLimitRefresh(value.dependencies, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failures).toBe(1);
    // The next attempt waits for the doubled interval.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failures).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failures).toBe(2);
    value.abort.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failures).toBe(2);
  });
});
