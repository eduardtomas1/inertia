import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import { projectCodexRuntimeNotification } from
  "../../src/server/codex/app-server-runtime-notifications";
import { createAgentHarnessEmitter } from
  "../../src/server/provider/agent-harness";
import { stableProviderActivityId } from
  "../../src/server/provider/activity-lifecycle";
import type {
  ProviderActivityEvent,
  ProviderId,
} from "../../src/server/provider/contracts";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import { FakeTurnProvider, FakeTurnScheduler } from
  "../support/fake-turn-provider";

const directories: string[] = [];
const stores: RuntimeStore[] = [];
const PROVIDERS: ProviderId[] = [
  "codex",
  "claude",
  "cursor",
  "kimi",
  "opencode",
];

function providerInfo(providerId: ProviderId): ProviderInfo {
  const field = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: providerId,
    label: providerId,
    command: "fake-" + providerId,
    available: true,
    version: "test",
    executable: "fake-" + providerId,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "provider-test",
      label: "Provider test",
      description: "Lifecycle fixture",
      isDefault: true,
      inputModalities: ["text", "image"],
      reasoningOptions: [{
        value: "high",
        label: "High",
        description: "Lifecycle fixture",
      }],
      defaultReasoningEffort: "high",
      fastMode: null,
    }],
    rateLimits: [],
    metadataState: { models: field, rateLimits: field },
  };
}

async function runtime(providerId: ProviderId = "codex") {
  const directory = await mkdtemp(join(tmpdir(), "inertia-activity-lifecycle-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspace, {
    recoverInterruptedRuns: false,
  });
  stores.push(store);
  const project = store.createProject("Activity project", workspace);
  const conversation = store.createConversation(
    project.id,
    "Activity conversation",
    {
      providerId,
      model: "provider-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
    },
  );
  const provider = new FakeTurnProvider();
  const events: ServerEvent[] = [];
  let sequence = 0;
  const controller = new TurnController(
    store,
    provider,
    new Map<string, AgentApprovalRequest>(),
    new Map<string, AgentInputRequest>(),
    new Map<string, AgentPlan>(),
    {
      broadcast: (event) => events.push(event),
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo(providerId)],
      captureStructuredContext: ({ content }) => ({ visibleRequest: content }),
    },
    {
      scheduler: new FakeTurnScheduler(),
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
      id: () => "activity-id-" + ++sequence,
      turnTimeoutMs: 1_000,
    },
  );
  const queued = controller.queue({
    conversationId: conversation.id,
    content: "Exercise provider activity lifecycles.",
  });
  expect(controller.start(queued.turn.id)).toBe(true);
  await flushPromises();
  const input = provider.input;
  if (!input?.runId || !input.turnId) throw new Error("Turn did not start.");
  const projected: ProviderActivityEvent[] = [];
  const emitter = createAgentHarnessEmitter(
    providerId,
    conversation.id,
    {
      onEvent: (event) => {
        if (event.type !== "activity") return;
        projected.push(event);
        provider.emit(event);
      },
    },
    input.runId,
    input.turnId,
  );
  return {
    store,
    provider,
    controller,
    conversationId: conversation.id,
    turnId: queued.turn.id,
    emitter,
    projected,
  };
}

function turnActivities(
  value: Awaited<ReturnType<typeof runtime>>,
) {
  return value.store.conversationDetail(value.conversationId)?.activities
    .filter(({ turnId }) => turnId === value.turnId) ?? [];
}

