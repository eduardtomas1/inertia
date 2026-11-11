// @inertia-test-suite portable
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { ProviderRateLimit } from "../../src/shared/contracts";
import type { UsageAccount } from "../../src/shared/provider-usage-limits";
import { parseClaudeRateLimits } from "../../src/server/provider/claude-agent-sdk-metadata";
import {
  CLAUDE_MODEL_WEEKLY_LIMIT_ID,
  canonicalClaudeRateLimits,
} from "../../src/server/provider/claude-rate-limit-windows";
import { parseClaudeRateLimitEvents } from "../../src/server/provider/claude-usage";
import {
  ProviderMetadataCache,
  type PersistedProviderMetadata,
} from "../../src/server/provider/metadata";
import { mergeSparseRateLimits } from "../../src/server/provider/rate-limit-merge";
import { resetQuota } from "../../src/server/usage/limit-reset-policy";

const NOW = Date.parse("2026-11-11T08:23:00.000Z");
const WEEK_RESET = "2026-11-17T07:00:00.000Z";
const claudeExecutable = resolve("claude rate limit fixture", "claude");

function usageRead(modelScoped: unknown[], resetsAt = WEEK_RESET): unknown {
  return {
    rate_limits_available: true,
    rate_limits: {
      five_hour: null,
      seven_day: { utilization: 11, resets_at: resetsAt },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      model_scoped: modelScoped,
    },
  };
}

function liveEvent(windows: Record<string, { utilization: number; resetsAt: number }>): unknown {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: windows },
  };
}

function window(id: string, usedPercent: number, resetsAt: string | null, label = id): ProviderRateLimit {
  return { id, label, usedPercent, remainingPercent: 100 - usedPercent, windowMinutes: 10_080, resetsAt };
}

function summary(limits: readonly ProviderRateLimit[]): string[] {
  return limits.map(({ id, label, usedPercent }) => `${id}|${label}|${usedPercent}`);
}

