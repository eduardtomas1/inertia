import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalDecision,
  ProviderInfo,
} from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import type {
  ProviderEvent,
  ProviderGoalMutation,
  ProviderGoalSnapshot,
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  TurnController,
  type TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller";
import { resolveNativeModelRoute } from "./model-route-fixture";

class GoalProvider implements TurnProviderRuntime {
  callbacks: ProviderRunCallbacks | null = null;
  input: ProviderRunInput | null = null;
  runCount = 0;
  readonly goalMutations: Array<{
    conversationId: string;
    input: ProviderGoalMutation;
    identity: { runId: string; turnId: string };
  }> = [];
  readonly goalClears: Array<{
    conversationId: string;
    identity: { runId: string; turnId: string };
  }> = [];
  private resolveResult: ((result: ProviderRunResult) => void) | null = null;

  resolveModelRoute = resolveNativeModelRoute;

  harnessIdFor(input: ProviderRunInput): string {
    return input.harnessId;
  }

  run(
    input: ProviderRunInput,
    callbacks: ProviderRunCallbacks,
  ): Promise<ProviderRunResult> {
    this.input = input;
    this.callbacks = callbacks;
    this.runCount += 1;
    callbacks.onStarted?.();
    return new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  emit(event: ProviderEvent): void {
    this.callbacks?.onEvent?.(event);
  }

  resolve(): void {
    if (!this.input) throw new Error("Provider has not started.");
    this.resolveResult?.({
      providerId: this.input.providerId,
      conversationId: this.input.conversationId ?? this.input.threadId,
      status: "completed",
      text: "",
      textTruncated: false,
      exitCode: 0,
      signal: null,
    });
  }

  cancel(): boolean {
    return true;
  }

  stopOwned(): Promise<"settled"> {
    return Promise.resolve("settled");
  }

  isRunning(): boolean {
    return this.callbacks !== null;
  }

  respondToApproval(
    _conversationId: string,
    _requestId: string,
    _decision: AgentApprovalDecision,
  ): boolean {
    return false;
  }

  respondToInput(): boolean {
    return false;
  }

  async setGoal(
    conversationId: string,
    input: ProviderGoalMutation,
    identity: { runId: string; turnId: string },
  ): Promise<ProviderGoalSnapshot> {
    this.goalMutations.push({ conversationId, input, identity });
    return {
      objective: input.objective ?? "Existing objective",
      status: input.status,
      tokenBudget: input.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
  }

  async clearGoal(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): Promise<boolean> {
    this.goalClears.push({ conversationId, identity });
    return true;
  }

  async disposeAll(): Promise<void> {}
}

interface GoalRuntime {
  directory: string;
  store: RuntimeStore;
  provider: GoalProvider;
  controller: TurnController;
  conversationId: string;
}

const runtimes: GoalRuntime[] = [];

function providerInfo(): ProviderInfo {
  const field = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: "codex",
    label: "Codex",
    command: "fake-codex",
    available: true,
    version: "test",
    executable: "fake-codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "gpt-test",
      label: "GPT Test",
      description: "Fake model",
      isDefault: true,
      inputModalities: ["text", "image"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
    }],
    rateLimits: [],
    metadataState: { models: field, rateLimits: field },
  };
}

async function goalRuntime(): Promise<GoalRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-turn-goals-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(
    join(directory, "inertia.sqlite"),
    workspace,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject("Goal project", workspace);
  const conversation = store.createConversation(project.id, "Goal conversation", {
    providerId: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
  });
  const provider = new GoalProvider();
  let sequence = 0;
  const controller = new TurnController(
    store,
    provider,
    new Map(),
    new Map(),
    new Map(),
    {
      broadcast: () => undefined,
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo()],
    },
    {
      id: () => `goal-controller-id-${++sequence}`,
      clock: () => new Date(1_893_456_000_000 + sequence),
      turnTimeoutMs: 1_000,
    },
  );
  const runtime = {
    directory,
    store,
    provider,
    controller,
    conversationId: conversation.id,
  };
  runtimes.push(runtime);
  return runtime;
}

function identity(runtime: GoalRuntime) {
  const input = runtime.provider.input;
  if (!input?.runId || !input.turnId) throw new Error("Turn is not started.");
  return {
    providerId: input.providerId,
    conversationId: runtime.conversationId,
    runId: input.runId,
    turnId: input.turnId,
  } as const;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    await runtime.controller.dispose();
    runtime.store.close();
    await rm(runtime.directory, { recursive: true, force: true });
  }));
});

describe("TurnController native goal lifecycle", () => {
  it("runs an idle goal durably while ordinary follow-ups remain ordinary", async () => {
    const runtime = await goalRuntime();
    const warmup = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the provider thread.",
    });
    runtime.controller.start(warmup.turn.id);
    runtime.provider.emit({
      ...identity(runtime),
      type: "session",
      sessionId: "thread-goal-start",
    });
    runtime.provider.resolve();
    await vi.waitFor(() =>
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false));

    const pendingGoal = runtime.controller.setNativeGoal({
      conversationId: runtime.conversationId,
      objective: "Finish the reliable flow",
      status: "active",
      tokenBudget: 12_000,
    });
    await vi.waitFor(() => expect(runtime.provider.runCount).toBe(2));
    expect(runtime.provider.input).toMatchObject({
      sessionId: "thread-goal-start",
      goalStart: {
        objective: "Finish the reliable flow",
        tokenBudget: 12_000,
      },
      goalContinuationExpected: true,
    });
    const activeGoal: ProviderGoalSnapshot = {
      objective: "Finish the reliable flow",
      status: "active",
      tokenBudget: 12_000,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-updated",
      sessionId: "thread-goal-start",
      goal: activeGoal,
    });
    await expect(pendingGoal).resolves.toEqual(activeGoal);
    expect(runtime.store.conversationDetail(runtime.conversationId)?.messages)
      .toContainEqual(expect.objectContaining({
        role: "user",
        content: "/goal Finish the reliable flow",
      }));
    runtime.provider.resolve();
    await vi.waitFor(() =>
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false));

    const ordinary = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Report current progress.",
    });
    runtime.controller.start(ordinary.turn.id);
    expect(runtime.provider.input).toMatchObject({
      prompt: expect.stringContaining("Report current progress."),
      goalContinuationExpected: true,
    });
    expect(runtime.provider.input).not.toHaveProperty("goalStart");
  });

  it("routes live mutations through the exact active turn identity", async () => {
    const runtime = await goalRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Keep this run active.",
    });
    runtime.controller.start(queued.turn.id);
    const active = identity(runtime);

    await expect(runtime.controller.setNativeGoal({
      conversationId: runtime.conversationId,
      status: "paused",
    })).resolves.toMatchObject({ status: "paused" });
    await expect(runtime.controller.clearNativeGoal(runtime.conversationId))
      .resolves.toBe(true);
    expect(runtime.provider.goalMutations).toEqual([{
      conversationId: runtime.conversationId,
      input: { status: "paused" },
      identity: { runId: active.runId, turnId: active.turnId },
    }]);
    expect(runtime.provider.goalClears).toEqual([{
      conversationId: runtime.conversationId,
      identity: { runId: active.runId, turnId: active.turnId },
    }]);
  });
});