async function finish(value: Awaited<ReturnType<typeof runtime>>): Promise<void> {
  value.provider.resolve();
  await flushPromises();
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  while (stores.length > 0) stores.pop()?.close();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("durable provider activity lifecycle contract", () => {
  it("keeps command and tool progress exact for every provider under concurrent same-kind work", async () => {
    for (const providerId of PROVIDERS) {
      const value = await runtime(providerId);
      value.emitter.activity("tool", "started", "Tool", {
        activityId: providerId + ":tool-a",
        detail: "Progress: started A",
      });
      value.emitter.activity("tool", "started", "Tool", {
        activityId: providerId + ":tool-b",
        detail: "Progress: started B",
      });
      value.emitter.activity("command", "started", "Command", {
        activityId: providerId + ":command",
        detail: "Command: npm test",
      });
      value.emitter.activity("tool", "started", "Tool A progressing", {
        activityId: providerId + ":tool-a",
        detail: "Progress: continued A",
      });
      value.emitter.activity("command", "started", "Command", {
        activityId: providerId + ":command",
        detail: "Output: checking",
      });
      value.emitter.activity("tool", "failed", "Tool B failed", {
        activityId: providerId + ":tool-b",
        detail: "Error: B",
      });
      value.emitter.activity("tool", "completed", "Tool A completed", {
        activityId: providerId + ":tool-a",
        detail: "Output: A",
      });
      value.emitter.activity("command", "completed", "Command completed", {
        activityId: providerId + ":command",
        detail: "Output: passed",
      });

      expect(turnActivities(value)).toHaveLength(3);
      expect(turnActivities(value)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          title: "Tool A completed",
          detail: expect.stringContaining("Output: A"),
          status: "completed",
        }),
        expect.objectContaining({
          title: "Tool B failed",
          detail: expect.stringContaining("Error: B"),
          status: "failed",
        }),
        expect.objectContaining({
          title: "Command completed",
          detail: expect.stringContaining("Output: passed"),
          status: "completed",
        }),
      ]));
      expect(turnActivities(value)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "running" }),
      ]));
      await finish(value);
    }
  });

  it("settles long diff sequences and coalesces one plan lifecycle", async () => {
    const value = await runtime();
    for (let index = 0; index < 320; index += 1) {
      value.emitter.activity("tool", "completed", "Patch updated", {
        detail: "Diff: patch " + index,
      });
    }
    const planId = stableProviderActivityId("codex-plan", "plan-lifecycle");
    value.emitter.activity("turn", "started", "Plan updated", {
      activityId: planId,
      detail: "Progress: working",
    });
    value.emitter.activity("turn", "completed", "Plan completed", {
      activityId: planId,
      detail: "Plan: complete",
    });

    const patches = turnActivities(value).filter(({ title }) =>
      title === "Patch updated");
    expect(patches).toHaveLength(320);
    expect(patches.every(({ status }) => status === "completed")).toBe(true);
    expect(turnActivities(value).filter(({ title }) =>
      title.startsWith("Plan"))).toEqual([
      expect.objectContaining({
        title: "Plan completed",
        status: "completed",
      }),
    ]);
    await finish(value);
  });

  it("never closes an identified lifecycle with an anonymous same-label fact", async () => {
    const value = await runtime();
    value.emitter.activity("tool", "started", "Same label", {
      activityId: "identified-tool",
    });
    value.emitter.activity("tool", "completed", "Same label");

    expect(turnActivities(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Same label", status: "running" }),
      expect.objectContaining({ title: "Same label", status: "completed" }),
    ]));

    value.emitter.activity("tool", "completed", "Identified tool completed", {
      activityId: "identified-tool",
    });
    expect(turnActivities(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Identified tool completed",
        status: "completed",
      }),
      expect.objectContaining({ title: "Same label", status: "completed" }),
    ]));
    expect(turnActivities(value)).toHaveLength(2);
    await finish(value);
  });

  it("correlates concurrent MCP, safety, and no-review-ID auto-approval outcomes exactly", async () => {
    const value = await runtime();
    const host = {
      providerThreadId: () => "native-thread",
      activeTurnId: () => "native-turn",
      emitActivity: value.emitter.activity,
    };
    const notify = (method: string, params: Record<string, unknown>): void => {
      expect(projectCodexRuntimeNotification(host, method, params))
        .toBe("handled");
    };
    const owned = { threadId: "native-thread", turnId: "native-turn" };

    notify("mcpServer/startupStatus/updated", {
      threadId: "native-thread",
      name: "alpha",
      status: "starting",
    });
    notify("mcpServer/startupStatus/updated", {
      threadId: "native-thread",
      name: "beta",
      status: "starting",
    });
    notify("mcpServer/startupStatus/updated", {
      threadId: "native-thread",
      name: "beta",
      status: "ready",
    });
    notify("mcpServer/startupStatus/updated", {
      threadId: "native-thread",
      name: "alpha",
      status: "failed",
      error: "alpha failed",
    });
    notify("mcpServer/startupStatus/updated", {
      threadId: "native-thread",
      name: "gamma",
      status: "starting",
    });
    notify("mcpServer/startupStatus/updated", {
      threadId: "native-thread",
      name: "gamma",
      status: "cancelled",
    });

    for (const model of ["model-a", "model-b"]) {
      notify("model/safetyBuffering/updated", {
        ...owned,
        model,
        showBufferingUi: true,
      });
    }
    for (const model of ["model-b", "model-a"]) {
      notify("model/safetyBuffering/updated", {
        ...owned,
        model,
        showBufferingUi: false,
      });
    }

    for (const [targetItemId, startedAtMs] of [["item-a", 10], ["item-b", 20]] as const) {
      notify("item/autoApprovalReview/started", {
        ...owned,
        targetItemId,
        startedAtMs,
        action: { type: "command", command: "run " + targetItemId },
        review: { status: "inProgress" },
      });
    }
    notify("item/autoApprovalReview/completed", {
      ...owned,
      targetItemId: "item-b",
      startedAtMs: 20,
      action: { type: "command", command: "run item-b" },
      review: { status: "denied" },
    });
    notify("item/autoApprovalReview/completed", {
      ...owned,
      targetItemId: "item-a",
      startedAtMs: 10,
      action: { type: "command", command: "run item-a" },
      review: { status: "approved" },
    });

    const outcomes = turnActivities(value).map(({ title, status }) =>
      [title, status]);
    expect(outcomes).toHaveLength(7);
    expect(outcomes).toEqual(expect.arrayContaining([
      ["MCP server failed to start · alpha", "failed"],
      ["MCP server ready · beta", "completed"],
      ["MCP server startup cancelled · gamma", "completed"],
      ["Approval auto-review approved", "completed"],
      ["Approval auto-review denied", "failed"],
    ]));
    expect(outcomes.filter(([title]) =>
      title === "Codex safety review completed")).toHaveLength(2);
    expect(turnActivities(value).some(({ status }) => status === "running"))
      .toBe(false);
    await finish(value);
  });

  it("isolates auto-approval review IDs from live provider item IDs", async () => {
    const value = await runtime();
    const collisionId = "shared-provider-identity";
    value.emitter.activity("tool", "started", "Colliding tool", {
      activityId: collisionId,
    });
    const host = {
      providerThreadId: () => "native-thread",
      activeTurnId: () => "native-turn",
      emitActivity: value.emitter.activity,
    };
    const owned = { threadId: "native-thread", turnId: "native-turn" };
    expect(projectCodexRuntimeNotification(
      host,
      "item/autoApprovalReview/started",
      { ...owned, reviewId: collisionId, review: { status: "inProgress" } },
    )).toBe("handled");
    expect(projectCodexRuntimeNotification(
      host,
      "item/autoApprovalReview/completed",
      { ...owned, reviewId: collisionId, review: { status: "approved" } },
    )).toBe("handled");
    value.emitter.activity("tool", "completed", "Colliding tool completed", {
      activityId: collisionId,
    });

    expect(turnActivities(value)).toHaveLength(2);
    expect(turnActivities(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Approval auto-review approved",
        status: "completed",
      }),
      expect.objectContaining({
        title: "Colliding tool completed",
        status: "completed",
      }),
    ]));
    await finish(value);
  });
});
