import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentTurn,
  AgentTurnUsageSnapshot,
  ProviderId,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { usageDashboardSchema } from "../../src/shared/contracts/usage-dashboard-schema";
import { RuntimeStore } from "../../src/server/database";
import { parseClaudeUsage } from "../../src/server/provider/claude-usage";
import {
  projectUsageDashboard,
  type UsageDashboardRange,
} from "../../src/server/usage-dashboard";
import {
  parsePriceList,
  resolveModelRates,
  USAGE_PRICE_LIST_SOURCE,
  type UsagePricing,
} from "../../src/server/usage/price-list";

const directories: string[] = [];
const range: UsageDashboardRange = {
  days: 30,
  fromInclusive: "2026-06-01T00:00:00.000Z",
  toExclusive: "2026-07-01T00:00:00.000Z",
  endDate: "2026-06-30",
  timeZone: "UTC",
};

function usage(
  capturedAt: string,
  update: Partial<AgentTurnUsageSnapshot> = {},
): AgentTurnUsageSnapshot {
  return {
    usedTokens: null,
    totalProcessedTokens: null,
    totalProcessedScope: null,
    maxTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    compactsAutomatically: null,
    providerSessionBound: true,
    capturedAt,
    ...update,
  };
}

function turn(input: {
  id: string;
  providerId: ProviderId;
  model: string;
  completedAt: string;
  status?: AgentTurn["status"];
  runtimeMs?: number | null;
  suspendedDurationMs?: number;
  startUsage?: AgentTurnUsageSnapshot | null;
  completionUsage?: AgentTurnUsageSnapshot | null;
  backendProfileId?: string;
  backendLabel?: string;
  backendConfigurationRevision?: number;
  endpointIdentity?: string | null;
  providerSessionBefore?: string | null;
  providerSessionAfter?: string | null;
  association?: AgentTurn["association"];
}): AgentTurn {
  const completedAt = input.completedAt;
  const runtimeMs = input.runtimeMs === undefined ? 5_000 : input.runtimeMs;
  const selection = {
    ...providerNativeModelSelection({
      providerId: input.providerId,
      modelId: input.model,
    }),
    ...(input.backendProfileId
      ? { backendProfileId: input.backendProfileId }
      : {}),
    ...(input.backendLabel
      ? { backendProfileDisplayName: input.backendLabel }
      : {}),
    ...(input.backendConfigurationRevision === undefined
      ? {}
      : { backendConfigurationRevision: input.backendConfigurationRevision }),
  };
  return {
    id: input.id,
    conversationId: `conversation-${input.id}`,
    runId: `run-${input.id}`,
    userMessageId: `message-${input.id}`,
    terminalAssistantMessageId: null,
    providerId: input.providerId,
    modelSelection: selection,
    continuationIdentity: {
      harnessId: selection.harnessId,
      backendProfileId: selection.backendProfileId,
      backendConfigurationRevision: selection.backendConfigurationRevision,
      modelIdentity: selection.modelId,
      endpointIdentity: input.endpointIdentity ?? null,
    },
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    model: input.model,
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: input.providerSessionBefore ?? null,
    providerSessionAfter: input.providerSessionAfter
      ?? input.providerSessionBefore
      ?? null,
    requestedAt: runtimeMs === null
      ? completedAt
      : new Date(Date.parse(completedAt) - runtimeMs - 1_000).toISOString(),
    startedAt: runtimeMs === null
      ? null
      : new Date(Date.parse(completedAt) - runtimeMs).toISOString(),
    completedAt,
    suspendedDurationMs: input.suspendedDurationMs ?? 0,
    status: input.status ?? "completed",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: input.startUsage ?? null,
    usageAtCompletion: input.completionUsage ?? null,
    configurationRevision: selection.backendConfigurationRevision,
    association: input.association ?? "authoritative",
    createdAt: completedAt,
    updatedAt: completedAt,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("usage dashboard projection", () => {
  it("keeps mixed-provider totals accurate and missing usage explicitly partial", () => {
    const turns = [
      turn({
        id: "codex",
        providerId: "codex",
        model: "gpt-unknown-preview",
        completedAt: "2026-06-10T09:00:00.000Z",
        suspendedDurationMs: 2_000,
        providerSessionBefore: "codex-thread-1",
        startUsage: usage("2026-06-10T08:59:00.000Z", {
          totalProcessedTokens: 1_000,
          totalProcessedScope: "thread",
        }),
        completionUsage: usage("2026-06-10T09:00:00.000Z", {
          totalProcessedTokens: 1_500,
          totalProcessedScope: "thread",
          inputTokens: 420,
          cachedInputTokens: 120,
          outputTokens: 80,
          reasoningOutputTokens: 30,
        }),
      }),
      turn({
        id: "claude",
        providerId: "claude",
        model: "claude-future",
        completedAt: "2026-06-10T10:00:00.000Z",
        runtimeMs: 10_000,
        completionUsage: usage("2026-06-10T10:00:00.000Z", {
          totalProcessedTokens: 900,
          totalProcessedScope: "run",
          inputTokens: 700,
          cachedInputTokens: 300,
          cacheWriteInputTokens: 50,
          outputTokens: 200,
        }),
      }),
      turn({
        id: "cursor",
        providerId: "cursor",
        model: "cursor-managed",
        completedAt: "2026-06-11T10:00:00.000Z",
        completionUsage: usage("2026-06-11T10:00:00.000Z", {
          totalProcessedTokens: 4_000,
          totalProcessedScope: "session",
          inputTokens: 100,
          outputTokens: 40,
        }),
      }),
      turn({
        id: "opencode",
        providerId: "opencode",
        model: "vendor/new-model",
        completedAt: "2026-06-12T10:00:00.000Z",
        completionUsage: usage("2026-06-12T10:00:00.000Z", {
          totalProcessedTokens: 300,
          totalProcessedScope: "run",
          inputTokens: 200,
          outputTokens: 100,
        }),
        backendProfileId: "custom:gateway",
        backendLabel: "Team gateway",
      }),
      turn({
        id: "kimi",
        providerId: "claude",
        model: "k3-256k",
        completedAt: "2026-06-13T10:00:00.000Z",
        completionUsage: usage("2026-06-13T10:00:00.000Z", {
          totalProcessedTokens: 400,
          totalProcessedScope: "run",
          inputTokens: 320,
          outputTokens: 80,
        }),
        backendProfileId: "preset:kimi",
        backendLabel: "Kimi",
      }),
      turn({
        id: "synthetic",
        providerId: "opencode",
        model: "<synthetic>",
        completedAt: "2026-06-14T10:00:00.000Z",
        status: "failed",
        runtimeMs: null,
      }),
      turn({
        id: "legacy-inferred",
        providerId: "codex",
        model: "legacy-model",
        completedAt: "2026-06-15T10:00:00.000Z",
        association: "inferred",
        completionUsage: usage("2026-06-15T10:00:00.000Z", {
          totalProcessedTokens: 999_999,
          totalProcessedScope: "run",
        }),
      }),
    ];

    const dashboard = projectUsageDashboard(
      turns,
      range,
      "2026-07-01T00:00:01.000Z",
    );

    expect(dashboard.totals).toMatchObject({
      requestCount: 6,
      completedCount: 5,
      failedCount: 1,
      activeDays: 5,
      runtime: {
        value: 28_000,
        measuredRequests: 5,
        totalRequests: 6,
        coverage: "partial",
      },
      processedTokens: {
        value: 2_100,
        measuredRequests: 4,
        totalRequests: 6,
        coverage: "partial",
      },
    });
    expect(dashboard.daily).toHaveLength(30);
    expect(dashboard.daily.find(({ date }) => date === "2026-06-10"))
      .toMatchObject({
        requestCount: 2,
        processedTokens: { value: 1_400, coverage: "complete" },
        providers: [
          {
            providerId: "claude",
            requestCount: 1,
            processedTokens: { value: 900, coverage: "complete" },
          },
          {
            providerId: "codex",
            requestCount: 1,
            processedTokens: { value: 500, coverage: "complete" },
          },
        ],
      });
    expect(dashboard.daily.find(({ date }) => date === "2026-06-11"))
      .toMatchObject({
        requestCount: 1,
        processedTokens: { value: null, coverage: "unavailable" },
        providers: [{
          providerId: "cursor",
          requestCount: 1,
          processedTokens: { value: null, coverage: "unavailable" },
        }],
      });
    expect(dashboard.providers.map(({ providerId, requestCount }) => [
      providerId,
      requestCount,
    ])).toEqual([
      ["claude", 2],
      ["codex", 1],
      ["opencode", 2],
      ["cursor", 1],
    ]);
    expect(dashboard.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: "k3-256k",
        backendLabel: "Kimi",
        providerId: "claude",
      }),
      expect.objectContaining({
        model: "vendor/new-model",
        backendLabel: "Team gateway",
      }),
      expect.objectContaining({ model: "<synthetic>" }),
      expect.objectContaining({ model: "gpt-unknown-preview" }),
    ]));
    expect(dashboard.models).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "legacy-model" }),
    ]));
    expect(dashboard.tokens.input).toMatchObject({
      value: 1_440,
      measuredRequests: 3,
      coverage: "partial",
    });
    expect(dashboard.cost).toEqual({
      status: "unavailable",
      reason: "The model price list could not be downloaded, so there is nothing to estimate from.",
      pricing: { status: "unavailable", source: USAGE_PRICE_LIST_SOURCE, fetchedAt: null, modelCount: 0 },
      byType: { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 },
      cacheSavings: 0,
    });
    expect(dashboard.totals.cost).toEqual({ value: null, measuredRequests: 0, totalRequests: dashboard.totals.requestCount, coverage: "unavailable" });
    expect(JSON.stringify(dashboard)).not.toContain("conversation-codex");
  });

  it("aggregates token categories only when the harness semantics are defensible", () => {
    const codex = turn({
      id: "codex-turn-fields",
      providerId: "codex",
      model: "gpt-turn-fields",
      completedAt: "2026-06-20T10:00:00.000Z",
      completionUsage: usage("2026-06-20T10:00:00.000Z", {
        inputTokens: 40,
        outputTokens: 10,
      }),
    });
    const claude = turn({
      id: "claude-run-fields",
      providerId: "claude",
      model: "claude-run-fields",
      completedAt: "2026-06-20T11:00:00.000Z",
      completionUsage: usage("2026-06-20T11:00:00.000Z", {
        totalProcessedTokens: 80,
        totalProcessedScope: "run",
        inputTokens: 60,
        outputTokens: 20,
      }),
    });
    const cursor = turn({
      id: "cursor-session-fields",
      providerId: "cursor",
      model: "cursor-session-fields",
      completedAt: "2026-06-20T12:00:00.000Z",
      providerSessionBefore: "cursor-session",
      startUsage: usage("2026-06-20T11:59:00.000Z", {
        inputTokens: 100,
        outputTokens: 40,
      }),
      completionUsage: usage("2026-06-20T12:00:00.000Z", {
        inputTokens: 160,
        outputTokens: 70,
      }),
    });
    const resetCursor = turn({
      id: "cursor-reset-fields",
      providerId: "cursor",
      model: "cursor-reset-fields",
      completedAt: "2026-06-20T13:00:00.000Z",
      providerSessionBefore: "cursor-reset-session",
      startUsage: usage("2026-06-20T12:59:00.000Z", { inputTokens: 100 }),
      completionUsage: usage("2026-06-20T13:00:00.000Z", { inputTokens: 80 }),
    });
    const opencode = turn({
      id: "opencode-message-fields",
      providerId: "opencode",
      model: "opencode-message-fields",
      completedAt: "2026-06-20T14:00:00.000Z",
      completionUsage: usage("2026-06-20T14:00:00.000Z", {
        totalProcessedTokens: 500,
        totalProcessedScope: "run",
        inputTokens: 400,
        outputTokens: 100,
      }),
    });
    const claudeContextOnly = turn({
      id: "claude-context-fields",
      providerId: "claude",
      model: "claude-context-fields",
      completedAt: "2026-06-20T15:00:00.000Z",
      completionUsage: usage("2026-06-20T15:00:00.000Z", {
        inputTokens: 300,
        outputTokens: 50,
      }),
    });
    const unknownHarness = turn({
      id: "unknown-harness-fields",
      providerId: "codex",
      model: "unknown-harness-fields",
      completedAt: "2026-06-20T16:00:00.000Z",
      completionUsage: usage("2026-06-20T16:00:00.000Z", {
        inputTokens: 999,
        outputTokens: 999,
      }),
    });
    unknownHarness.modelSelection = {
      ...unknownHarness.modelSelection,
      harnessId: "future-harness",
    };
    unknownHarness.continuationIdentity = {
      ...unknownHarness.continuationIdentity,
      harnessId: "future-harness",
    };

    const dashboard = projectUsageDashboard([
      codex,
      claude,
      cursor,
      resetCursor,
      opencode,
      claudeContextOnly,
      unknownHarness,
    ], range);

    expect(dashboard.tokens.input).toEqual({
      value: 160,
      measuredRequests: 3,
      totalRequests: 7,
      coverage: "partial",
    });
    expect(dashboard.tokens.output).toEqual({
      value: 60,
      measuredRequests: 3,
      totalRequests: 7,
      coverage: "partial",
    });
  });

  it("rejects ranges that do not match their declared time zone", () => {
    expect(() => projectUsageDashboard([], {
      ...range,
      timeZone: "Not/AZone",
    })).toThrow(/time zone is invalid/u);
    expect(() => projectUsageDashboard([], {
      ...range,
      fromInclusive: "2026-06-01T12:00:00.000Z",
    })).toThrow(/date range is invalid|does not match/u);
  });

  it("rejects an unbounded renderer range at the repository boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-usage-range-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspace, {
      recoverInterruptedRuns: false,
    });

    expect(() => store.usageDashboard({
      ...range,
      fromInclusive: "2000-01-01T00:00:00.000Z",
    })).toThrow(/date range is invalid/u);
    store.close();
  });

  it("accepts local-midnight ranges across daylight-saving changes", () => {
    const dashboard = projectUsageDashboard([], {
      days: 7,
      fromInclusive: "2026-03-22T23:00:00.000Z",
      toExclusive: "2026-03-29T22:00:00.000Z",
      endDate: "2026-03-29",
      timeZone: "Europe/Madrid",
    });

    expect(dashboard.range).toMatchObject({
      startDate: "2026-03-23",
      endDate: "2026-03-29",
    });
    expect(dashboard.daily).toHaveLength(7);
  });

  it("keeps unknown models and unusable cumulative totals explicit", () => {
    const dashboard = projectUsageDashboard([
      turn({
        id: "scope-mismatch",
        providerId: "codex",
        model: "",
        completedAt: "2026-06-20T10:00:00.000Z",
        startUsage: usage("2026-06-20T09:59:00.000Z", {
          totalProcessedTokens: 100,
          totalProcessedScope: "thread",
        }),
        completionUsage: usage("2026-06-20T10:00:00.000Z", {
          totalProcessedTokens: 200,
          totalProcessedScope: "session",
        }),
      }),
      turn({
        id: "counter-reset",
        providerId: "cursor",
        model: "cursor-managed",
        completedAt: "2026-06-20T11:00:00.000Z",
        startUsage: usage("2026-06-20T10:59:00.000Z", {
          totalProcessedTokens: 300,
          totalProcessedScope: "session",
        }),
        completionUsage: usage("2026-06-20T11:00:00.000Z", {
          totalProcessedTokens: 250,
          totalProcessedScope: "session",
        }),
      }),
      turn({
        id: "zero-run",
        providerId: "claude",
        model: "claude-zero",
        completedAt: "2026-06-20T12:00:00.000Z",
        completionUsage: usage("2026-06-20T12:00:00.000Z", {
          totalProcessedTokens: 0,
          totalProcessedScope: "run",
        }),
      }),
      turn({
        id: "interrupted",
        providerId: "opencode",
        model: "<synthetic>",
        completedAt: "2026-06-20T13:00:00.000Z",
        status: "interrupted",
      }),
    ], range);

    expect(dashboard.totals).toMatchObject({
      requestCount: 4,
      cancelledCount: 0,
      interruptedCount: 1,
      processedTokens: {
        value: 0,
        measuredRequests: 1,
        totalRequests: 4,
        coverage: "partial",
      },
    });
    expect(dashboard.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "Unknown model" }),
    ]));
  });

  it("keeps an overflowing aggregate unavailable instead of rounding it", () => {
    const dashboard = projectUsageDashboard([
      turn({
        id: "maximum-safe-total",
        providerId: "claude",
        model: "claude-overflow-test",
        completedAt: "2026-06-20T10:00:00.000Z",
        completionUsage: usage("2026-06-20T10:00:00.000Z", {
          totalProcessedTokens: Number.MAX_SAFE_INTEGER,
          totalProcessedScope: "run",
        }),
      }),
      turn({
        id: "overflowing-total",
        providerId: "claude",
        model: "claude-overflow-test",
        completedAt: "2026-06-20T11:00:00.000Z",
        completionUsage: usage("2026-06-20T11:00:00.000Z", {
          totalProcessedTokens: 1,
          totalProcessedScope: "run",
        }),
      }),
    ], range);

    expect(dashboard.totals.processedTokens).toEqual({
      value: null,
      measuredRequests: 2,
      totalRequests: 2,
      coverage: "unavailable",
    });
    expect(usageDashboardSchema(dashboard)).toBe(true);
  });

  it("subtracts cumulative counters only with captured continuation provenance", () => {
    const proven = turn({
      id: "proven",
      providerId: "codex",
      model: "gpt-proven",
      completedAt: "2026-06-20T10:00:00.000Z",
      providerSessionBefore: "thread-proven",
      startUsage: usage("2026-06-20T09:59:00.000Z", {
        totalProcessedTokens: 1_000,
        totalProcessedScope: "thread",
      }),
      completionUsage: usage("2026-06-20T10:00:00.000Z", {
        totalProcessedTokens: 1_125,
        totalProcessedScope: "thread",
      }),
    });
    const staleAfterRouteChange = turn({
      id: "stale-route",
      providerId: "codex",
      model: "gpt-new-route",
      completedAt: "2026-06-20T11:00:00.000Z",
      backendProfileId: "custom:new-route",
      backendConfigurationRevision: 4,
      endpointIdentity: "endpoint-new",
      startUsage: usage("2026-06-20T10:59:00.000Z", {
        totalProcessedTokens: 2_000,
        totalProcessedScope: "thread",
      }),
      completionUsage: usage("2026-06-20T11:00:00.000Z", {
        totalProcessedTokens: 2_250,
        totalProcessedScope: "thread",
      }),
    });
    const inconsistentIdentity = turn({
      id: "inconsistent-identity",
      providerId: "cursor",
      model: "cursor-managed",
      completedAt: "2026-06-20T12:00:00.000Z",
      providerSessionBefore: "cursor-session",
      startUsage: usage("2026-06-20T11:59:00.000Z", {
        totalProcessedTokens: 300,
        totalProcessedScope: "session",
      }),
      completionUsage: usage("2026-06-20T12:00:00.000Z", {
        totalProcessedTokens: 350,
        totalProcessedScope: "session",
      }),
    });
    inconsistentIdentity.continuationIdentity = {
      ...inconsistentIdentity.continuationIdentity,
      backendConfigurationRevision: 99,
    };
    const changedSession = turn({
      id: "changed-session",
      providerId: "codex",
      model: "gpt-session-transition",
      completedAt: "2026-06-20T13:00:00.000Z",
      providerSessionBefore: "thread-before",
      providerSessionAfter: "thread-after",
      startUsage: usage("2026-06-20T12:59:00.000Z", {
        totalProcessedTokens: 400,
        totalProcessedScope: "thread",
      }),
      completionUsage: usage("2026-06-20T13:00:00.000Z", {
        totalProcessedTokens: 500,
        totalProcessedScope: "thread",
      }),
    });
    const unboundStart = turn({
      id: "unbound-start",
      providerId: "codex",
      model: "gpt-unbound-start",
      completedAt: "2026-06-20T14:00:00.000Z",
      providerSessionBefore: "thread-unbound-start",
      startUsage: usage("2026-06-20T13:59:00.000Z", {
        totalProcessedTokens: 600,
        totalProcessedScope: "thread",
        providerSessionBound: false,
      }),
      completionUsage: usage("2026-06-20T14:00:00.000Z", {
        totalProcessedTokens: 700,
        totalProcessedScope: "thread",
      }),
    });
    const unboundCompletion = turn({
      id: "unbound-completion",
      providerId: "cursor",
      model: "cursor-managed",
      completedAt: "2026-06-20T15:00:00.000Z",
      providerSessionBefore: "cursor-unbound-completion",
      startUsage: usage("2026-06-20T14:59:00.000Z", {
        totalProcessedTokens: 800,
        totalProcessedScope: "session",
      }),
      completionUsage: usage("2026-06-20T15:00:00.000Z", {
        totalProcessedTokens: 900,
        totalProcessedScope: "session",
        providerSessionBound: false,
      }),
    });

    const dashboard = projectUsageDashboard([
      proven,
      staleAfterRouteChange,
      inconsistentIdentity,
      changedSession,
      unboundStart,
      unboundCompletion,
    ], range);

    expect(dashboard.totals.processedTokens).toEqual({
      value: 125,
      measuredRequests: 1,
      totalRequests: 6,
      coverage: "partial",
    });
  });

  it("keeps immutable backend revisions separate in model aggregation", () => {
    const dashboard = projectUsageDashboard([
      turn({
        id: "gateway-r1",
        providerId: "claude",
        model: "claude-sonnet",
        completedAt: "2026-06-21T10:00:00.000Z",
        backendProfileId: "custom:gateway",
        backendLabel: "Gateway original",
        backendConfigurationRevision: 1,
        endpointIdentity: "endpoint-original",
        completionUsage: usage("2026-06-21T10:00:00.000Z", {
          totalProcessedTokens: 100,
          totalProcessedScope: "run",
        }),
      }),
      turn({
        id: "gateway-r2",
        providerId: "claude",
        model: "claude-sonnet",
        completedAt: "2026-06-21T11:00:00.000Z",
        backendProfileId: "custom:gateway",
        backendLabel: "Gateway renamed",
        backendConfigurationRevision: 2,
        endpointIdentity: "endpoint-reconfigured",
        completionUsage: usage("2026-06-21T11:00:00.000Z", {
          totalProcessedTokens: 250,
          totalProcessedScope: "run",
        }),
      }),
    ], range);

    expect(dashboard.models).toHaveLength(2);
    expect(usageDashboardSchema(dashboard)).toBe(true);
    expect(JSON.stringify(dashboard)).not.toContain("endpoint-original");
    expect(JSON.stringify(dashboard)).not.toContain("endpoint-reconfigured");
    expect(dashboard.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        backendLabel: "Gateway original",
        backendConfigurationRevision: 1,
        processedTokens: expect.objectContaining({ value: 100 }),
      }),
      expect.objectContaining({
        backendLabel: "Gateway renamed",
        backendConfigurationRevision: 2,
        processedTokens: expect.objectContaining({ value: 250 }),
      }),
    ]));
    expect(usageDashboardSchema({
      ...dashboard,
      models: dashboard.models.map((model) => {
        const {
          backendConfigurationRevision: _backendConfigurationRevision,
          ...withoutRevision
        } = model;
        return withoutRevision;
      }),
    })).toBe(false);
    expect(usageDashboardSchema({
      ...dashboard,
      daily: dashboard.daily.map((day) => {
        const { providers: _providers, ...withoutProviders } = day;
        return withoutProviders;
      }),
    })).toBe(false);
  });
});

