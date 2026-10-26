import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claudeRateLimitReadResult } from "../../src/server/provider/claude-agent-sdk-metadata";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import {
  createTurnUsageRefresh,
  IDLE_RATE_LIMIT_REFRESH_INTERVAL_MS,
  RATE_LIMIT_TTL_MS,
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

type ProviderId = "codex" | "claude" | "cursor" | "kimi" | "opencode";
type State = ReturnType<ProviderUsageRefreshDependencies<string>["cachedState"]>;

function fixture(overrides: Partial<ProviderUsageRefreshDependencies<string>> = {}) {
  const states = new Map<ProviderId, State>();
  const stale = (updatedAt: string | null = "2030-01-01T00:00:00.000Z"): State => ({
    metadataState: {
      models: { freshness: "stale", updatedAt },
      rateLimits: { freshness: updatedAt ? "stale" : "unavailable", updatedAt },
    },
    rateLimits: [],
  });
  const fresh = (resetsAt: Array<string | null>, updatedAt = new Date().toISOString()): State => ({
    metadataState: {
      models: { freshness: "fresh", updatedAt },
      rateLimits: { freshness: "fresh", updatedAt },
    },
    rateLimits: resetsAt.map((value) => ({ resetsAt: value })),
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
    fresh,
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
    current.states.set("claude", current.fresh([], "2030-01-03T00:00:00.000Z"));
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

describe("quota read after a reported reset", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const hour = 60 * 60 * 1_000;

  it("reads once about five seconds after the earliest cached reset", async () => {
    const value = fixture({ now: () => Date.now() });
    value.states.set("codex", value.fresh([
      new Date(Date.now() + 90_000).toISOString(),
      new Date(Date.now() + 10_000).toISOString(),
    ]));
    value.states.set("claude", value.fresh([new Date(Date.now() + 3 * hour).toISOString()]));
    startIdleRateLimitRefresh(value.dependencies, hour);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(value.reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(value.reads).toEqual([["codex", ["rateLimits"]]]);
    expect(value.broadcasts()).toBe(1);
    await vi.advanceTimersByTimeAsync(79_000);
    expect(value.reads).toEqual([["codex", ["rateLimits"]]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.reads).toEqual([["codex", ["rateLimits"]], ["codex", ["rateLimits"]]]);
    await vi.advanceTimersByTimeAsync(50 * 60 * 1_000);
    expect(value.reads).toHaveLength(2);
    value.abort.abort();
    await vi.advanceTimersByTimeAsync(3 * hour);
    expect(value.reads).toHaveLength(2);
  });

  it("follows a reset reported by the read and skips busy or unrunnable providers", async () => {
    const busy = new Set<ProviderId>(["claude"]);
    const value = fixture({
      now: () => Date.now(),
      canRun: (providerId) => providerId !== "cursor",
      activeProviderIds: () => busy,
      apply: (providerId) => {
        value.states.set(providerId as ProviderId, value.fresh([new Date(Date.now() + 20_000).toISOString()]));
      },
    });
    const soon = new Date(Date.now() + 1_000).toISOString();
    value.states.set("codex", value.fresh([soon]));
    value.states.set("claude", value.fresh([soon]));
    startIdleRateLimitRefresh(value.dependencies, hour);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(value.reads).toEqual([["codex", ["rateLimits"]]]);
    busy.clear();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(value.reads).toEqual([["codex", ["rateLimits"]]]);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(value.reads).toEqual([["codex", ["rateLimits"]], ["codex", ["rateLimits"]]]);
    value.abort.abort();
  });

  it("bounds reset reads when every read reports another reset a moment away", async () => {
    const value = fixture({
      now: () => Date.now(),
      apply: (providerId) => {
        value.states.set(providerId as ProviderId, value.fresh([new Date(Date.now() + 1_000).toISOString()]));
      },
    });
    value.states.set("codex", value.fresh([new Date(Date.now() + 1_000).toISOString()]));
    startIdleRateLimitRefresh(value.dependencies, hour);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    expect(value.reads.length).toBeGreaterThan(0);
    expect(value.reads.length).toBeLessThanOrEqual(10);
    value.abort.abort();
  });

  it("leaves resets that passed before it started to the regular refresh", async () => {
    const value = fixture({ now: () => Date.now() });
    value.states.set("codex", value.fresh([new Date(Date.now() - 60_000).toISOString()]));
    startIdleRateLimitRefresh(value.dependencies, hour);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    expect(value.reads).toEqual([]);
    value.abort.abort();
  });
});

describe("idle usage freshness", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("shows idle usage as stale between backed-off reads once it is older than the freshness window", async () => {
    let reads = 0;
    const cache = new ProviderMetadataCache({
      read: async () => {
        reads += 1;
        return { rateLimits: [{ id: "codex:primary", label: "Codex", usedPercent: 40, remainingPercent: 60, windowMinutes: 300, resetsAt: null }] };
      },
    });
    const read = (providerId: ProviderId, fields: Array<"models" | "rateLimits">) => cache.metadata(providerId, `/tools/${providerId}`, {}, "/workspace", { fields, force: true });
    await read("codex", ["rateLimits"]);
    reads = 0;
    const abort = new AbortController();
    startIdleRateLimitRefresh({
      enabled: true,
      signal: abort.signal,
      isClosed: () => false,
      cachedState: (providerId) => cache.current(providerId),
      read: (providerId, fields) => read(providerId as ProviderId, fields),
      apply: () => undefined,
      broadcastSnapshot: () => undefined,
      isExternalTurn: () => false,
      canRun: (providerId) => providerId === "codex",
      activeProviderIds: () => new Set(),
      track: async (operation) => await operation(),
    });
    const freshness = new Set<string>();
    for (let elapsed = 0; elapsed < 30 * 60 * 1_000; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      freshness.add(cache.current("codex").metadataState.rateLimits.freshness);
    }
    expect([...freshness].sort()).toEqual(["fresh", "stale"]);
    expect(reads).toBe(3);
    abort.abort();
  });

  it("reads fresh idle usage that would age out before the next read, and skips usage read moments ago", async () => {
    const value = fixture({ now: () => Date.now() });
    const tick = IDLE_RATE_LIMIT_REFRESH_INTERVAL_MS;
    value.states.set("codex", value.fresh([], new Date(Date.now() + tick - 2 * 60 * 1_000).toISOString()));
    value.states.set("claude", value.fresh([], new Date(Date.now() + tick - 30 * 1_000).toISOString()));
    startIdleRateLimitRefresh(value.dependencies);
    await vi.advanceTimersByTimeAsync(tick);
    expect(value.reads).toEqual([["codex", ["rateLimits"]]]);
    value.abort.abort();
  });
});

describe("idle usage cadence", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const minute = 60 * 1_000;

  function cadenceFixture(options: {
    present?: () => boolean;
    connected?: Set<() => void>;
    rollingReset?: boolean;
  } = {}) {
    const used = new Map<string, number>([["codex", 40], ["claude", 40]]);
    const readsAt = new Map<string, number[]>([["codex", []], ["claude", []]]);
    const busy = new Set<ProviderId>();
    const started = Date.now();
    const cache = new ProviderMetadataCache({
      read: async (providerId) => {
        readsAt.get(providerId)!.push((Date.now() - started) / minute);
        return { rateLimits: [{ id: `${providerId}:primary`, label: providerId, usedPercent: used.get(providerId)!, remainingPercent: 100 - used.get(providerId)!, windowMinutes: 300, resetsAt: options.rollingReset ? new Date(Date.now() + 5 * 60 * minute).toISOString() : null }] };
      },
    });
    const read = (providerId: ProviderId, fields: Array<"models" | "rateLimits">) => cache.metadata(providerId, `/tools/${providerId}`, {}, "/workspace", { fields, force: true });
    const abort = new AbortController();
    const start = async () => {
      await read("codex", ["rateLimits"]);
      await read("claude", ["rateLimits"]);
      readsAt.set("codex", []);
      readsAt.set("claude", []);
      startIdleRateLimitRefresh({
        enabled: true,
        signal: abort.signal,
        isClosed: () => false,
        cachedState: (providerId) => cache.current(providerId),
        read: (providerId, fields) => read(providerId as ProviderId, fields),
        apply: () => undefined,
        broadcastSnapshot: () => undefined,
        isExternalTurn: () => false,
        canRun: (providerId) => providerId === "codex" || providerId === "claude",
        activeProviderIds: () => busy,
        track: async (operation) => await operation(),
        ...(options.present ? { clientPresent: options.present } : {}),
        ...(options.connected ? {
          subscribeClientConnected: (listener: () => void) => {
            options.connected!.add(listener);
            return () => { options.connected!.delete(listener); };
          },
        } : {}),
      });
    };
    return { cache, used, readsAt, busy, abort, start, read };
  }

  it("backs off idle reads geometrically while limits stay unchanged", async () => {
    const value = cadenceFixture();
    await value.start();
    for (let elapsed = 0; elapsed < 60 * minute; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      for (const providerId of ["codex", "claude"] as const) {
        const { freshness, updatedAt } = value.cache.current(providerId).metadataState.rateLimits;
        expect(freshness).toBe(Date.now() - Date.parse(updatedAt!) <= RATE_LIMIT_TTL_MS ? "fresh" : "stale");
      }
    }
    expect(RATE_LIMIT_TTL_MS).toBe(5 * minute);
    expect(value.readsAt.get("codex")!.length).toBeLessThanOrEqual(4);
    expect(value.readsAt.get("claude")!.length).toBeLessThanOrEqual(4);
    expect(value.readsAt.get("codex")).toEqual([3, 9, 21, 45]);
    value.abort.abort();
  });

  it("keeps backing off when only a rolling reset time moves", async () => {
    const value = cadenceFixture({ rollingReset: true });
    await value.start();
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(value.readsAt.get("codex")).toEqual([3, 9, 21, 45]);
    value.abort.abort();
  });

  it("returns to the short cadence when a read reports changed limits", async () => {
    const value = cadenceFixture();
    await value.start();
    await vi.advanceTimersByTimeAsync(20 * minute);
    expect(value.readsAt.get("codex")).toEqual([3, 9]);
    value.used.set("codex", 55);
    await vi.advanceTimersByTimeAsync(10 * minute);
    expect(value.readsAt.get("codex")).toEqual([3, 9, 21, 24, 30]);
    value.abort.abort();
  });

  it("returns to the short cadence after a turn ran on the provider", async () => {
    const value = cadenceFixture();
    await value.start();
    await vi.advanceTimersByTimeAsync(22 * minute);
    expect(value.readsAt.get("codex")).toEqual([3, 9, 21]);
    value.busy.add("codex");
    await vi.advanceTimersByTimeAsync(2 * minute);
    value.busy.clear();
    await value.read("codex", ["rateLimits"]);
    await vi.advanceTimersByTimeAsync(4 * minute);
    expect(value.readsAt.get("codex")).toEqual([3, 9, 21, 24, 27]);
    value.abort.abort();
  });

  it("skips idle reads while no renderer client is connected", async () => {
    let present = false;
    const value = cadenceFixture({ present: () => present });
    await value.start();
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(value.readsAt.get("codex")).toEqual([]);
    expect(value.readsAt.get("claude")).toEqual([]);
    present = true;
    await vi.advanceTimersByTimeAsync(3 * minute);
    expect(value.readsAt.get("codex")).toEqual([63]);
    value.abort.abort();
  });

  it("reads once as soon as a renderer client reconnects", async () => {
    let present = false;
    const connected = new Set<() => void>();
    const value = cadenceFixture({ present: () => present, connected });
    await value.start();
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(value.readsAt.get("codex")).toEqual([]);
    present = true;
    for (const listener of connected) listener();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.readsAt.get("codex")).toEqual([60]);
    expect(value.readsAt.get("claude")).toEqual([60]);
    await vi.advanceTimersByTimeAsync(3 * minute);
    expect(value.readsAt.get("codex")).toEqual([60]);
    for (const listener of connected) listener();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.readsAt.get("codex")).toEqual([60]);
    value.abort.abort();
    expect(connected.size).toBe(0);
  });
});