describe("Claude rate limit windows (#723)", () => {
  it("names the live overage-included window after the model Claude Code names it for, never extra usage", () => {
    const limits = parseClaudeRateLimitEvents(liveEvent({
      seven_day: { utilization: 0.09, resetsAt: Date.parse(WEEK_RESET) / 1_000 },
      seven_day_overage_included: { utilization: 0.15, resetsAt: Date.parse(WEEK_RESET) / 1_000 },
    }));
    expect(limits.map(({ id, label, windowMinutes }) => ({ id, label, windowMinutes }))).toEqual([
      { id: "claude:seven_day", label: "Weekly", windowMinutes: 10_080 },
      { id: CLAUDE_MODEL_WEEKLY_LIMIT_ID, label: "Weekly · Fable", windowMinutes: 10_080 },
    ]);
    expect(limits.map(({ label }) => label).join(" ")).not.toMatch(/extra usage/iu);
  });

  it("reads the oauth/usage model-scoped weekly window under the same identity as the live one", () => {
    const limits = parseClaudeRateLimits(
      usageRead([{ display_name: "Fable", utilization: 19, resets_at: WEEK_RESET }]),
      NOW,
    );
    expect(summary(limits)).toEqual([
      "claude:seven_day|Weekly|11",
      `${CLAUDE_MODEL_WEEKLY_LIMIT_ID}|Weekly · Fable|19`,
    ]);
  });

  it("keeps several model-scoped windows apart and maps the live window to the model it is named for, else the first", () => {
    const limits = parseClaudeRateLimits(usageRead([
      { display_name: "Saga", utilization: 40, resets_at: WEEK_RESET },
      { display_name: "Fable", utilization: 19, resets_at: WEEK_RESET },
      { utilization: 5, resets_at: WEEK_RESET },
    ]), NOW);
    expect(summary(limits).slice(1)).toEqual([
      "claude:model_scoped:saga|Weekly · Saga|40",
      `${CLAUDE_MODEL_WEEKLY_LIMIT_ID}|Weekly · Fable|19`,
      "claude:model_scoped:2|Weekly · model 3|5",
    ]);
    const others = parseClaudeRateLimits(usageRead([
      { display_name: "Saga", utilization: 40, resets_at: WEEK_RESET },
      { display_name: "Nova", utilization: 12, resets_at: WEEK_RESET },
    ]), NOW);
    expect(summary(others).slice(1)).toEqual([
      `${CLAUDE_MODEL_WEEKLY_LIMIT_ID}|Weekly · Saga|40`,
      "claude:model_scoped:nova|Weekly · Nova|12",
    ]);
  });

  it("drops a window whose own reset time has already passed from a full read", () => {
    const limits = parseClaudeRateLimits(
      usageRead([{ display_name: "Fable", utilization: 53, resets_at: "2026-11-10T07:00:00.000Z" }]),
      NOW,
    );
    expect(summary(limits)).toEqual(["claude:seven_day|Weekly|11"]);
  });

  it("relabels windows persisted by earlier versions and folds the legacy model row into the live one", () => {
    expect(summary(canonicalClaudeRateLimits([
      window("claude:five_hour", 4, null, "Claude · 5 hour"),
      window("claude:seven_day", 19, WEEK_RESET, "Claude · 7 day"),
      window("claude:model_0", 3, WEEK_RESET, "Fable"),
      window("claude:seven_day_overage_included", 37, WEEK_RESET, "Claude extra usage · 7 day"),
    ]))).toEqual([
      "claude:five_hour|Session|4",
      "claude:seven_day|Weekly|19",
      `${CLAUDE_MODEL_WEEKLY_LIMIT_ID}|Weekly · Fable|37`,
    ]);
    expect(summary(canonicalClaudeRateLimits([
      window("claude:model_0", 3, WEEK_RESET, "Fable"),
    ]))).toEqual([`${CLAUDE_MODEL_WEEKLY_LIMIT_ID}|Weekly · Fable|3`]);
  });

  it("treats the model weekly window as a limit of that model in reset decisions", () => {
    const account: UsageAccount = {
      id: "native:claude", providerId: "claude", providerLabel: "Claude", label: "Claude account",
      email: null, plan: "max", identityKey: null, sources: ["This computer"], status: "ready", detail: null,
      updatedAt: new Date(NOW).toISOString(), checkedAt: new Date(NOW).toISOString(), credits: null, canReset: false,
      windows: [
        { id: "claude:seven_day", label: "Weekly", remainingPercent: 60, windowMinutes: 10_080, resetsAt: WEEK_RESET },
        { id: CLAUDE_MODEL_WEEKLY_LIMIT_ID, label: "Weekly · Fable", remainingPercent: 0, windowMinutes: 10_080, resetsAt: WEEK_RESET },
      ],
    };
    expect(resetQuota(account, "claude-fable-5-2", NOW)).toEqual({ kind: "exhausted", resetsAt: WEEK_RESET });
    expect(resetQuota(account, "fable", NOW)).toEqual({ kind: "exhausted", resetsAt: WEEK_RESET });
    expect(resetQuota(account, "default", NOW, "Fable 5.2")).toEqual({ kind: "exhausted", resetsAt: WEEK_RESET });
    expect(resetQuota(account, "claude-sonnet-5-5", NOW)).toEqual({ kind: "available" });
    expect(resetQuota(account, "default", NOW, "Opus 5.5")).toEqual({ kind: "available" });
    account.windows[1]!.remainingPercent = 40;
    expect(resetQuota(account, "claude-fable-5-2", NOW)).toEqual({ kind: "available" });
    expect(resetQuota(account, "default", NOW)).toEqual({ kind: "available" });
  });

  it("does not call quota available while an exhausted model weekly window may cover the turn", () => {
    const exhausted = (label: string): UsageAccount => ({
      id: "native:claude", providerId: "claude", providerLabel: "Claude", label: "Claude account",
      email: null, plan: "max", identityKey: null, sources: ["This computer"], status: "ready", detail: null,
      updatedAt: new Date(NOW).toISOString(), checkedAt: new Date(NOW).toISOString(), credits: null, canReset: false,
      windows: [
        { id: "claude:seven_day", label: "Weekly", remainingPercent: 60, windowMinutes: 10_080, resetsAt: WEEK_RESET },
        { id: CLAUDE_MODEL_WEEKLY_LIMIT_ID, label, remainingPercent: 0, windowMinutes: 10_080, resetsAt: WEEK_RESET },
      ],
    });
    expect(resetQuota(exhausted("Weekly · Fable"), "default", NOW)).toEqual({ kind: "unknown" });
    expect(resetQuota(exhausted("Weekly · Fable"), "default", NOW, "Default (recommended)")).toEqual({ kind: "unknown" });
    expect(resetQuota(exhausted("Weekly · model 1"), "claude-opus-5-5", NOW)).toEqual({ kind: "unknown" });
    expect(resetQuota(exhausted("Weekly · Saga"), "claude-opus-5-5", NOW)).toEqual({ kind: "unknown" });
    expect(resetQuota(exhausted("Weekly · Fable"), "claude-opus-5-5", NOW)).toEqual({ kind: "available" });
    expect(resetQuota(exhausted("Weekly · Fable 5"), "claude-opus-5-5", NOW)).toEqual({ kind: "available" });
    expect(resetQuota(exhausted("Weekly · Fable 5"), "sonnet", NOW, "Sonnet 5.5")).toEqual({ kind: "available" });
    expect(resetQuota(exhausted("Weekly · Fable 5"), "fable", NOW)).toEqual({ kind: "exhausted", resetsAt: WEEK_RESET });
  });

  it("resumes a Fable turn at its reset from a live window alone, before oauth/usage has named it", () => {
    const [live] = parseClaudeRateLimitEvents(liveEvent({
      seven_day_overage_included: { utilization: 1, resetsAt: Date.parse(WEEK_RESET) / 1_000 },
    }));
    const account: UsageAccount = {
      id: "native:claude", providerId: "claude", providerLabel: "Claude", label: "Claude account",
      email: null, plan: "max", identityKey: null, sources: ["This computer"], status: "ready", detail: null,
      updatedAt: new Date(NOW).toISOString(), checkedAt: new Date(NOW).toISOString(), credits: null, canReset: false,
      windows: [
        { id: "claude:seven_day", label: "Weekly", remainingPercent: 60, windowMinutes: 10_080, resetsAt: WEEK_RESET },
        { id: live!.id, label: live!.label, remainingPercent: live!.remainingPercent, windowMinutes: live!.windowMinutes, resetsAt: live!.resetsAt },
      ],
    };
    expect(resetQuota(account, "claude-fable-5-2", NOW)).toEqual({ kind: "exhausted", resetsAt: WEEK_RESET });
    expect(resetQuota(account, "default", NOW)).toEqual({ kind: "unknown" });
    expect(resetQuota(account, "claude-opus-5-5", NOW)).toEqual({ kind: "available" });
  });
});