describe("estimated cost in the usage dashboard", () => {
  const pricing = (status: UsagePricing["status"] = "fresh"): UsagePricing => {
    const table = parsePriceList({
      "gpt-priced": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.0000002, litellm_provider: "openai" },
      "claude-opus-5-5": { input_cost_per_token: 0.000004, output_cost_per_token: 0.00002, cache_read_input_token_cost: 0.0000002, cache_creation_input_token_cost: 0.000005, litellm_provider: "anthropic" },
    });
    return {
      status,
      source: USAGE_PRICE_LIST_SOURCE,
      fetchedAt: "2026-06-30T00:00:00.000Z",
      modelCount: table.size,
      resolve: (lookup) => resolveModelRates(table, lookup),
    };
  };
  const codexTurn = (id: string, model: string, day: string, tokens: Partial<AgentTurnUsageSnapshot> | null) => turn({
    id,
    providerId: "codex",
    model,
    completedAt: `2026-06-${day}T10:00:00.000Z`,
    completionUsage: tokens ? usage(`2026-06-${day}T10:00:00.000Z`, tokens) : null,
  });

  it("prices measured tokens per category at list prices and reports what it could not price", () => {
    const priced = codexTurn("priced", "gpt-priced", "20", {
      inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 100_000, reasoningOutputTokens: 40_000,
    });
    const unknownModel = codexTurn("unknown", "gpt-unknown-preview", "20", { inputTokens: 500, outputTokens: 500 });
    const unmeasured = codexTurn("unmeasured", "gpt-priced", "21", null);
    const dashboard = projectUsageDashboard([priced, unknownModel, unmeasured], range, "2026-06-30T12:00:00.000Z", pricing());

    expect(dashboard.totals.cost).toEqual({ value: 1.92, measuredRequests: 1, totalRequests: 3, coverage: "partial" });
    expect(dashboard.cost).toEqual({
      status: "estimated",
      reason: null,
      pricing: { status: "fresh", source: USAGE_PRICE_LIST_SOURCE, fetchedAt: "2026-06-30T00:00:00.000Z", modelCount: 2 },
      byType: { input: 0.8, cachedInput: 0.12, cacheWriteInput: 0, output: 1 },
      cacheSavings: 1.08,
    });
    expect(dashboard.daily.find(({ date }) => date === "2026-06-20")?.cost).toMatchObject({ value: 1.92, coverage: "partial" });
    expect(dashboard.daily.find(({ date }) => date === "2026-06-21")?.cost).toMatchObject({ value: null, coverage: "unavailable" });
    expect(dashboard.daily.find(({ date }) => date === "2026-06-22")?.cost).toEqual({ value: 0, measuredRequests: 0, totalRequests: 0, coverage: "complete" });
    expect(dashboard.providers[0]?.cost).toMatchObject({ value: 1.92, measuredRequests: 1, totalRequests: 3 });
    expect(dashboard.models.map(({ model, pricedAs, cost }) => [model, pricedAs, cost.value, cost.coverage])).toEqual(expect.arrayContaining([
      ["gpt-priced", "gpt-priced", 1.92, "partial"],
      ["gpt-unknown-preview", null, null, "unavailable"],
    ]));
    expect(usageDashboardSchema(dashboard)).toBe(true);
  });

  it("prices a Claude family alias through the version recorded with the turn, and leaves a bare alias unpriced", () => {
    const completedAt = "2026-06-20T10:00:00.000Z";
    const tokens = usage(completedAt, {
      totalProcessedTokens: 1_100_000, totalProcessedScope: "run",
      inputTokens: 1_000_000, cachedInputTokens: 800_000, cacheWriteInputTokens: 100_000, outputTokens: 100_000,
    });
    const base = turn({ id: "opus", providerId: "claude", model: "opus", completedAt, completionUsage: tokens });
    const versioned = { ...base, modelSelection: { ...base.modelSelection, alias: "Opus 5.5" } };
    const bare = { ...turn({ id: "bare", providerId: "claude", model: "sonnet", completedAt, completionUsage: tokens }) };
    const dashboard = projectUsageDashboard([versioned, bare], range, completedAt, pricing());
    expect(dashboard.models.map(({ model, pricedAs, cost }) => [model, pricedAs, cost.value])).toEqual(expect.arrayContaining([
      ["opus", "claude-opus-5-5", 3.06],
      ["sonnet", null, null],
    ]));
    expect(dashboard.cost.byType).toEqual({ input: 0.4, cachedInput: 0.16, cacheWriteInput: 0.5, output: 2 });
  });

  it("leaves Cursor unpriced until its token categories are confirmed", () => {
    const table = parsePriceList({ "cursor-priced": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, litellm_provider: "openai" } });
    const everything: UsagePricing = { ...pricing(), resolve: (lookup) => resolveModelRates(table, { ...lookup, model: "cursor-priced" }) };
    const completedAt = "2026-06-20T10:00:00.000Z";
    const cumulative = (inputTokens: number, outputTokens: number) => usage(completedAt, {
      totalProcessedTokens: inputTokens + outputTokens, totalProcessedScope: "session", inputTokens, cachedInputTokens: 0, outputTokens,
    });
    const cursor = turn({
      id: "cursor", providerId: "cursor", model: "cursor-model", completedAt,
      providerSessionBefore: "cursor-session", startUsage: cumulative(100, 10), completionUsage: cumulative(1_100, 110),
    });
    const dashboard = projectUsageDashboard([cursor], range, completedAt, everything);
    expect(dashboard.tokens.input).toMatchObject({ value: 1_000, coverage: "complete" });
    expect(dashboard.models[0]).toMatchObject({ pricedAs: null, cost: { value: null, coverage: "unavailable" } });
    expect(dashboard.cost.status).toBe("unavailable");
  });

  it("says why nothing could be estimated", () => {
    const priced = codexTurn("priced", "gpt-priced", "20", { inputTokens: 10, outputTokens: 10 });
    expect(projectUsageDashboard([priced], range).cost).toMatchObject({
      status: "unavailable",
      reason: "The model price list could not be downloaded, so there is nothing to estimate from.",
    });
    const unknown = codexTurn("unknown", "gpt-unknown-preview", "20", { inputTokens: 10, outputTokens: 10 });
    expect(projectUsageDashboard([unknown], range, undefined, pricing("cached")).cost).toMatchObject({
      status: "unavailable",
      reason: "No request in this range has both a known model price and measured tokens.",
      pricing: { status: "cached" },
    });
    expect(projectUsageDashboard([], range, undefined, pricing()).cost).toMatchObject({ status: "unavailable", reason: null });
  });
});

