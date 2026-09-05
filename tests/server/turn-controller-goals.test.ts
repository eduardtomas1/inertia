import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalDecision,
  ProviderInfo,
} from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import {
  providerRunTerminal,
  type ProviderEvent,
  type ProviderGoalMutation,
  type ProviderGoalSnapshot,
  type ProviderRunCallbacks,
  type ProviderRunFailure,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  TurnController,
  type TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller";
import { resolveNativeModelRoute } from "./model-route-fixture";

class GoalProvider implements TurnProviderRuntime {
  providerCapabilityAvailable(): boolean {
    return true;
  }
  callbacks: ProviderRunCallbacks | null = null;
  input: ProviderRunInput | null = null;
  runCount = 0;
  running = false;
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
    this.running = true;
    callbacks.onStarted?.();
    return new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  emit(event: ProviderEvent): void {
    this.callbacks?.onEvent?.(event);
  }

  resolve(
    status: "completed" | "failed" = "completed",
    failure?: ProviderRunFailure,
  ): void {
    if (!this.input) throw new Error("Provider has not started.");
    this.running = false;
    this.resolveResult?.({
      ...providerRunTerminal(this.input, status, failure),
      text: "",
      textTruncated: false,
      exitCode: status === "completed" ? 0 : 1,
      signal: null,
      cleanupConfirmed: true,
      ...(failure ? { failure } : {}),
    });
  }

  cancel(): boolean {
    this.running = false;
    return true;
  }

  stopOwned(): Promise<"settled"> {
    return Promise.resolve("settled");
  }

  isRunning(): boolean {
    return this.running;
  }

  ownsRun(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): boolean {
    return this.running
      && this.input?.conversationId === conversationId
      && this.input.runId === identity.runId
      && this.input.turnId === identity.turnId;
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
  it("blocks ordinary turn admission while an idle goal mutation owns the route", async () => {
    const runtime = await goalRuntime();
    let release!: () => void;
    const pending = runtime.controller.withNativeGoalMutation(
      runtime.conversationId,
      async () => await new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    expect(() => runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Do not race the control mutation.",
    })).toThrow("A provider goal update is in progress");

    release();
    await pending;
    expect(runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Start after the control mutation.",
    }).turn.status).toBe("queued");
  });

  it("persists continuation expiry as a goal timeout, not a process exit", async () => {
    const runtime = await goalRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Continue the active goal.",
    });
    runtime.controller.start(queued.turn.id);

    runtime.provider.resolve("failed", {
      reason: "goal-continuation-timeout",
      message: "Codex did not start the next goal turn in time.",
    });

    await vi.waitFor(() => expect(runtime.store.agentTurn(queued.turn.id))
      .toMatchObject({
        status: "failed",
        terminalReason: "goal-continuation-timeout",
      }));
  });

  it("establishes a provider thread from a goal as the first action", async () => {
    const runtime = await goalRuntime();
    const pendingGoal = runtime.controller.setNativeGoal({
      conversationId: runtime.conversationId,
      objective: "Finish the reliable flow",
      status: "active",
      tokenBudget: 12_000,
    });
    await vi.waitFor(() => expect(runtime.provider.runCount).toBe(1));
    expect(runtime.provider.input).toMatchObject({
      sessionId: undefined,
      goalStart: {
        objective: "Finish the reliable flow",
        tokenBudget: 12_000,
      },
      goalContinuationExpected: true,
    });
    runtime.provider.emit({
      ...identity(runtime),
      type: "session",
      sessionId: "thread-goal-start",
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

  it("resumes execution when a goal remains active after its run ends", async () => {
    const runtime = await goalRuntime();
    const first = runtime.controller.setNativeGoal({
      conversationId: runtime.conversationId,
      objective: "Survive a detached runner",
      status: "active",
      tokenBudget: 12_000,
    });
    await vi.waitFor(() => expect(runtime.provider.runCount).toBe(1));
    runtime.provider.emit({
      ...identity(runtime),
      type: "session",
      sessionId: "thread-resumable-goal",
    });
    const activeGoal: ProviderGoalSnapshot = {
      objective: "Survive a detached runner",
      status: "active",
      tokenBudget: 12_000,
      tokensUsed: 600,
      timeUsedSeconds: 4,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:04.000Z",
    };
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-updated",
      sessionId: "thread-resumable-goal",
      goal: activeGoal,
    });
    await expect(first).resolves.toEqual(activeGoal);
    runtime.provider.resolve("failed");
    await vi.waitFor(() =>
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false));
    expect(runtime.store.agentTurn(runtime.provider.input!.turnId!))
      .toMatchObject({ status: "failed" });

    const resumed = runtime.controller.setNativeGoal({
      conversationId: runtime.conversationId,
      status: "active",
    });
    await vi.waitFor(() => expect(runtime.provider.runCount).toBe(2));
    expect(runtime.provider.input).toMatchObject({
      sessionId: "thread-resumable-goal",
      prompt: expect.stringContaining("/goal Survive a detached runner"),
      goalStart: {},
      goalContinuationExpected: true,
    });
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-updated",
      sessionId: "thread-resumable-goal",
      goal: activeGoal,
    });
    await expect(resumed).resolves.toEqual(activeGoal);
  });

  it("acknowledges a goal that becomes terminal before its first turn", async () => {
    const runtime = await goalRuntime();
    const warmup = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the provider thread.",
    });
    runtime.controller.start(warmup.turn.id);
    runtime.provider.emit({
      ...identity(runtime),
      type: "session",
      sessionId: "thread-terminal-goal-start",
    });
    runtime.provider.resolve();
    await vi.waitFor(() =>
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false));

    const pendingGoal = runtime.controller.setNativeGoal({
      conversationId: runtime.conversationId,
      objective: "Finish immediately",
      status: "active",
      tokenBudget: 1_000,
    });
    await vi.waitFor(() => expect(runtime.provider.runCount).toBe(2));
    const completedGoal: ProviderGoalSnapshot = {
      objective: "Finish immediately",
      status: "complete",
      tokenBudget: 1_000,
      tokensUsed: 250,
      timeUsedSeconds: 1,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:01.000Z",
    };
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-updated",
      sessionId: "thread-terminal-goal-start",
      goal: completedGoal,
    });

    await expect(pendingGoal).resolves.toEqual(completedGoal);
    runtime.provider.resolve();
    await vi.waitFor(() =>
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false));
  });

  it("returns the latest same-revision goal projected after the start acknowledgement", async () => {
    const runtime = await goalRuntime();
    const warmup = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the provider thread.",
    });
    runtime.controller.start(warmup.turn.id);
    runtime.provider.emit({
      ...identity(runtime),
      type: "session",
      sessionId: "thread-latest-goal-start",
    });
    runtime.provider.resolve();
    await vi.waitFor(() =>
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false));

    const pendingGoal = runtime.controller.setNativeGoal({
      conversationId: runtime.conversationId,
      objective: "Finish within one revision",
      status: "active",
      tokenBudget: 1_000,
    });
    await vi.waitFor(() => expect(runtime.provider.runCount).toBe(2));
    const activeGoal: ProviderGoalSnapshot = {
      objective: "Finish within one revision",
      status: "active",
      tokenBudget: 1_000,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    const completedGoal: ProviderGoalSnapshot = {
      ...activeGoal,
      status: "complete",
      tokensUsed: 250,
      timeUsedSeconds: 1,
    };
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-updated",
      sessionId: "thread-latest-goal-start",
      goal: activeGoal,
    });
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-updated",
      sessionId: "thread-latest-goal-start",
      goal: completedGoal,
    });

    await expect(pendingGoal).resolves.toMatchObject({
      status: "complete",
      tokensUsed: 250,
    });
    expect(runtime.store.agentGoals(runtime.conversationId)).toContainEqual(
      expect.objectContaining({ status: "complete", tokensUsed: 250 }),
    );
  });

  it("does not revive a goal cleared after its start acknowledgement", async () => {
    const runtime = await goalRuntime();
    const warmup = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the provider thread.",
    });
    runtime.controller.start(warmup.turn.id);
    runtime.provider.emit({
      ...identity(runtime),
      type: "session",
      sessionId: "thread-cleared-goal-start",
    });
    runtime.provider.resolve();
    await vi.waitFor(() =>
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false));

    const pendingGoal = runtime.controller.setNativeGoal({
      conversationId: runtime.conversationId,
      objective: "Clear before acknowledgement settles",
      status: "active",
      tokenBudget: 1_000,
    });
    await vi.waitFor(() => expect(runtime.provider.runCount).toBe(2));
    const activeGoal: ProviderGoalSnapshot = {
      objective: "Clear before acknowledgement settles",
      status: "active",
      tokenBudget: 1_000,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-updated",
      sessionId: "thread-cleared-goal-start",
      goal: activeGoal,
    });
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-cleared",
      sessionId: "thread-cleared-goal-start",
    });

    await expect(pendingGoal).rejects.toThrow(
      "The Codex goal was cleared before it was confirmed.",
    );
    expect(runtime.store.agentGoals(runtime.conversationId)).toEqual([]);
  });

  it("allows a confirmed goal recreation after a pre-response clear", async () => {
    const runtime = await goalRuntime();
    const warmup = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the provider thread.",
    });
    runtime.controller.start(warmup.turn.id);
    runtime.provider.emit({
      ...identity(runtime),
      type: "session",
      sessionId: "thread-recreated-goal-start",
    });
    runtime.provider.resolve();
    await vi.waitFor(() =>
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false));

    const pendingGoal = runtime.controller.setNativeGoal({
      conversationId: runtime.conversationId,
      objective: "Recreate after a pre-response clear",
      status: "active",
      tokenBudget: 1_000,
    });
    await vi.waitFor(() => expect(runtime.provider.runCount).toBe(2));
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-cleared",
      sessionId: "thread-recreated-goal-start",
    });
    const recreatedGoal: ProviderGoalSnapshot = {
      objective: "Recreate after a pre-response clear",
      status: "active",
      tokenBudget: 1_000,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    runtime.provider.emit({
      ...identity(runtime),
      type: "goal-updated",
      sessionId: "thread-recreated-goal-start",
      goal: recreatedGoal,
    });

    await expect(pendingGoal).resolves.toEqual(recreatedGoal);
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
