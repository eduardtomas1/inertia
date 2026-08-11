import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentTurn,
  AgentTurnUsageSnapshot,
  ProviderId,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import {
  projectUsageDashboard,
  type UsageDashboardRange,
} from "../../src/server/usage-dashboard";

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
  startUsage?: AgentTurnUsageSnapshot | null;
  completionUsage?: AgentTurnUsageSnapshot | null;
  backendProfileId?: string;
  backendLabel?: string;
  association?: AgentTurn["association"];
}): AgentTurn {
  const completedAt = input.completedAt;
  const runtimeMs = input.runtimeMs === undefined ? 5_000 : input.runtimeMs;
  const selection = {
    ...nativeModelSelection({
      providerId: input.providerId,
      modelId: input.model,
    }),
    ...(input.backendProfileId
      ? { backendProfileId: input.backendProfileId }
      : {}),
    ...(input.backendLabel
      ? { backendProfileDisplayName: input.backendLabel }
      : {}),
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
      endpointIdentity: null,
    },
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    model: input.model,
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: runtimeMs === null
      ? completedAt
      : new Date(Date.parse(completedAt) - runtimeMs - 1_000).toISOString(),
    startedAt: runtimeMs === null
      ? null
      : new Date(Date.parse(completedAt) - runtimeMs).toISOString(),
    completedAt,
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
        value: 30_000,
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
      });
    expect(dashboard.daily.find(({ date }) => date === "2026-06-11"))
      .toMatchObject({
        requestCount: 1,
        processedTokens: { value: null, coverage: "unavailable" },
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
      value: 1_740,
      measuredRequests: 5,
      coverage: "partial",
    });
    expect(dashboard.cost).toEqual({
      status: "unavailable",
      reason: "Inertia does not persist versioned model pricing or provider invoice charges.",
    });
    expect(JSON.stringify(dashboard)).not.toContain("conversation-codex");
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
    const requestedAt = "2026-06-15T10:00:00.000Z";
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
      modelSelection: nativeModelSelection({
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
      startedAt: "2026-06-15T10:00:01.000Z",
      completedAt: "2026-06-15T10:00:04.000Z",
      updatedAt: "2026-06-15T10:00:04.000Z",
      usageAtCompletion: usage("2026-06-15T10:00:04.000Z", {
        totalProcessedTokens: 250,
        totalProcessedScope: "run",
      }),
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    const dashboard = reopened.usageDashboard(range);
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