describe("usage dashboard repository", () => {
  it("reads persisted terminal turns without exposing transcript content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-usage-dashboard-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    const databasePath = join(directory, "inertia.sqlite");
    await mkdir(workspace);
    const store = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Usage", workspace);
    const conversation = store.createConversation(project.id, "Private title", {
      providerId: "claude",
      model: "claude-sonnet",
    });
    const requestedAt = "2026-05-31T23:00:00.000Z";
    const message = store.createMessage(
      conversation.id,
      "A private prompt that must not reach analytics.",
      "user",
      [],
      null,
      requestedAt,
    );
    const created = store.createAgentTurn({
      conversationId: conversation.id,
      runId: crypto.randomUUID(),
      userMessageId: message.id,
      providerId: "claude",
      modelSelection: providerNativeModelSelection({
        providerId: "claude",
        modelId: "claude-sonnet",
      }),
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      requestedAt,
      usageAtStart: null,
      configurationRevision: 0,
      association: "authoritative",
    });
    store.updateAgentTurnLifecycle(created.id, {
      status: "completed",
      startedAt: "2026-05-31T23:00:01.000Z",
      completedAt: "2026-05-31T23:00:04.000Z",
      updatedAt: "2026-05-31T23:00:04.000Z",
      usageAtCompletion: usage("2026-05-31T23:00:04.000Z", {
        totalProcessedTokens: 250,
        totalProcessedScope: "run",
      }),
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    const dashboard = reopened.usageDashboard({
      days: 30,
      fromInclusive: "2026-06-01T00:00:00.000+02:00",
      toExclusive: "2026-07-01T00:00:00.000+02:00",
      endDate: "2026-06-30",
      timeZone: "Europe/Madrid",
    });
    reopened.close();

    expect(dashboard.totals).toMatchObject({
      requestCount: 1,
      runtime: { value: 3_000, coverage: "complete" },
      processedTokens: { value: 250, coverage: "complete" },
    });
    expect(JSON.stringify(dashboard)).not.toContain("private");
    expect(JSON.stringify(dashboard)).not.toContain(conversation.id);
  });
});

function claudeResult(
  capturedAt: string,
  cumulative: number,
  mainLoop = 300,
): AgentTurnUsageSnapshot {
  return usage(capturedAt, parseClaudeUsage({
    num_turns: 2,
    usage: { input_tokens: mainLoop, output_tokens: 20 },
    modelUsage: {
      "claude-sonnet": {
        inputTokens: cumulative * 0.9 - 1_000,
        outputTokens: cumulative * 0.1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 200_000,
      },
      "claude-haiku": {
        inputTokens: 1_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 200_000,
      },
    },
  }, { selectedModelId: "claude-sonnet" })!);
}

function claudeTurn(input: {
  id: string;
  completedAt: string;
  before: string | null;
  after?: string;
  start?: AgentTurnUsageSnapshot | null;
  completion: AgentTurnUsageSnapshot;
}): AgentTurn {
  return turn({
    id: input.id,
    providerId: "claude",
    model: "claude-sonnet",
    completedAt: input.completedAt,
    providerSessionBefore: input.before,
    providerSessionAfter: input.after ?? input.before ?? "claude-session",
    startUsage: input.start ?? null,
    completionUsage: input.completion,
  });
}

describe("Claude cumulative usage in the dashboard", () => {
  it("counts a fresh run and a resumed run once across the session", () => {
    const first = claudeResult("2026-06-20T10:00:00.000Z", 10_000);
    const dashboard = projectUsageDashboard([
      claudeTurn({
        id: "claude-fresh",
        completedAt: "2026-06-20T10:00:00.000Z",
        before: null,
        after: "claude-session",
        completion: first,
      }),
      claudeTurn({
        id: "claude-resumed",
        completedAt: "2026-06-20T11:00:00.000Z",
        before: "claude-session",
        start: first,
        completion: claudeResult("2026-06-20T11:00:00.000Z", 15_000),
      }),
    ], range);

    expect(dashboard.totals.processedTokens).toEqual({
      value: 15_000, measuredRequests: 2, totalRequests: 2, coverage: "complete",
    });
    expect(dashboard.tokens.input.value).toBe(13_500);
    expect(dashboard.tokens.output.value).toBe(1_500);
  });

  it("does not add main-loop usage to subagent-inclusive session totals", () => {
    const dashboard = projectUsageDashboard([
      claudeTurn({
        id: "claude-subagents",
        completedAt: "2026-06-20T10:00:00.000Z",
        before: "claude-session",
        start: claudeResult("2026-06-20T09:00:00.000Z", 4_000, 3_000),
        completion: claudeResult("2026-06-20T10:00:00.000Z", 9_000, 3_000),
      }),
    ], range);

    expect(dashboard.totals.processedTokens.value).toBe(5_000);
    expect(dashboard.tokens.input.value).toBe(4_500);
  });

  it("keeps a resumed run unknown without a comparable session baseline", () => {
    const dashboard = projectUsageDashboard([
      claudeTurn({
        id: "claude-no-baseline",
        completedAt: "2026-06-20T10:00:00.000Z",
        before: "claude-session",
        completion: claudeResult("2026-06-20T10:00:00.000Z", 15_000),
      }),
      claudeTurn({
        id: "claude-legacy-baseline",
        completedAt: "2026-06-20T11:00:00.000Z",
        before: "claude-session",
        start: usage("2026-06-20T10:00:00.000Z", {
          totalProcessedTokens: 15_000,
          totalProcessedScope: "run",
          inputTokens: 13_500,
        }),
        completion: claudeResult("2026-06-20T11:00:00.000Z", 20_000),
      }),
    ], range);

    expect(dashboard.totals.processedTokens).toEqual({
      value: null, measuredRequests: 0, totalRequests: 2, coverage: "unavailable",
    });
    expect(dashboard.tokens.input.value).toBeNull();
  });

  it("starts a new segment after a provider session reset", () => {
    const afterReset = claudeResult("2026-06-20T10:00:00.000Z", 2_000);
    const dashboard = projectUsageDashboard([
      claudeTurn({
        id: "claude-reset",
        completedAt: "2026-06-20T10:00:00.000Z",
        before: "claude-session",
        after: "claude-replacement",
        start: claudeResult("2026-06-20T09:00:00.000Z", 12_000),
        completion: afterReset,
      }),
      claudeTurn({
        id: "claude-after-reset",
        completedAt: "2026-06-20T11:00:00.000Z",
        before: "claude-replacement",
        start: afterReset,
        completion: claudeResult("2026-06-20T11:00:00.000Z", 3_500),
      }),
    ], range);

    expect(dashboard.totals.processedTokens).toEqual({
      value: 1_500, measuredRequests: 1, totalRequests: 2, coverage: "partial",
    });
    expect(dashboard.tokens.output.value).toBe(150);
  });
});