describe("sparse rate limit merges (#723)", () => {
  const future = "2026-11-17T07:00:00.000Z";

  it("keeps unreported windows of the same account and window", () => {
    expect(summary(mergeSparseRateLimits(
      [window("claude:seven_day", 9, future), window("claude:seven_day_opus", 30, future)],
      [window("claude:seven_day", 11, future)],
      NOW,
    ))).toEqual(["claude:seven_day|claude:seven_day|11", "claude:seven_day_opus|claude:seven_day_opus|30"]);
  });

  it("never carries a value past its own reset time", () => {
    expect(summary(mergeSparseRateLimits(
      [window("claude:seven_day", 90, "2026-11-10T07:00:00.000Z"), window("claude:seven_day_opus", 53, "2026-11-10T07:00:00.000Z")],
      [window("claude:seven_day", 11, future)],
      NOW,
    ))).toEqual(["claude:seven_day|claude:seven_day|11"]);
  });

  it("discards every cached window when a still-open window comes back with another reset time", () => {
    expect(summary(mergeSparseRateLimits(
      [window("claude:seven_day", 55, "2026-11-14T15:00:00.000Z"), window("claude:seven_day_opus", 53, "2026-11-14T15:00:00.000Z")],
      [window("claude:seven_day", 11, future)],
      NOW,
    ))).toEqual(["claude:seven_day|claude:seven_day|11"]);
  });

  it("tolerates provider jitter in a reported reset time", () => {
    expect(mergeSparseRateLimits(
      [window("claude:seven_day", 9, "2026-11-17T06:59:59.000Z"), window("claude:seven_day_opus", 30, future)],
      [window("claude:seven_day", 11, future)],
      NOW,
    )).toHaveLength(2);
  });
});

