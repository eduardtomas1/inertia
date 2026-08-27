import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentTurn,
  AgentTurnUsageSnapshot,
  ProviderId,
} from "../../src/shared/contracts";
import { dailyWorkDashboardSchema } from "../../src/shared/contracts/daily-work-schema";
import { nativeModelSelection } from "../../src/shared/model-routing";
import {
  projectDailyWork,
  type DailyWorkConversationSource,
  type DailyWorkRange,
  type DailyWorkTurn,
} from "../../src/server/daily-work";
import { RuntimeStore } from "../../src/server/database";

const directories: string[] = [];
const range: DailyWorkRange = {
  date: "2026-08-17",
  fromInclusive: "2026-08-17T00:00:00.000Z",
  toExclusive: "2026-08-18T00:00:00.000Z",
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

function conversation(
  id: string,
  createdAt: string,
  providerId: ProviderId = "codex",
): DailyWorkConversationSource {
  return {
    id,
    projectId: `project-${id}`,
    projectName: `Project ${id}`,
    title: `Conversation ${id}`,
    providerId,
    createdAt,
  };
}

function turn(input: {
  id: string;
  conversationId: string;
  providerId: ProviderId;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  status: AgentTurn["status"];
  completionUsage?: AgentTurnUsageSnapshot | null;
  association?: AgentTurn["association"];
}): DailyWorkTurn {
  const selection = nativeModelSelection({
    providerId: input.providerId,
    modelId: `${input.providerId}-model`,
  });
  return {
    id: input.id,
    conversationId: input.conversationId,
    providerId: input.providerId,
    modelSelection: selection,
    continuationIdentity: {
      harnessId: selection.harnessId,
      backendProfileId: selection.backendProfileId,
      backendConfigurationRevision: selection.backendConfigurationRevision,
      modelIdentity: selection.modelId,
      endpointIdentity: null,
    },
    model: selection.modelId,
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: input.requestedAt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    updatedAt: input.updatedAt,
    status: input.status,
    usageAtStart: null,
    usageAtCompletion: input.completionUsage ?? null,
    association: input.association ?? "authoritative",
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("daily work projection", () => {
  it("uses only today's runtime slice and settlement tokens while retaining new and active conversations", () => {
    const dashboard = projectDailyWork([
      conversation("continued", "2026-08-16T15:00:00.000Z"),
      conversation("new", "2026-08-17T09:00:00.000Z", "claude"),
      conversation("old-idle", "2026-08-15T09:00:00.000Z"),
    ], [
      turn({
        id: "midnight",
        conversationId: "continued",
        providerId: "codex",
        requestedAt: "2026-08-16T23:49:00.000Z",
        startedAt: "2026-08-16T23:50:00.000Z",
        completedAt: "2026-08-17T00:20:00.000Z",
        updatedAt: "2026-08-17T00:20:00.000Z",
        status: "completed",
        completionUsage: usage("2026-08-17T00:20:00.000Z", {
          totalProcessedTokens: 100,
          totalProcessedScope: "run",
        }),
      }),
      turn({
        id: "missing-usage",
        conversationId: "continued",
        providerId: "claude",
        requestedAt: "2026-08-17T09:59:00.000Z",
        startedAt: "2026-08-17T10:00:00.000Z",
        completedAt: "2026-08-17T10:10:00.000Z",
        updatedAt: "2026-08-17T10:10:00.000Z",
        status: "failed",
      }),
      turn({
        id: "active",
        conversationId: "continued",
        providerId: "cursor",
        requestedAt: "2026-08-17T11:00:00.000Z",
        startedAt: "2026-08-17T11:00:01.000Z",
        completedAt: null,
        updatedAt: "2026-08-17T11:01:00.000Z",
        status: "running",
      }),
      turn({
        id: "inferred",
        conversationId: "new",
        providerId: "claude",
        requestedAt: "2026-08-17T11:00:00.000Z",
        startedAt: "2026-08-17T11:00:00.000Z",
        completedAt: "2026-08-17T11:02:00.000Z",
        updatedAt: "2026-08-17T11:02:00.000Z",
        status: "completed",
        association: "inferred",
      }),
    ], range, "2026-08-17T12:00:00.000Z");

    expect(dashboard.totals).toEqual({
      conversationCount: 2,
      turnCount: 3,
      activeTurnCount: 1,
      runtime: {
        value: 30 * 60_000,
        measuredRequests: 2,
        totalRequests: 2,
        coverage: "complete",
      },
      processedTokens: {
        value: 100,
        measuredRequests: 1,
        totalRequests: 2,
        coverage: "partial",
      },
    });
    expect(dashboard.conversations.map(({ conversationId }) => conversationId))
      .toEqual(["continued", "new"]);
    expect(dashboard.conversations[0]).toMatchObject({
      providerIds: ["claude", "codex", "cursor"],
      running: true,
      createdToday: false,
      turnCount: 3,
      runtime: { value: 30 * 60_000 },
      processedTokens: { value: 100, coverage: "partial" },
    });
    expect(dashboard.conversations[1]).toMatchObject({
      providerIds: ["claude"],
      createdToday: true,
      turnCount: 0,
      runtime: { value: 0, coverage: "complete" },
      processedTokens: { value: 0, coverage: "complete" },
    });
    expect(dashboard.providers.map(({ providerId }) => providerId))
      .toEqual(["codex", "cursor", "claude"]);
    expect(dailyWorkDashboardSchema(dashboard)).toBe(true);
  });

  it("accepts a daylight-saving local day and rejects wider ranges", () => {
    expect(() => projectDailyWork([], [], {
      date: "2026-03-29",
      fromInclusive: "2026-03-28T23:00:00.000Z",
      toExclusive: "2026-03-29T22:00:00.000Z",
      timeZone: "Europe/Madrid",
    })).not.toThrow();
    expect(() => projectDailyWork([], [], {
      ...range,
      toExclusive: "2026-08-19T00:00:00.000Z",
    })).toThrow(/date range is invalid/u);
  });
});

describe("daily work repository", () => {
  it("excludes persisted suspend overlap while retaining archived and new conversations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-16T20:00:00.000Z"));
    const directory = await mkdtemp(join(tmpdir(), "inertia-daily-work-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspace, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Daily", workspace);
    const continued = store.createConversation(project.id, "Private continued title", {
      providerId: "codex",
    });
    const privatePrompt = store.createMessage(
      continued.id,
      "A private prompt that must not reach daily analytics.",
      "user",
      [],
      null,
      "2026-08-16T23:49:00.000Z",
    );
    const settled = store.createAgentTurn({
      conversationId: continued.id,
      runId: crypto.randomUUID(),
      userMessageId: privatePrompt.id,
      providerId: "codex",
      modelSelection: nativeModelSelection({ providerId: "codex" }),
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      requestedAt: "2026-08-16T23:49:00.000Z",
      usageAtStart: null,
      configurationRevision: 0,
      association: "authoritative",
    });
    store.updateAgentTurnLifecycle(settled.id, {
      status: "completed",
      startedAt: "2026-08-16T23:50:00.000Z",
      completedAt: "2026-08-17T00:20:00.000Z",
      updatedAt: "2026-08-17T00:20:00.000Z",
      usageAtCompletion: usage("2026-08-17T00:20:00.000Z", {
        totalProcessedTokens: 250,
        totalProcessedScope: "run",
      }),
    });
    const suspendInterval = {
      id: "11111111-1111-4111-8111-111111111111",
      suspendedAt: "2026-08-16T23:55:00.000Z",
      resumedAt: "2026-08-17T00:10:00.000Z",
    };
    expect(store.systemSuspends.record(suspendInterval))
      .toEqual([continued.id]);
    expect(store.systemSuspends.record(suspendInterval)).toEqual([]);
    expect(store.agentTurn(settled.id).suspendedDurationMs).toBe(15 * 60_000);
    store.archiveConversation(continued.id, true);

    vi.setSystemTime(new Date("2026-08-17T09:00:00.000Z"));
    const createdToday = store.createConversation(project.id, "New empty chat", {
      providerId: "claude",
      activate: false,
    });
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
    const dashboard = store.dailyWork(range);
    store.close();

    expect(dashboard.totals).toMatchObject({
      conversationCount: 2,
      turnCount: 1,
      activeTurnCount: 0,
      runtime: { value: 10 * 60_000, coverage: "complete" },
      processedTokens: { value: 250, coverage: "complete" },
    });
    expect(dashboard.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationId: continued.id,
        createdToday: false,
      }),
      expect.objectContaining({
        conversationId: createdToday.id,
        createdToday: true,
        turnCount: 0,
      }),
    ]));
    expect(JSON.stringify(dashboard)).not.toContain("private prompt");
    expect(dailyWorkDashboardSchema(dashboard)).toBe(true);
  });
});