describe("provider metadata cache quota replacement (#723)", () => {
  function cache(now: () => number, persisted: PersistedProviderMetadata[] = []): ProviderMetadataCache {
    return new ProviderMetadataCache({
      now,
      persistence: { load: () => persisted, save: (metadata) => { persisted.splice(0, persisted.length, structuredClone(metadata)); } },
    });
  }

  it("replaces the model-scoped value from oauth/usage with the next live value", () => {
    let now = NOW;
    const metadata = cache(() => now);
    metadata.correlate("claude", { executable: claudeExecutable, version: "2.1.319", authState: "authenticated" });
    metadata.learn("claude", claudeExecutable, {
      rateLimits: parseClaudeRateLimits(usageRead([{ display_name: "Fable", utilization: 53, resets_at: WEEK_RESET }]), now),
    }, "provider");
    now += 60_000;
    const merged = metadata.learn("claude", claudeExecutable, {
      rateLimits: parseClaudeRateLimitEvents(liveEvent({
        seven_day: { utilization: 0.09, resetsAt: Date.parse(WEEK_RESET) / 1_000 },
        seven_day_overage_included: { utilization: 0.15, resetsAt: Date.parse(WEEK_RESET) / 1_000 },
      })),
    }, "session", { merge: true });
    expect(summary(merged.rateLimits)).toEqual([
      "claude:seven_day|Weekly|9",
      `${CLAUDE_MODEL_WEEKLY_LIMIT_ID}|Weekly · Fable|15`,
    ]);
    expect(merged.metadataState.rateLimits.freshness).toBe("fresh");
  });

  it("keeps the model name the provider reported when a live value replaces it", () => {
    const metadata = cache(() => NOW);
    metadata.correlate("claude", { executable: claudeExecutable, version: "2.1.319", authState: "authenticated" });
    metadata.learn("claude", claudeExecutable, {
      rateLimits: parseClaudeRateLimits(usageRead([{ display_name: "Saga", utilization: 20, resets_at: WEEK_RESET }]), NOW),
    }, "provider");
    const merged = metadata.learn("claude", claudeExecutable, {
      rateLimits: parseClaudeRateLimitEvents(liveEvent({
        seven_day_overage_included: { utilization: 0.25, resetsAt: Date.parse(WEEK_RESET) / 1_000 },
      })),
    }, "session", { merge: true });
    expect(summary(merged.rateLimits)).toContain(`${CLAUDE_MODEL_WEEKLY_LIMIT_ID}|Weekly · Saga|25`);
  });

  it("does not present windows inherited from an earlier CLI version as fresh after a live update", () => {
    const metadata = cache(() => NOW);
    metadata.correlate("claude", { executable: claudeExecutable, version: "2.1.318", authState: "authenticated" });
    metadata.learn("claude", claudeExecutable, {
      rateLimits: [window("claude:seven_day", 77, "2026-11-14T15:00:00.000Z", "Weekly"), window("claude:seven_day_opus", 53, "2026-11-14T15:00:00.000Z", "Weekly · Opus")],
    }, "provider");
    metadata.correlate("claude", { executable: claudeExecutable, version: "2.1.319", authState: "authenticated" });
    expect(metadata.current("claude").metadataState.rateLimits.freshness).toBe("stale");
    const merged = metadata.learn("claude", claudeExecutable, {
      rateLimits: [window("claude:seven_day", 11, "2026-11-14T15:00:00.000Z", "Weekly")],
    }, "session", { merge: true });
    expect(summary(merged.rateLimits)).toEqual(["claude:seven_day|Weekly|11"]);
    expect(merged.metadataState.rateLimits.freshness).toBe("fresh");
  });

  it("does not build on the rows of an earlier login it returns to", () => {
    let now = NOW;
    const metadata = cache(() => now);
    const signedIn = { executable: claudeExecutable, version: "2.1.319", authState: "authenticated" as const };
    metadata.correlate("claude", signedIn);
    metadata.learn("claude", claudeExecutable, {
      rateLimits: [window("claude:seven_day", 77, "2026-11-14T15:00:00.000Z", "Weekly"), window("claude:seven_day_opus", 53, "2026-11-14T15:00:00.000Z", "Weekly · Opus")],
    }, "provider");
    metadata.correlate("claude", { ...signedIn, authState: "unauthenticated" });
    now += 20 * 60_000;
    metadata.correlate("claude", signedIn);
    const merged = metadata.learn("claude", claudeExecutable, {
      rateLimits: [window("claude:five_hour", 4, "2026-11-11T12:00:00.000Z", "Session")],
    }, "session", { merge: true });
    expect(summary(merged.rateLimits)).toEqual(["claude:five_hour|Session|4"]);
  });

  it("renames windows persisted by an earlier version when the cache loads", () => {
    const first = cache(() => NOW);
    first.correlate("claude", { executable: claudeExecutable, version: "2.1.319", authState: "authenticated" });
    const scope = first.nativeScope("claude");
    const metadata = cache(() => NOW, [{
      scope,
      models: [], modelsUpdatedAt: null, modelsLastAttemptedAt: null, modelsProvenance: null, modelsStale: false,
      rateLimits: [
        window("claude:seven_day", 19, WEEK_RESET, "Claude · 7 day"),
        window("claude:model_0", 3, WEEK_RESET, "Fable"),
        window("claude:seven_day_overage_included", 37, WEEK_RESET, "Claude extra usage · 7 day"),
      ],
      rateLimitsUpdatedAt: new Date(NOW - 60_000).toISOString(),
      rateLimitsLastAttemptedAt: new Date(NOW - 60_000).toISOString(),
      rateLimitsProvenance: "session",
      rateLimitsStale: false,
    }]);
    expect(summary(metadata.current("claude").rateLimits)).toEqual([
      "claude:seven_day|Weekly|19",
      `${CLAUDE_MODEL_WEEKLY_LIMIT_ID}|Weekly · Fable|37`,
    ]);
  });
});
