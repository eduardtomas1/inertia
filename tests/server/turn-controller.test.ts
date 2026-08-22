import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  ModelSelection,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  nativeBackendProfile,
  nativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../../src/shared/model-routing";
import type {
  ProviderEvent,
  ProviderGoalSnapshot,
} from "../../src/server/provider/contracts";
import {
  TurnController,
  type TurnControllerHooks,
  type TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller";
import { recoverInterruptedTurns } from "../../src/server/runtime/turns/turn-recovery";
import { BUILD_MODE_INSTRUCTION } from "../../src/server/runtime/turns/request-context";
import { resolveNativeModelRoute } from "./model-route-fixture";
import {
  FakeTurnProvider,
  FakeTurnScheduler,
} from "../support/fake-turn-provider";

const directories: string[] = [];

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
      fastMode: {
        providerValue: "priority",
        label: "Fast",
        description: "Faster responses",
        isDefault: false,
      },
    }, {
      id: "gpt-next",
      label: "GPT Next",
      description: "Second fake model",
      isDefault: false,
      inputModalities: ["text", "image"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
      fastMode: {
        providerValue: "priority",
        label: "Fast",
        description: "Faster responses",
        isDefault: false,
      },
    }],
    rateLimits: [],
    metadataState: { models: field, rateLimits: field },
  };
}

interface TestRuntime {
  directory: string;
  workspace: string;
  store: RuntimeStore;
  provider: FakeTurnProvider;
  scheduler: FakeTurnScheduler;
  controller: TurnController;
  conversationId: string;
  events: ServerEvent[];
  settled: string[];
  gitArtifacts: string[];
  metadataRefreshes: string[];
  attachmentReleases: string[][];
}
interface TestRuntimeOptions {
  interactionMode?: "build" | "plan";
  modelSelection?: ModelSelection;
  resolveModelRoute?: TurnProviderRuntime["resolveModelRoute"];
}
async function testRuntime(
  hookOverrides: Partial<TurnControllerHooks> = {},
  options: TestRuntimeOptions = {},
): Promise<TestRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-turn-controller-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  directories.push(directory);
  const store = new RuntimeStore(
    join(directory, "inertia.sqlite"),
    workspace,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject("Turn project", workspace);
  const conversation = store.createConversation(project.id, "Turn conversation", {
    ...(options.modelSelection
      ? { modelSelection: options.modelSelection }
      : {
          providerId: "codex" as const,
          model: "gpt-test",
          reasoningEffort: "high",
        }),
    interactionMode: options.interactionMode ?? "build",
    accessMode: "supervised",
  });
  const provider = new FakeTurnProvider();
  if (options.resolveModelRoute) {
    provider.resolveModelRoute = options.resolveModelRoute;
  }
  const scheduler = new FakeTurnScheduler();
  const events: ServerEvent[] = [];
  const settled: string[] = [];
  const gitArtifacts: string[] = [];
  const metadataRefreshes: string[] = [];
  const attachmentReleases: string[][] = [];
  const pendingApprovals = new Map<string, AgentApprovalRequest>();
  const pendingInputs = new Map<string, AgentInputRequest>();
  const plans = new Map<string, AgentPlan>();
  let sequence = 0;
  let clockMs = Date.parse("2030-01-01T00:00:00.000Z");
  const controller = new TurnController(
    store,
    provider,
    pendingApprovals,
    pendingInputs,
    plans,
    {
      broadcast: (event) => events.push(event),
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo()],
      captureStructuredContext: ({ content }) => ({ visibleRequest: content }),
      onStructuredContextCaptured: ({ turn }) => {
        settled.push(`context:${turn.id}`);
      },
      captureGitArtifacts: ({ turn }) => {
        gitArtifacts.push(turn.id);
      },
      refreshProviderMetadata: ({ turnId }) => {
        metadataRefreshes.push(turnId);
      },
      releaseTurnAttachments: ({ attachmentIds }) => {
        attachmentReleases.push([...attachmentIds]);
      },
      onTurnSettled: (turn) => {
        settled.push(`${turn.status}:${turn.id}`);
      },
      ...hookOverrides,
    },
    {
      scheduler,
      clock: () => new Date(clockMs++),
      id: () => `controller-id-${++sequence}`,
      turnTimeoutMs: 1_000,
    },
  );
  return {
    directory,
    workspace,
    store,
    provider,
    scheduler,
    controller,
    conversationId: conversation.id,
    events,
    settled,
    gitArtifacts,
    metadataRefreshes,
    attachmentReleases,
  };
}
async function testAttachment(
  runtime: Pick<TestRuntime, "workspace">,
  id: string,
  name = `${id}.png`,
) {
  const path = join(runtime.workspace, name);
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  await writeFile(path, bytes);
  return {
    id,
    name,
    path,
    mimeType: "image/png" as const,
    size: bytes.byteLength,
  };
}
function identity(runtime: TestRuntime) {
  const input = runtime.provider.input;
  if (!input?.runId || !input.turnId) throw new Error("Turn is not started.");
  return {
    providerId: input.providerId,
    conversationId: runtime.conversationId,
    runId: input.runId,
    turnId: input.turnId,
  } as const;
}
type TestSubagentEvent = Extract<ProviderEvent, { type: "subagent" }>;
type TestSubagentUpdate = Partial<TestSubagentEvent> & Pick<
  TestSubagentEvent, "sequence" | "providerTaskId" | "status" | "isLive">;
function emitSubagent(runtime: TestRuntime, event: TestSubagentUpdate): void {
  runtime.provider.emit({
    ...identity(runtime),
    type: "subagent",
    providerAgentId: null, parentProviderAgentId: null,
    parentProviderToolUseId: null, providerToolUseId: null,
    providerRole: null, providerName: null, providerStatus: null,
    description: null, progress: null, result: null,
    ...event,
  });
}
async function flushPromises(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});
describe("TurnController authoritative lifecycle", () => {
  it("persists parent follow-ups only after the active harness acknowledges them", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Start the parent turn." });
    runtime.controller.start(queued.turn.id);
    const beforeRejected = runtime.store.snapshot();
    vi.spyOn(runtime.provider, "steer").mockResolvedValue(false);
    const rejectedAdmission = runtime.controller.acquireFollowUpAdmission(runtime.conversationId)!;
    expect(await runtime.controller.steer(rejectedAdmission, {
      content: "Do not leave this rejected follow-up behind.", imagePaths: [],
    })).toBeNull();
    rejectedAdmission.release();
    expect(runtime.store.snapshot()).toEqual(beforeRejected);
    let acknowledgeFollowUp!: (accepted: boolean) => void;
    vi.mocked(runtime.provider.steer).mockImplementation(async (_conversationId, input) => {
      runtime.provider.steerCalls.push(input.content);
      return await new Promise<boolean>((resolve) => { acknowledgeFollowUp = resolve; });
    });
    const beforeAcknowledgement = runtime.store.snapshot().messages;
    const admission = runtime.controller.acquireFollowUpAdmission(runtime.conversationId)!;
    const pendingFollowUp = runtime.controller.steer(admission, {
      content: "Inspect the edge case next.",
      imagePaths: [],
    });
    await flushPromises();
    expect(runtime.store.snapshot().messages).toEqual(beforeAcknowledgement);
    runtime.provider.emit({
      ...identity(runtime), type: "activity", kind: "reasoning", phase: "completed",
      label: "Observed during acknowledgement", activityId: "follow-up-race",
    });
    const interimActivity = runtime.store.snapshot().activities.find(({ title }) => title === "Observed during acknowledgement");
    acknowledgeFollowUp(true);
    const followedUp = await pendingFollowUp;
    admission.release();
    runtime.provider.resolve();
    await flushPromises();
    expect(followedUp).toMatchObject({ role: "user", turnId: queued.turn.id, content: "Inspect the edge case next." });
    expect(followedUp!.createdAt < interimActivity!.createdAt).toBe(true);
    expect(runtime.store.conversationDetail(runtime.conversationId)?.messages)
      .toContainEqual(expect.objectContaining({ id: followedUp?.id }));
    const databasePath = join(runtime.directory, "inertia.sqlite");
    runtime.store.close();
    const reopened = new RuntimeStore(databasePath, runtime.workspace, { recoverInterruptedRuns: false });
    const persisted = reopened.conversationDetail(runtime.conversationId);
    expect(persisted?.messages.find(({ id }) => id === followedUp?.id)?.createdAt).toBe(followedUp?.createdAt);
    expect(persisted?.activities.find(({ id }) => id === interimActivity?.id)?.createdAt).toBe(interimActivity?.createdAt);
    reopened.close();
  });
  it("persists and broadcasts only native goals for the active Codex thread", async () => {
    const synchronizedSessions: string[] = [];
    let recoverRefreshWarning = false;
    const runtime = await testRuntime({
      onNativeGoalSynchronized: ({ providerSessionId }) => {
        synchronizedSessions.push(providerSessionId);
        const recovered = recoverRefreshWarning;
        recoverRefreshWarning = false;
        return recovered;
      },
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Track the provider-owned objective.",
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);
    runtime.provider.emit({
      ...base,
      type: "session",
      sessionId: "thread-goal-1",
    });
    runtime.provider.emit({
      ...base,
      type: "goal-updated",
      providerId: "codex",
      sessionId: "thread-other",
      goal: {
        objective: "Ignore an unrelated thread",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(runtime.store.agentGoals(runtime.conversationId)).toEqual([]);

    const authoritativeGoal = {
      objective: "Keep the workflow authoritative",
      status: "active" as const,
      tokenBudget: 12_000,
      tokensUsed: 250,
      timeUsedSeconds: 9,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:09.000Z",
    };
    const emitGoal = (goal: ProviderGoalSnapshot) => runtime.provider.emit({
      ...base,
      type: "goal-updated",
      providerId: "codex",
      sessionId: "thread-goal-1",
      goal,
    });
    emitGoal(authoritativeGoal);
    expect(runtime.store.agentGoals(runtime.conversationId)).toEqual([
      expect.objectContaining({
        source: "codex-native",
        providerSessionId: "thread-goal-1",
        objective: "Keep the workflow authoritative",
      }),
    ]);
    expect(runtime.events).toContainEqual(expect.objectContaining({
      type: "agent.goal.updated",
      goal: expect.objectContaining({
        providerSessionId: "thread-goal-1",
      }),
    }));
    expect(synchronizedSessions).toEqual(["thread-goal-1"]);
    recoverRefreshWarning = true;
    emitGoal(authoritativeGoal);
    expect(runtime.events.filter((event) =>
      event.type === "agent.goal.updated")).toHaveLength(2);
    emitGoal({
      ...authoritativeGoal,
      status: "complete",
      tokensUsed: 300,
      timeUsedSeconds: 10,
    });
    expect(runtime.store.agentGoals(runtime.conversationId)).toEqual([
      expect.objectContaining({
        status: "complete",
        tokensUsed: 300,
        timeUsedSeconds: 10,
      }),
    ]);
    expect(runtime.events.filter((event) =>
      event.type === "agent.goal.updated")).toHaveLength(3);

    runtime.provider.emit({
      ...base,
      type: "goal-cleared",
      providerId: "codex",
      sessionId: "thread-goal-1",
    });
    expect(runtime.store.agentGoals(runtime.conversationId)).toEqual([]);
    expect(runtime.events).toContainEqual({
      type: "agent.goal.cleared",
      conversationId: runtime.conversationId,
      source: "codex-native",
    });
    expect(synchronizedSessions).toEqual([
      "thread-goal-1",
      "thread-goal-1",
      "thread-goal-1",
      "thread-goal-1",
    ]);
    recoverRefreshWarning = true;
    runtime.provider.emit({
      ...base,
      type: "goal-cleared",
      providerId: "codex",
      sessionId: "thread-goal-1",
    });
    expect(runtime.events.filter((event) =>
      event.type === "agent.goal.cleared")).toHaveLength(2);
    runtime.provider.emit({
      ...base,
      type: "goal-cleared",
      providerId: "codex",
      sessionId: "thread-goal-1",
    });
    expect(runtime.events.filter((event) =>
      event.type === "agent.goal.cleared")).toHaveLength(2);

    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("keeps provider sequence authoritative across stop acknowledgement and terminal enrichment", async () => {
    const runtime = await testRuntime({}, {
      modelSelection: nativeModelSelection({
        providerId: "claude",
        modelId: "provider-default",
      }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Delegate this work.",
    });
    runtime.controller.start(queued.turn.id);
    emitSubagent(runtime, {
      sequence: 1,
      providerTaskId: "task-1",
      providerToolUseId: "tool-1",
      providerRole: "researcher",
      providerName: "Evidence",
      providerStatus: "future_active_state", status: "unknown", isLive: true,
      description:
        `Check \u001b[31mghp_abcdefghijklmnopqrstuvwxyz in ${runtime.workspace}/private`,
      progress:
        "password=hunter2 Cookie=session-value system_prompt=hidden",
      result:
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.abcdefghijklmnop",
    });
    let trace = runtime.store.conversationDetail(
      runtime.conversationId,
    )?.subagents[0];
    expect(trace).toMatchObject({
      providerTaskId: "task-1",
      providerRole: "researcher",
      providerStatus: "future_active_state", status: "unknown", isLive: true,
      sequence: 1,
      description: "Check [redacted] in <workspace>/private",
    });
    expect(trace?.description).not.toContain("\u001b");
    expect(trace?.progress).toBe(
      "password=[redacted] Cookie=[redacted] system_prompt=[redacted]",
    );
    expect(trace?.result).toBe("[redacted]");
    expect(await runtime.controller.stopSubagent(
      runtime.conversationId,
      trace!.id,
    )).toBe(true);
    expect(runtime.provider.stoppedSubagentIds).toEqual(["task-1"]);

    expect(runtime.store.subagentTrace(trace!.id)).toMatchObject({
      status: "cancelled",
      sequence: 1,
      providerStatus: "future_active_state",
      progress: "Stopped by the user.",
    });

    emitSubagent(runtime, {
      sequence: 2,
      providerTaskId: "task-1",
      providerAgentId: "agent-1",
      providerToolUseId: "tool-1",
      providerStatus: "stopped",
      status: "cancelled", isLive: false,
      result: "Stopped authoritatively.",
    });
    trace = runtime.store.subagentTrace(trace!.id);
    expect(trace).toMatchObject({
      providerAgentId: "agent-1", providerStatus: "stopped",
      status: "cancelled", sequence: 2,
      progress: "Stopped by the user.", result: "Stopped authoritatively.",
    });
    emitSubagent(runtime, {
      sequence: 2, providerTaskId: "task-1", providerStatus: "stopped",
      status: "cancelled", isLive: false,
      result: "Duplicate must not replace the terminal summary.",
    });
    emitSubagent(runtime, {
      sequence: 3,
      providerTaskId: "task-1",
      providerToolUseId: "tool-1",
      status: "failed", isLive: false, result: "contradictory failure",
    });
    emitSubagent(runtime, {
      sequence: 4,
      providerTaskId: "task-1",
      providerAgentId: "agent-1",
      providerToolUseId: "tool-1",
      status: "running", isLive: true, progress: "late replay",
    });
    expect(runtime.store.subagentTrace(trace.id)).toEqual(trace);
    expect(runtime.events.filter(({ type }) =>
      type === "agent.subagent.updated")).toHaveLength(3);

    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("marks a delegated trace cancelled only after the provider acknowledges stop", async () => {
    const runtime = await testRuntime({}, {
      modelSelection: nativeModelSelection({
        providerId: "claude",
        modelId: "provider-default",
      }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Delegate cancellable work.",
    });
    runtime.controller.start(queued.turn.id);
    emitSubagent(runtime, {
      sequence: 1,
      providerTaskId: "task-deferred-stop",
      providerToolUseId: "tool-deferred-stop",
      providerRole: "researcher",
      providerName: "Evidence",
      status: "running", isLive: true,
      description: "Wait for explicit acknowledgement.",
    });
    const trace = runtime.store.conversationDetail(
      runtime.conversationId,
    )!.subagents[0]!;
    let settleStop!: (outcome: "accepted" | "rejected" | "timeout") => void;
    const stopSubagent = vi.spyOn(runtime.provider, "stopSubagent")
      .mockImplementation(async () =>
        await new Promise<boolean>((resolve, reject) => {
          settleStop = (outcome) => outcome === "rejected"
            ? reject(new Error("stopTask rejected"))
            : resolve(outcome === "accepted");
        }));

    const rejectedStop = runtime.controller.stopSubagent(
      runtime.conversationId,
      trace.id,
    );
    await flushPromises();
    expect(runtime.store.subagentTrace(trace.id).status).toBe("running");
    settleStop("timeout");
    await expect(rejectedStop).resolves.toBe(false);
    expect(runtime.store.subagentTrace(trace.id).status).toBe("running");

    const acceptedStop = runtime.controller.stopSubagent(
      runtime.conversationId,
      trace.id,
    );
    await flushPromises();
    expect(runtime.store.subagentTrace(trace.id).status).toBe("running");
    settleStop("accepted");
    await expect(acceptedStop).resolves.toBe(true);
    expect(runtime.store.subagentTrace(trace.id)).toMatchObject({
      status: "cancelled",
      progress: "Stopped by the user.",
    });

    for (const [index, outcome] of [
      "accepted", "rejected", "timeout",
    ].entries()) {
      const taskId = `task-notifies-before-${outcome}`;
      const sequence = 2 + (index * 2);
      emitSubagent(runtime, {
        sequence, providerTaskId: taskId, providerStatus: "running",
        status: "running", isLive: true,
      });
      const notificationFirstTrace = runtime.store
        .conversationDetail(runtime.conversationId)!.subagents
        .find(({ providerTaskId }) => providerTaskId === taskId)!;
      const notificationFirstStop = runtime.controller.stopSubagent(
        runtime.conversationId, notificationFirstTrace.id,
      );
      await flushPromises();
      emitSubagent(runtime, {
        sequence: sequence + 1, providerTaskId: taskId,
        providerStatus: "stopped", status: "cancelled", isLive: false,
        result: `Provider cancellation arrived before ${outcome}.`,
      });
      const beforeAcknowledgement = runtime.store.subagentTrace(notificationFirstTrace.id);
      settleStop(outcome as "accepted" | "rejected" | "timeout");
      await expect(notificationFirstStop).resolves.toBe(true);
      expect(runtime.store.subagentTrace(notificationFirstTrace.id))
        .toEqual(beforeAcknowledgement);
    }
    expect(stopSubagent).toHaveBeenCalledTimes(5);

    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it.each(["completed", "failed"] as const)(
    "preserves %s subagent state when it settles before stop acknowledgement",
    async (terminalStatus) => {
    const runtime = await testRuntime({}, {
      modelSelection: nativeModelSelection({
        providerId: "claude",
        modelId: "provider-default",
      }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Delegate work that may finish while stopping.",
    });
    runtime.controller.start(queued.turn.id);
    emitSubagent(runtime, {
      sequence: 1,
      providerTaskId: "task-finishes-during-stop",
      providerToolUseId: "tool-finishes-during-stop",
      providerRole: "researcher",
      providerName: "Evidence",
      status: "running", isLive: true,
      description: "Finish before the stop acknowledgement.",
    });
    const trace = runtime.store.conversationDetail(
      runtime.conversationId,
    )!.subagents[0]!;
    let acknowledgeStop!: (accepted: boolean) => void;
    vi.spyOn(runtime.provider, "stopSubagent")
      .mockImplementation(async () =>
        await new Promise<boolean>((resolve) => {
          acknowledgeStop = resolve;
        }));

    const stopping = runtime.controller.stopSubagent(
      runtime.conversationId,
      trace.id,
    );
    await flushPromises();
    emitSubagent(runtime, {
      sequence: 2,
      providerTaskId: "task-finishes-during-stop",
      providerAgentId: "agent-finished",
      providerToolUseId: "tool-finishes-during-stop",
      providerRole: "researcher",
      providerName: "Evidence",
      status: terminalStatus, isLive: false,
      description: "Finish before the stop acknowledgement.",
      progress: "Finished.",
      result: "Verified.",
    });
    acknowledgeStop(true);

    await expect(stopping).resolves.toBe(false);
    expect(runtime.store.subagentTrace(trace.id)).toMatchObject({
      status: terminalStatus,
      sequence: 2,
      providerAgentId: "agent-finished",
      progress: "Finished.",
      result: "Verified.",
    });

    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
    },
  );

  it("preserves settlement-owned subagent state when the parent settles before stop acknowledgement", async () => {
    const runtime = await testRuntime({}, {
      modelSelection: nativeModelSelection({
        providerId: "claude",
        modelId: "provider-default",
      }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Delegate work until the parent settles.",
    });
    runtime.controller.start(queued.turn.id);
    emitSubagent(runtime, {
      sequence: 1,
      providerTaskId: "task-parent-settles",
      providerToolUseId: "tool-parent-settles",
      providerRole: "researcher",
      providerName: "Evidence",
      status: "waiting", isLive: true,
      description: "Wait for the parent result.",
      progress: "Waiting.",
    });
    const trace = runtime.store.conversationDetail(
      runtime.conversationId,
    )!.subagents[0]!;
    let acknowledgeStop!: (accepted: boolean) => void;
    vi.spyOn(runtime.provider, "stopSubagent")
      .mockImplementation(async () =>
        await new Promise<boolean>((resolve) => {
          acknowledgeStop = resolve;
        }));

    const stopping = runtime.controller.stopSubagent(
      runtime.conversationId,
      trace.id,
    );
    await flushPromises();
    runtime.provider.resolve({
      status: "completed",
      text: "The parent completed first.",
    });
    await flushPromises();
    expect(runtime.store.subagentTrace(trace.id)).toMatchObject({
      status: "lost",
      sequence: 2,
      progress: "Waiting.",
    });
    acknowledgeStop(true);

    await expect(stopping).resolves.toBe(false);
    expect(runtime.store.subagentTrace(trace.id)).toMatchObject({
      status: "lost",
      sequence: 2,
      progress: "Waiting.",
    });

    runtime.store.close();
  });

  it("marks live delegated traces lost when an interrupted runtime reconnects", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Leave delegated work in flight.",
    });
    runtime.controller.start(queued.turn.id);
    emitSubagent(runtime, {
      sequence: 1,
      providerTaskId: null,
      providerAgentId: "child-thread-1",
      providerToolUseId: "spawn-1",
      providerRole: "worker",
      providerStatus: "future_active_state", status: "unknown", isLive: true,
      description: "Inspect",
    });
    const databasePath = join(runtime.directory, "inertia.sqlite");
    const runtimeGenerationId = runtime.store.providerRunOwnership.all()[0]!.runtimeGenerationId;
    runtime.store.close();
    const reopened = new RuntimeStore(
      databasePath,
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    reopened.providerRunOwnership.clearRuntimeGeneration(runtimeGenerationId);
    recoverInterruptedTurns(reopened);
    expect(reopened.agentTurn(queued.turn.id).status).toBe("interrupted");
    expect(reopened.conversationDetail(runtime.conversationId)?.subagents)
      .toContainEqual(expect.objectContaining({
        providerAgentId: "child-thread-1",
        status: "lost", isLive: false,
        sequence: 2,
      }));
    reopened.close();
  });

  it("injects one Build instruction before every native or custom adapter and never in Plan mode", async () => {
    const nativeProviders = ["codex", "claude", "cursor", "kimi", "opencode"] as const;
    for (const providerId of nativeProviders) {
      const runtime = await testRuntime({}, {
        modelSelection: nativeModelSelection({
          providerId,
          modelId: "provider-default",
        }),
      });
      const visibleContent = `Implement through ${providerId}.`;
      const queued = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: visibleContent,
      });
      expect(runtime.controller.start(queued.turn.id)).toBe(true);
      expect(runtime.provider.input).toMatchObject({
        providerId,
        prompt: expect.stringContaining(BUILD_MODE_INSTRUCTION),
      });
      expect(runtime.provider.input?.prompt.startsWith(`${visibleContent}\n\n`))
        .toBe(true);
      expect(runtime.provider.input?.prompt.split(BUILD_MODE_INSTRUCTION))
        .toHaveLength(2);
      runtime.provider.resolve();
      await flushPromises();
      runtime.store.close();
    }

    const customProfile = {
      ...nativeBackendProfile("codex"),
      id: "custom:responses-task-51",
      displayName: "Task 51 custom Responses",
      protocol: "openai-responses" as const,
      authenticationMode: "api-key" as const,
      source: "custom" as const,
      configurationRevision: 51,
      endpointIdentity: "endpoint:task-51",
    };
    const customHarnessId = "codex-app-server" as const;
    const customSelection = modelSelectionSchema.parse({
      ...nativeModelSelection({
        providerId: "codex",
        modelId: "custom-model",
      }),
      harnessId: customHarnessId,
      backendProfileId: customProfile.id,
      backendProfileDisplayName: customProfile.displayName,
      backendConfigurationRevision: customProfile.configurationRevision,
    });
    const customCompatibility = resolveHarnessBackendCompatibility(
      customHarnessId,
      customProfile,
    );
    const customRuntime = await testRuntime({}, {
      modelSelection: customSelection,
      resolveModelRoute: () => ({
        providerId: "codex",
        harnessId: customHarnessId,
        backendProfile: customProfile,
        compatibility: customCompatibility,
        continuationIdentity: continuationIdentityForSelection(
          customSelection,
          customProfile.endpointIdentity,
          !customCompatibility.allowsModelSwitchWithinSession,
        ),
      }),
    });
    const customQueued = customRuntime.controller.queue({
      conversationId: customRuntime.conversationId,
      content: "Implement through the custom adapter.",
    });
    expect(customRuntime.controller.start(customQueued.turn.id)).toBe(true);
    expect(customRuntime.provider.input).toMatchObject({
      backendProfile: { id: customProfile.id, source: "custom" },
      prompt: expect.stringContaining(BUILD_MODE_INSTRUCTION),
    });
    expect(customRuntime.provider.input?.prompt.split(BUILD_MODE_INSTRUCTION))
      .toHaveLength(2);
    customRuntime.provider.resolve();
    await flushPromises();
    customRuntime.store.close();

    const planRuntime = await testRuntime({}, { interactionMode: "plan" });
    const planQueued = planRuntime.controller.queue({
      conversationId: planRuntime.conversationId,
      content: "Plan this change without acting.",
    });
    expect(planRuntime.controller.start(planQueued.turn.id)).toBe(true);
    expect(planRuntime.provider.input?.prompt).toBe(
      "Plan this change without acting.",
    );
    expect(planRuntime.provider.input?.prompt).not.toContain(
      BUILD_MODE_INSTRUCTION,
    );
    planRuntime.provider.resolve();
    await flushPromises();
    planRuntime.store.close();
  }, 30_000);

  it("adds the Build instruction once per follow-up when resuming a provider session", async () => {
    const runtime = await testRuntime();
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Implement the first change.",
    });
    expect(runtime.controller.start(first.turn.id)).toBe(true);
    expect(runtime.provider.input?.prompt.split(BUILD_MODE_INSTRUCTION))
      .toHaveLength(2);
    runtime.provider.emit({
      ...identity(runtime),
      type: "session",
      sessionId: "task-51-session",
    });
    runtime.provider.resolve();
    await flushPromises();

    const followUp = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Now validate the follow-up.",
    });
    expect(runtime.controller.start(followUp.turn.id)).toBe(true);
    expect(runtime.provider.input?.sessionId).toBe("task-51-session");
    expect(runtime.provider.input?.prompt.startsWith(
      "Now validate the follow-up.\n\n",
    )).toBe(true);
    expect(runtime.provider.input?.prompt).not.toContain(
      "Implement the first change.",
    );
    expect(runtime.provider.input?.prompt.split(BUILD_MODE_INSTRUCTION))
      .toHaveLength(2);
    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("settles and broadcasts the provider terminal state before slow Git finalization", async () => {
    let resolveBefore!: () => void;
    let resolveAfter!: () => void;
    let captureObservedTerminal = false;
    let beforeCaptures = 0;
    let originalTurnId = "";
    let terminalSnapshotObserved = false;
    let releaseObservedTerminal = false;
    let runtime!: TestRuntime;
    runtime = await testRuntime({
      broadcastSnapshot: () => {
        if (!originalTurnId) return;
        terminalSnapshotObserved = runtime.store.agentTurn(originalTurnId).status === "completed";
      },
      captureGitBefore: () => {
        beforeCaptures += 1;
        if (beforeCaptures > 1) return undefined;
        return new Promise<void>((resolve) => {
          resolveBefore = resolve;
        });
      },
      captureGitArtifacts: ({ turn }) => {
        captureObservedTerminal = runtime.store.agentTurn(turn.id).status === "completed"
          && runtime.events.some((event) => (
            event.type === "agent.completed"
            && event.turnId === turn.id
          ))
          && terminalSnapshotObserved;
        return new Promise<void>((resolve) => {
          resolveAfter = resolve;
        });
      },
      releaseTurnAttachments: ({ turn }) => {
        releaseObservedTerminal = runtime.store.agentTurn(turn.id).status === "completed"
          && runtime.events.some((event) => (
            event.type === "agent.completed"
            && event.turnId === turn.id
          ))
          && terminalSnapshotObserved;
      },
    });
    const attachment = await testAttachment(
      runtime,
      "88888888-8888-4888-8888-888888888888",
      "terminal-order.png",
    );
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Capture this exact turn.",
      attachments: [attachment],
    });
    originalTurnId = queued.turn.id;
    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input).toBeNull();
    resolveBefore();
    await flushPromises();
    expect(runtime.provider.input?.turnId).toBe(queued.turn.id);
    runtime.provider.resolve({ status: "completed", text: "Captured." });
    await flushPromises();
    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "completed",
      terminalAssistantMessageId: expect.any(String),
    });
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(false);
    expect(captureObservedTerminal).toBe(true);
    expect(releaseObservedTerminal).toBe(true);
    expect(runtime.events).toContainEqual({
      type: "conversation.detail.invalidated",
      conversationId: runtime.conversationId,
    });
    const followUp = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Do not overtake the exact after-state.",
    });
    expect(runtime.controller.start(followUp.turn.id)).toBe(true);
    expect(runtime.provider.input?.turnId).toBe(queued.turn.id);
    resolveAfter();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.provider.input?.turnId).toBe(followUp.turn.id);
    runtime.provider.resolve({ status: "completed", text: "Follow-up done." });
    await flushPromises();
    resolveAfter();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed");
    expect(runtime.store.agentTurn(followUp.turn.id).status).toBe("completed");
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    runtime.store.close();
  });

  it("does not start a provider after cancellation wins during pre-turn Git capture", async () => {
    let resolveBefore!: () => void;
    const runtime = await testRuntime({
      captureGitBefore: () => new Promise<void>((resolve) => {
        resolveBefore = resolve;
      }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Wait for the repository checkpoint.",
    });

    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input).toBeNull();
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("cancelled");

    resolveBefore();
    await flushPromises();

    expect(runtime.provider.input).toBeNull();
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    expect(runtime.events.filter((event) => (
      event.type === "agent.completed"
      && event.turnId === queued.turn.id
    ))).toHaveLength(1);
    runtime.store.close();
  });

  it("repairs a rejected async finalization without leaving the controller wedged", async () => {
    const runtime = await testRuntime({
      captureGitArtifacts: async () => undefined,
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Exercise guarded finalization.",
    });
    runtime.controller.start(queued.turn.id);
    vi.spyOn(runtime.store, "settleAgentTurn")
      .mockImplementationOnce(() => {
        throw new Error("simulated finalize failure");
      });
    runtime.provider.resolve({ status: "completed", text: "Provider completed." });
    await flushPromises();
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "stream-persistence-failed",
    });
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    runtime.store.close();
  });

  it("settles a provider process exit while Git finalization is still pending", async () => {
    let resolveArtifact!: () => void;
    const runtime = await testRuntime({
      captureGitArtifacts: () => new Promise<void>((resolve) => {
        resolveArtifact = resolve;
      }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Survive the provider exit.",
    });
    runtime.controller.start(queued.turn.id);
    runtime.provider.reject(new Error("provider process exited"));
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "provider-process-crash",
    });
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    expect(runtime.events.some((event) => (
      event.type === "agent.failed"
      && event.turnId === queued.turn.id
    ))).toBe(true);

    resolveArtifact();
    await flushPromises();
    runtime.store.close();
  });

  it("retains submitted attachments until provider settlement or bounded cancellation cleanup", async () => {
    const runtime = await testRuntime();
    const completedAttachment = await testAttachment(
      runtime,
      "11111111-1111-4111-8111-111111111111",
      "completed.png",
    );
    const completed = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Use the completed attachment.",
      attachments: [completedAttachment],
    });
    runtime.controller.start(completed.turn.id);

    expect(runtime.attachmentReleases).toEqual([]);
    expect(runtime.provider.input?.imagePaths).toEqual([
      expect.stringMatching(/completed\.png$/u),
    ]);

    runtime.provider.resolve({ text: "Completed with the image." });
    await flushPromises();
    await flushPromises();
    expect(runtime.attachmentReleases).toEqual([[completedAttachment.id]]);

    const failedAttachment = await testAttachment(
      runtime,
      "22222222-2222-4222-8222-222222222222",
      "failed.png",
    );
    const failed = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Use the attachment before failing.",
      attachments: [failedAttachment],
    });
    runtime.controller.start(failed.turn.id);
    expect(runtime.attachmentReleases).toEqual([[completedAttachment.id]]);

    runtime.provider.reject(new Error("provider transport exited"));
    await flushPromises();
    await flushPromises();
    expect(runtime.attachmentReleases).toEqual([
      [completedAttachment.id],
      [failedAttachment.id],
    ]);

    const cancelledAttachment = await testAttachment(
      runtime,
      "33333333-3333-4333-8333-333333333333",
      "cancelled.png",
    );
    const cancelled = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Use the attachment until cancellation.",
      attachments: [cancelledAttachment],
    });
    runtime.controller.start(cancelled.turn.id);
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    await flushPromises();
    await flushPromises();

    expect(runtime.attachmentReleases).toEqual([
      [completedAttachment.id],
      [failedAttachment.id],
      [cancelledAttachment.id],
    ]);
    expect(runtime.store.agentTurn(cancelled.turn.id)).toMatchObject({
      status: "cancelled",
      terminalReason: "user-cancelled",
    });

    runtime.provider.resolve({ status: "cancelled" });
    await flushPromises();
    await flushPromises();
    expect(runtime.attachmentReleases).toEqual([
      [completedAttachment.id],
      [failedAttachment.id],
      [cancelledAttachment.id],
    ]);
    runtime.store.close();
  });

  it("releases an active attachment after bounded provider cleanup during runtime disposal", async () => {
    const runtime = await testRuntime();
    const attachment = await testAttachment(
      runtime,
      "44444444-4444-4444-8444-444444444444",
      "runtime-crash.png",
    );
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Keep this attachment until runtime settlement.",
      attachments: [attachment],
    });
    runtime.controller.start(queued.turn.id);
    expect(runtime.attachmentReleases).toEqual([]);

    await runtime.controller.dispose("runtime-crash");

    expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "interrupted",
      terminalReason: "runtime-crash",
    });
    runtime.provider.reject(new Error("provider exited with the runtime"));
    await flushPromises();
    await flushPromises();
    expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
    runtime.store.close();
  });

  it("drains settlement work before propagating an unconfirmed provider cleanup", async () => {
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const runtime = await testRuntime({
      onTurnSettled: () => settlement,
    });
    runtime.provider.deferOwnedStop();
    const cleanupError = new Error("provider cleanup is unconfirmed");
    vi.spyOn(runtime.provider, "disposeAll").mockRejectedValue(cleanupError);
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Drain the settlement before closing SQLite.",
    });
    runtime.controller.start(queued.turn.id);

    const disposal = runtime.controller.dispose("runtime-shutdown");
    let disposalSettled = false;
    const observed = disposal.then(
      () => null,
      (error: unknown) => error,
    ).finally(() => {
      disposalSettled = true;
    });
    await flushPromises();
    expect(disposalSettled).toBe(false);

    runtime.provider.resolveOwnedStop();
    await flushPromises();
    expect(disposalSettled).toBe(false);

    releaseSettlement();
    expect(await observed).toBe(cleanupError);
    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "interrupted",
      terminalReason: "runtime-shutdown",
    });

    runtime.provider.resolve({ status: "cancelled" });
    await flushPromises();
    await flushPromises();
    runtime.store.close();
  });

  it.each(["cancel", "timeout"] as const)(
    "settles %s immediately but retains cleanup authority until provider exit",
    async (scenario) => {
      const runtime = await testRuntime();
      runtime.provider.deferOwnedStop();
      const attachment = await testAttachment(
        runtime,
        scenario === "cancel"
          ? "10101010-1010-4010-8010-101010101010"
          : "20202020-2020-4020-8020-202020202020",
        `${scenario}-detach.png`,
      );
      const first = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: `First ${scenario} turn.`,
        attachments: [attachment],
      });
      runtime.controller.start(first.turn.id);
      const firstIdentity = identity(runtime);
      const firstCallbacks = runtime.provider.callbacks;

      if (scenario === "cancel") {
        expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      } else {
        runtime.scheduler.runAll();
      }

      expect(runtime.store.agentTurn(first.turn.id)).toMatchObject({
        status: scenario === "cancel" ? "cancelled" : "failed",
        terminalReason: scenario === "cancel" ? "user-cancelled" : "turn-timeout",
      });
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
      expect(runtime.controller.hasActiveCheckout(runtime.workspace)).toBe(true);
      expect(runtime.attachmentReleases).toEqual([]);
      expect(runtime.provider.stopOwnedCalls).toEqual([{
        conversationId: runtime.conversationId,
        identity: {
          runId: first.turn.runId,
          turnId: first.turn.id,
        },
      }]);

      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
        content: `Blocked retry after ${scenario}.` }))
        .toThrow("already has an active turn");

      firstCallbacks?.onEvent?.({
        ...firstIdentity,
        type: "text",
        text: "late before detach",
      });
      expect(runtime.store.conversationDetail(runtime.conversationId)?.messages)
        .not.toContainEqual(expect.objectContaining({
          turnId: first.turn.id,
          content: expect.stringContaining("late"),
        }));

      runtime.provider.resolveOwnedStop();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(runtime.attachmentReleases).toEqual([]);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);

      runtime.provider.resolve({ status: "cancelled", text: "" });
      await flushPromises();
      expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      const retry = runtime.controller.queue({ conversationId: runtime.conversationId,
        content: `Retry after confirmed ${scenario} cleanup.` });
      expect(runtime.controller.start(retry.turn.id)).toBe(true);
      expect(runtime.provider.runCount).toBe(2);
      runtime.provider.resolve({ status: "completed", text: "Retry completed." });
      await flushPromises();
      expect(runtime.store.agentTurn(retry.turn.id).status).toBe("completed");
      expect(runtime.controller.hasActiveCheckout(runtime.workspace)).toBe(false);
      runtime.store.close();
    },
  );

  it("releases a queued attachment when accepted work fails before provider start", async () => {
    const runtime = await testRuntime();
    const attachment = await testAttachment(
      runtime,
      "77777777-7777-4777-8777-777777777777",
      "pre-start.png",
    );
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Fail this accepted turn before provider start.",
      attachments: [attachment],
    });
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("queued");

    const failedBeforeStart = runtime.controller.failBeforeStart(
      runtime.conversationId,
      "Renderer acknowledgement failed.",
    );
    expect({
      failedBeforeStart,
      turn: runtime.store.agentTurn(queued.turn.id),
    }).toMatchObject({
      failedBeforeStart: true,
      turn: {
        status: "failed",
        terminalReason: "turn-start-failed",
      },
    });
    await flushPromises();
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "turn-start-failed",
    });
    expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
    runtime.store.close();
  });

  it("releases an attachment when the provider throws before returning a run", async () => {
    const runtime = await testRuntime();
    const attachment = await testAttachment(
      runtime,
      "99999999-9999-4999-8999-999999999999",
      "provider-start.png",
    );
    vi.spyOn(runtime.provider, "run").mockImplementationOnce(() => {
      throw new Error("provider launch failed");
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Fail while launching the provider.",
      attachments: [attachment],
    });

    expect(runtime.controller.start(queued.turn.id)).toBe(false);
    await flushPromises();
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "turn-start-failed",
    });
    expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
    runtime.store.close();
  });

  it("retains attachments and gates retries when a synchronous provider event settles during start", async () => {
    const runtime = await testRuntime();
    runtime.provider.deferOwnedStop();
    const attachment = await testAttachment(
      runtime,
      "abababab-abab-4bab-8bab-abababababab",
      "synchronous-start.png",
    );
    const originalRun = runtime.provider.run.bind(runtime.provider);
    vi.spyOn(runtime.provider, "run").mockImplementationOnce((input, callbacks) => {
      const result = originalRun(input, callbacks);
      callbacks.onEvent?.({
        providerId: input.providerId,
        conversationId: runtime.conversationId,
        runId: input.runId!,
        turnId: input.turnId!,
        type: "activity",
        kind: "command",
        phase: "started",
        label: "Synchronous provider activity",
      });
      return result;
    });
    vi.spyOn(runtime.store, "addActivity").mockImplementationOnce(() => {
      throw new Error("injected synchronous persistence failure");
    });
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Settle synchronously after provider ownership begins.",
      attachments: [attachment],
    });

    expect(runtime.controller.start(first.turn.id)).toBe(true);
    expect(runtime.store.agentTurn(first.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: expect.stringContaining("stream-persistence-failed"),
    });
    expect(runtime.provider.stopOwnedCalls).toEqual([{
      conversationId: runtime.conversationId,
      identity: {
        runId: first.turn.runId,
        turnId: first.turn.id,
      },
    }]);
    expect(runtime.attachmentReleases).toEqual([]);

    expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
      content: "Retry before exact-run cleanup." }))
      .toThrow("already has an active turn");
    expect(runtime.provider.runCount).toBe(1);

    runtime.provider.resolveOwnedStop();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runtime.attachmentReleases).toEqual([]);
    expect(runtime.provider.runCount).toBe(1);
    runtime.provider.resolve({ status: "cancelled", text: "" });
    await flushPromises();
    expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
    const retry = runtime.controller.queue({ conversationId: runtime.conversationId,
      content: "Retry after exact-run cleanup." });
    expect(runtime.controller.start(retry.turn.id)).toBe(true);
    expect(runtime.provider.runCount).toBe(2);
    runtime.provider.resolve({ status: "completed", text: "Retry completed." });
    await flushPromises();
    runtime.store.close();
  });

  it("treats a rejected provider promise as an interrupted transport without exposing diagnostics", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Run a command before the provider bridge disappears.",
    });
    runtime.controller.start(queued.turn.id);
    runtime.provider.emit({
      ...identity(runtime),
      type: "activity",
      kind: "command",
      phase: "started",
      label: "npm test",
      activityId: "command-before-rejection",
      detail: "Command:\nnpm test",
    });

    runtime.provider.reject(
      new Error("socket closed token=super-secret-value"),
    );
    await flushPromises();

    const activities =
      runtime.store.conversationDetail(runtime.conversationId)?.activities ?? [];
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Interrupted · npm test",
        status: "failed",
        detail: expect.stringContaining(
          "Interrupted: The Codex App Server connection closed",
        ),
      }),
      expect.objectContaining({
        kind: "error",
        title:
          "The Codex App Server connection closed before the turn completed.",
        detail: expect.stringContaining("Terminal event: not received"),
      }),
    ]));
    const errorDetail =
      activities.find(({ kind }) => kind === "error")?.detail ?? "";
    expect(errorDetail).toContain("token=[redacted]");
    expect(errorDetail).not.toContain("super-secret-value");
    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "provider-process-crash",
    });
    runtime.store.close();
  });

  it("persists visible content separately while the provider receives complete structured execution content", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Why is this change safe?",
      context: {
        diffSelections: [{
          path: "src/example.ts",
          hunkHeader: "@@ -1 +1 @@",
          content: "+const enabled = true;",
          selectedLineCount: 1,
        }],
        terminalContexts: [{
          terminalId: "terminal-1",
          terminalLabel: "Tests",
          lineStart: 10,
          lineEnd: 10,
          content: "1 test passed",
        }],
      },
      internalInstructions: [{
        label: "test-control",
        text: "INTERNAL_SECRET_POLICY: answer read-only.",
      }],
    });

    expect(queued.message.content).toBe("Why is this change safe?");
    const snapshotJson = JSON.stringify(runtime.store.snapshot());
    expect(snapshotJson).toContain("Why is this change safe?");
    expect(snapshotJson).not.toContain("+const enabled = true;");
    expect(snapshotJson).not.toContain("1 test passed");
    expect(snapshotJson).not.toContain("INTERNAL_SECRET_POLICY");
    expect(runtime.store.turnExecutionManifest(queued.turn.id)).toMatchObject({
      contextReferenceCount: 2,
      uniqueContextBlobCount: 2,
      // The trusted caller control remains separate from the one centralized
      // Build-mode instruction.
      internalInstructionCount: 2,
    });
    expect(JSON.stringify(runtime.store.turnExecutionManifest(queued.turn.id)))
      .not.toContain("INTERNAL_SECRET_POLICY");

    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input?.prompt).toContain("Why is this change safe?");
    expect(runtime.provider.input?.prompt).toContain("+const enabled = true;");
    expect(runtime.provider.input?.prompt).toContain("1 test passed");
    expect(runtime.provider.input?.prompt).toContain("INTERNAL_SECRET_POLICY");
    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("rejects a post-assembly oversize request before a message, turn, or provider spawn", async () => {
    const runtime = await testRuntime();
    const before = runtime.store.snapshot();
    const content = "x".repeat(60 * 1024);

    expect(() => runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Do not queue this.",
      context: {
        diffSelections: Array.from({ length: 4 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          hunkHeader: `@@ -${index + 1} +${index + 1} @@`,
          content: `${index}${content}`,
          selectedLineCount: 1,
        })),
      },
    })).toThrow(/Assembled execution payload exceeds/u);
    expect(runtime.provider.input).toBeNull();
    expect(runtime.store.snapshot().messages).toEqual(before.messages);
    expect(runtime.store.snapshot().agentTurns).toEqual(before.agentTurns);
    runtime.store.close();
  });

  it("retains and validates the sanitized execution manifest across restart", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Persist this request context.",
      context: {
        diffSelections: [{
          path: "src/persist.ts",
          hunkHeader: "@@ -2 +2 @@",
          content: "shared content",
          selectedLineCount: 1,
        }],
        terminalContexts: [{
          terminalId: "persist-terminal",
          terminalLabel: "Persist",
          lineStart: 2,
          lineEnd: 2,
          content: "shared content",
        }],
      },
    });
    const expected = runtime.store.turnExecutionManifest(queued.turn.id);
    expect(expected).toMatchObject({
      contextReferenceCount: 2,
      uniqueContextBlobCount: 1,
    });
    const databasePath = join(runtime.directory, "inertia.sqlite");
    runtime.store.close();
    const inspection = new Database(databasePath, { readonly: true });
    expect((inspection.prepare(
      "SELECT COUNT(*) AS count FROM turn_execution_context_blobs",
    ).get() as { count: number }).count).toBe(1);
    expect((inspection.prepare(
      "SELECT COUNT(*) AS count FROM turn_execution_context_refs WHERE turn_id = ?",
    ).get(queued.turn.id) as { count: number }).count).toBe(2);
    inspection.close();

    const reopened = new RuntimeStore(
      databasePath,
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    expect(reopened.turnExecutionManifest(queued.turn.id)).toEqual(expected);
    expect(JSON.stringify(reopened.snapshot())).not.toContain("shared content");
    reopened.close();
  });

  it("atomically queues the visible request, captures immutable config, and owns all completion associations", async () => {
    const runtime = await testRuntime();
    runtime.store.updateConversation(runtime.conversationId, {
      providerSessionId: "session-before",
    });
    runtime.store.upsertUsage({
      conversationId: runtime.conversationId,
      usedTokens: 12,
      totalProcessedTokens: 20,
      totalProcessedScope: "thread",
      maxTokens: 1_000,
      inputTokens: 10,
      cachedInputTokens: 1,
      cacheWriteInputTokens: 0,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      compactsAutomatically: false,
    });
    const checkpoint = runtime.store.addCheckpoint({
      conversationId: runtime.conversationId,
      ref: "refs/inertia/checkpoints/controller",
      label: "Before controller turn",
      turnIndex: 1,
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
    });
    const onPersisted = vi.fn(() => {
      expect(runtime.store.snapshot().messages.some((message) =>
        message.role === "user"
        && message.content === "Implement the lifecycle.")).toBe(true);
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Implement the lifecycle.",
      checkpointId: checkpoint.id,
    }, onPersisted);
    expect(onPersisted).toHaveBeenCalledOnce();
    expect(queued.turn).toMatchObject({
      status: "queued",
      userMessageId: queued.message.id,
      providerSessionBefore: "session-before",
      harnessId: "codex-app-server",
      model: "gpt-test",
      reasoningEffort: "high",
      usageAtStart: null,
    });
    expect(runtime.store.checkpoint(checkpoint.id).turnId).toBe(queued.turn.id);
    expect(runtime.store.associateCheckpointWithTurn(
      checkpoint.id,
      runtime.conversationId,
      queued.turn.runId,
      queued.turn.id,
    ).turnId).toBe(queued.turn.id);
    expect(runtime.store.snapshot().messages).toContainEqual(
      expect.objectContaining({
        id: queued.message.id,
        turnId: queued.turn.id,
        role: "user",
      }),
    );

    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    runtime.store.updateConversation(runtime.conversationId, {
      model: "later-default",
      reasoningEffort: "low",
      accessMode: "full",
    });
    const base = identity(runtime);
    runtime.provider.emit({ ...base, type: "session", sessionId: "session-after" });
    runtime.provider.emit({
      ...base,
      type: "usage",
      usage: {
        usedTokens: 30,
        totalProcessedTokens: 50,
        totalProcessedScope: "run",
        maxTokens: 1_000,
        inputTokens: 20,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 0,
        outputTokens: 8,
        reasoningOutputTokens: 3,
        compactsAutomatically: false,
      },
    });
    runtime.provider.emit({ ...base, type: "text", text: "Lifecycle complete." });
    runtime.provider.emit({ ...base, type: "reasoning-summary", text: "Verified." });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "session-after",
      text: "Lifecycle complete.",
    });
    await flushPromises();

    const turn = runtime.store.agentTurn(queued.turn.id);
    expect(turn).toMatchObject({
      status: "completed",
      terminalReason: "provider-completed",
      providerSessionBefore: "session-before",
      providerSessionAfter: "session-after",
      checkpointId: checkpoint.id,
      model: "gpt-test",
      reasoningEffort: "high",
      accessMode: "supervised",
      terminalAssistantMessageId: expect.any(String),
      usageAtCompletion: expect.objectContaining({
        usedTokens: 30,
        totalProcessedTokens: 50,
      }),
    });
    expect(runtime.store.snapshot().messages).toContainEqual(
      expect.objectContaining({
        id: turn.terminalAssistantMessageId,
        turnId: turn.id,
        role: "assistant",
        content: "Lifecycle complete.",
      }),
    );
    expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
      status: "completed",
      providerSessionId: "session-after",
    });
    expect(runtime.store.workspaceRun(turn.runId).status).toBe("succeeded");
    expect(runtime.gitArtifacts).toEqual([turn.id]);
    expect(runtime.metadataRefreshes).toEqual([turn.id]);
    expect(runtime.settled).toContain(`context:${turn.id}`);
    expect(runtime.settled).toContain(`completed:${turn.id}`);
    runtime.store.close();
  });

  it("resumes the same native session across an officially supported model switch", async () => {
    const runtime = await testRuntime();
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the provider session.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "session",
      sessionId: "codex-session",
    });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "codex-session",
      text: "Established.",
    });
    await flushPromises();

    runtime.store.updateConversation(runtime.conversationId, {
      model: "gpt-next",
    });
    const second = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Continue with the supported model switch.",
    });
    expect(second.turn.providerSessionBefore).toBe("codex-session");
    runtime.controller.start(second.turn.id);
    expect(runtime.provider.input).toMatchObject({
      sessionId: "codex-session",
      model: "gpt-next",
    });
    runtime.provider.resolve({ status: "completed", text: "Continued." });
    await flushPromises();
    runtime.store.close();
  });

  it("resumes the same native session across explicit Fast and Standard transitions", async () => {
    const standardSelection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-test",
      reasoningEffort: "high",
    });
    const runtime = await testRuntime({}, { modelSelection: standardSelection });
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the Standard provider session.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "session",
      sessionId: "codex-speed-session",
    });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "codex-speed-session",
      text: "Established.",
    });
    await flushPromises();

    runtime.store.updateConversation(runtime.conversationId, {
      modelSelection: nativeModelSelection({
        providerId: "codex",
        modelId: "gpt-test",
        reasoningEffort: "high",
        providerOptions: { fastMode: "priority" },
      }),
    });
    const fast = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Continue in Fast mode.",
    });
    expect(fast.turn.providerSessionBefore).toBe("codex-speed-session");
    runtime.controller.start(fast.turn.id);
    expect(runtime.provider.input).toMatchObject({
      sessionId: "codex-speed-session",
      supportedFastMode: "priority",
      modelSelection: { providerOptions: { fastMode: "priority" } },
      performanceModeTransition: "to-fast",
    });
    runtime.provider.resolve({ status: "completed", text: "Fast." });
    await flushPromises();

    const nextStandardSelection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-next",
      reasoningEffort: "high",
    });
    runtime.store.updateConversation(runtime.conversationId, {
      modelSelection: nextStandardSelection,
    });
    const standard = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Return to Standard mode.",
    });
    expect(standard.turn.providerSessionBefore).toBe("codex-speed-session");
    runtime.controller.start(standard.turn.id);
    expect(runtime.provider.input).toMatchObject({
      sessionId: "codex-speed-session",
      supportedFastMode: "priority",
      model: "gpt-next",
      modelSelection: { providerOptions: {} },
      performanceModeTransition: "to-standard",
    });
    runtime.provider.resolve({ status: "completed", text: "Standard." });
    await flushPromises();
    runtime.store.close();
  });

  it("rejects an incompatible model switch before persisting a new message or turn", async () => {
    const runtime = await testRuntime();
    runtime.provider.resolveModelRoute = (selection) => {
      const route = resolveNativeModelRoute(selection);
      return {
        ...route,
        compatibility: {
          ...route.compatibility,
          allowsModelSwitchWithinSession: false,
        },
        continuationIdentity: {
          ...route.continuationIdentity,
          modelIdentity: selection.modelId,
        },
      };
    };
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the fixed-model session.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "session",
      sessionId: "fixed-model-session",
    });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "fixed-model-session",
      text: "Established.",
    });
    await flushPromises();

    runtime.store.updateConversation(runtime.conversationId, {
      model: "gpt-other",
    });
    const before = runtime.store.snapshot();
    expect(() => runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Do not cross the model boundary.",
    })).toThrow("cannot change models inside an existing session");
    const after = runtime.store.snapshot();
    expect(after.messages).toEqual(before.messages);
    expect(after.agentTurns).toEqual(before.agentTurns);
    expect(runtime.provider.input?.model).toBe("gpt-test");
    runtime.store.close();
  });

  it("rejects a replaced backend endpoint before persisting a new turn", async () => {
    const runtime = await testRuntime();
    let endpointIdentity = "endpoint:first";
    runtime.provider.resolveModelRoute = (selection) => {
      const route = resolveNativeModelRoute(selection);
      return {
        ...route,
        continuationIdentity: {
          ...route.continuationIdentity,
          endpointIdentity,
        },
      };
    };
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the endpoint-bound session.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "session",
      sessionId: "endpoint-session",
    });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "endpoint-session",
      text: "Established.",
    });
    await flushPromises();

    endpointIdentity = "endpoint:replacement";
    const before = runtime.store.snapshot();
    expect(() => runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Do not cross the endpoint boundary.",
    })).toThrow("different endpoint");
    const after = runtime.store.snapshot();
    expect(after.messages).toEqual(before.messages);
    expect(after.agentTurns).toEqual(before.agentTurns);
    runtime.store.close();
  });

  it("uses the latest authoritative turn instead of stale conversation identity", async () => {
    const runtime = await testRuntime();
    runtime.provider.resolveModelRoute = (selection) => {
      const route = resolveNativeModelRoute(selection);
      return {
        ...route,
        continuationIdentity: {
          ...route.continuationIdentity,
          endpointIdentity: "endpoint:authoritative",
        },
      };
    };
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the authoritative endpoint.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "session",
      sessionId: "authoritative-session",
    });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "authoritative-session",
      text: "Established.",
    });
    await flushPromises();

    runtime.store.updateConversation(runtime.conversationId, {
      continuationIdentity: {
        ...first.turn.continuationIdentity,
        endpointIdentity: "endpoint:stale-shell-copy",
      },
    });
    const second = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Continue on the authoritative route.",
    });
    expect(second.turn.providerSessionBefore).toBe("authoritative-session");
    runtime.controller.start(second.turn.id);
    expect(runtime.provider.input).toMatchObject({
      sessionId: "authoritative-session",
      continuationIdentity: {
        endpointIdentity: "endpoint:authoritative",
      },
    });
    runtime.provider.resolve({ status: "completed", text: "Continued." });
    await flushPromises();
    runtime.store.close();
  });

  it("projects approval/input waiting states and resumes only after every request resolves", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Ask before proceeding.",
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);
    runtime.provider.emit({
      ...base,
      type: "approval",
      request: {
        requestId: "approval-1",
        kind: "command",
        title: "Run tests",
        permissionRoots: [],
        availableDecisions: ["approve", "cancel"],
      },
    });
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("waiting-for-approval");
    expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
      status: "needs-input",
      attentionKind: "approval",
    });
    expect(runtime.controller.respondToApproval(
      runtime.conversationId,
      "approval-1",
      "approve",
    )).toBe(true);

    runtime.provider.emit({
      ...base,
      type: "input",
      request: {
        requestId: "input-1",
        questions: [{
          id: "question-1",
          header: "Choice",
          question: "Which option?",
          isOther: false,
          isSecret: false,
          allowMultiple: false,
          options: [{ id: "one", label: "One", description: "" }],
        }],
        autoResolutionMs: null,
      },
    });
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("waiting-for-input");
    runtime.provider.emit({ ...base, type: "input-resolved", requestId: "input-1" });
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("waiting-for-approval");
    runtime.provider.emit({
      ...base,
      type: "approval-resolved",
      requestId: "approval-1",
      decision: "approve",
    });
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("running");
    expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
      status: "running",
      attentionKind: null,
    });
    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("retains prior-turn plans when a later authoritative turn starts", async () => {
    const runtime = await testRuntime();
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Plan the first turn.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "plan",
      explanation: "Updated first plan.",
      steps: [{ step: "First", status: "completed" }],
    });
    runtime.provider.resolve();
    await flushPromises();

    const second = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Plan the second turn.",
    });
    runtime.controller.start(second.turn.id);
    expect(runtime.store.snapshot().plans).toContainEqual(expect.objectContaining({
      runId: first.turn.runId,
      turnId: first.turn.id,
      explanation: "Updated first plan.",
    }));

    const secondIdentity = identity(runtime);
    runtime.provider.emit({
      ...secondIdentity,
      type: "plan",
      explanation: "Second plan.",
      steps: [{ step: "Second", status: "inProgress" }],
    });
    expect(runtime.store.snapshot().plans).toEqual([
      expect.objectContaining({
        runId: first.turn.runId,
        turnId: first.turn.id,
        explanation: "Updated first plan.",
      }),
      expect.objectContaining({
        runId: second.turn.runId,
        turnId: second.turn.id,
        explanation: "Second plan.",
      }),
    ]);
    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("lets only one terminal race win and ignores stale and late callbacks", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Race completion and cancellation.",
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);
    expect(runtime.controller.handleProviderEvent({
      ...base,
      runId: "stale-run",
      type: "text",
      text: "stale",
    })).toBe(false);
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    const cancelled = runtime.store.agentTurn(queued.turn.id);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      terminalReason: "user-cancelled",
    });
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(false);
    runtime.provider.emit({ ...base, type: "text", text: "late" });
    runtime.provider.resolve({ status: "completed", text: "late completion" });
    await flushPromises();
    expect(runtime.store.agentTurn(queued.turn.id)).toEqual(cancelled);
    expect(runtime.store.settleAgentTurn(queued.turn.id, {
      status: "failed",
      terminalReason: "late-process-exit",
    })).toEqual({ settled: false, turn: cancelled });
    expect(runtime.events.filter(({ type }) =>
      type === "agent.completed" || type === "agent.failed")).toHaveLength(1);
    expect(runtime.settled.filter((entry) => entry.startsWith("cancelled:"))).toHaveLength(1);
    runtime.store.close();
  });

  it("rejects approval and input events that arrive after their turn was cancelled", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Cancel before provider interaction arrives.",
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    const cancelled = runtime.store.agentTurn(queued.turn.id);

    expect(runtime.controller.handleProviderEvent({
      ...base,
      type: "approval",
      request: {
        requestId: "late-approval",
        kind: "command",
        title: "Late approval",
        permissionRoots: [],
        availableDecisions: ["approve", "cancel"],
      },
    })).toBe(false);
    expect(runtime.controller.handleProviderEvent({
      ...base,
      type: "input",
      request: {
        requestId: "late-input",
        questions: [{
          id: "late-question",
          header: "Late question",
          question: "This must not reopen the turn.",
          isOther: false,
          isSecret: false,
          allowMultiple: false,
          options: [{ id: "continue", label: "Continue", description: "" }],
        }],
        autoResolutionMs: null,
      },
    })).toBe(false);

    expect(runtime.store.agentTurn(queued.turn.id)).toEqual(cancelled);
    expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
      status: "idle",
      attentionKind: null,
    });
    expect(runtime.events.filter(({ type }) =>
      type === "agent.approval.requested" || type === "agent.input.requested"))
      .toEqual([]);
    runtime.store.close();
  });

  it.each([
    ["provider error", "failed", "provider-error"],
    ["provider process exit", "failed", "provider-process-exit"],
    ["provider process crash", "failed", "provider-process-crash"],
    ["approval cancel", "cancelled", "approval-cancelled"],
    ["unsupported interaction", "failed", "unsupported-interaction"],
    ["runtime shutdown", "interrupted", "runtime-shutdown"],
    ["runtime crash", "interrupted", "runtime-crash"],
    ["timeout", "failed", "turn-timeout"],
    ["owned renderer disconnect", "cancelled", "renderer-disconnected"],
  ] as const)("settles %s exactly once", async (scenario, status, reason) => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: `Terminal scenario: ${scenario}`,
      rendererOwnerId: scenario === "owned renderer disconnect" ? "renderer-1" : null,
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);

    if (scenario === "provider error") {
      runtime.provider.resolve({ status: "failed", exitCode: null, error: "provider error" });
    } else if (scenario === "provider process exit") {
      runtime.provider.resolve({ status: "failed", exitCode: 9, error: "exited" });
    } else if (scenario === "provider process crash") {
      runtime.provider.reject(new Error("crashed"));
    } else if (scenario === "approval cancel") {
      runtime.provider.emit({
        ...base,
        type: "approval",
        request: {
          requestId: "approval-cancel",
          kind: "command",
          title: "Cancel",
          permissionRoots: [],
          availableDecisions: ["cancel"],
        },
      });
      runtime.provider.emit({
        ...base,
        type: "approval-resolved",
        requestId: "approval-cancel",
        decision: "cancelled",
      });
    } else if (scenario === "unsupported interaction") {
      runtime.controller.unsupportedInteraction(runtime.conversationId, "unsupported");
    } else if (scenario === "runtime shutdown") {
      await runtime.controller.dispose("runtime-shutdown");
    } else if (scenario === "runtime crash") {
      await runtime.controller.dispose("runtime-crash");
    } else if (scenario === "timeout") {
      runtime.scheduler.runAll();
    } else {
      expect(runtime.controller.rendererDisconnected("another-renderer")).toBe(0);
      expect(runtime.controller.rendererDisconnected("renderer-1")).toBe(1);
    }
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status,
      terminalReason: reason,
      completedAt: expect.any(String),
    });
    runtime.provider.emit({ ...base, type: "text", text: "late" });
    expect(runtime.store.agentTurn(queued.turn.id).terminalReason).toBe(reason);
    expect(runtime.settled.filter((entry) => entry.endsWith(`:${queued.turn.id}`)))
      .toEqual(expect.arrayContaining([`${status}:${queued.turn.id}`]));
    runtime.store.close();
  });

  it("marks in-flight work interrupted when the Codex transport disappears and keeps diagnostics behind the turn failure", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Run a command before the transport closes.",
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);
    runtime.provider.emit({
      ...base,
      type: "activity",
      kind: "command",
      phase: "started",
      label: "npm test",
      activityId: "command-transport",
      detail: "Command:\nnpm test",
    });
    runtime.provider.resolve({
      status: "failed",
      exitCode: null,
      error: "The Codex App Server connection closed before the turn completed.",
      failure: {
        reason: "transport-closed",
        message: "The Codex App Server connection closed before the turn completed.",
        technicalDetail: "Reason: transport-closed\nExit code: none\nSignal: none",
        phase: "running",
        activityId: "command-transport",
      },
    });
    await flushPromises();

    const activities = runtime.store.conversationDetail(runtime.conversationId)?.activities ?? [];
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "command",
        title: "Interrupted · npm test",
        status: "failed",
        detail: expect.stringContaining("Interrupted: The Codex App Server connection closed"),
      }),
      expect.objectContaining({
        kind: "error",
        title: "The Codex App Server connection closed before the turn completed.",
        detail: expect.stringContaining("Reason: transport-closed"),
      }),
    ]));
    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "provider-process-exit",
    });
    runtime.store.close();
  });

  it("keeps a provider-reported tool failure failed instead of relabeling it as interrupted", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Preserve the provider failure.",
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);
    runtime.provider.emit({
      ...base,
      type: "activity",
      kind: "command",
      phase: "started",
      label: "npm test",
      activityId: "command-provider-failure",
    });
    runtime.provider.emit({
      ...base,
      type: "activity",
      kind: "command",
      phase: "failed",
      label: "npm test failed",
      activityId: "command-provider-failure",
      detail: "Error:\nAssertion failed",
    });
    runtime.provider.resolve({
      status: "failed",
      exitCode: 1,
      error: "Codex reported an error.",
      failure: {
        reason: "codex-error",
        message: "Codex reported an error.",
        technicalDetail: "Reason: codex-error",
      },
    });
    await flushPromises();

    const command = runtime.store.conversationDetail(runtime.conversationId)
      ?.activities.find(({ kind }) => kind === "command");
    expect(command).toMatchObject({
      title: "npm test failed",
      status: "failed",
    });
    expect(command?.title).not.toContain("Interrupted");
    runtime.store.close();
  });

  it("rolls back the user message if queued-turn persistence fails", async () => {
    const runtime = await testRuntime();
    const conversation = runtime.store.conversation(runtime.conversationId);
    const first = runtime.store.beginAgentTurn({
      id: "atomic-turn-1",
      conversationId: conversation.id,
      runId: "duplicate-run",
      content: "Owned request",
      providerId: "codex",
      harnessId: "fake",
      backendProfileId: "fake",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    const before = runtime.store.snapshot().messages;
    expect(() => runtime.store.beginAgentTurn({
      id: "atomic-turn-2",
      conversationId: conversation.id,
      runId: "duplicate-run",
      content: "Must roll back",
      providerId: "codex",
      harnessId: "fake",
      backendProfileId: "fake",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    })).toThrow();
    expect(runtime.store.snapshot().messages).toEqual(before);
    expect(runtime.store.agentTurn(first.turn.id).userMessageId).toBe(first.message.id);
    runtime.store.close();
  });

  it("recovers a queued or running authoritative turn as interrupted on restart", async () => {
    const runtime = await testRuntime();
    const runningAttachment = await testAttachment(
      runtime,
      "55555555-5555-4555-8555-555555555555",
      "running-recovery.png",
    );
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Recover this running turn.",
      attachments: [runningAttachment],
    });
    runtime.controller.start(queued.turn.id);
    const projectId = runtime.store.conversation(runtime.conversationId).projectId;
    const queuedConversation = runtime.store.createConversation(projectId, "Queued recovery");
    const queuedAttachment = await testAttachment(
      runtime,
      "66666666-6666-4666-8666-666666666666",
      "queued-recovery.png",
    );
    const neverStarted = runtime.controller.queue({
      conversationId: queuedConversation.id,
      content: "Recover this queued turn.",
      attachments: [queuedAttachment],
    });
    const databasePath = join(runtime.directory, "inertia.sqlite");
    const runtimeGenerationId = runtime.store.providerRunOwnership.all()[0]!.runtimeGenerationId;
    runtime.store.close();

    const reopened = new RuntimeStore(
      databasePath,
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    reopened.providerRunOwnership.clearRuntimeGeneration(runtimeGenerationId);
    const recovery = recoverInterruptedTurns(reopened);
    expect(recovery.recoveredTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: queued.turn.id,
        status: "interrupted",
        terminalReason: "runtime-restart",
      }),
      expect.objectContaining({
        id: neverStarted.turn.id,
        status: "interrupted",
        terminalReason: "runtime-restart",
      }),
    ]));
    expect(recovery.recoveredAttachmentIds).toEqual(expect.arrayContaining([
      runningAttachment.id,
      queuedAttachment.id,
    ]));
    expect(recovery.recoveredAttachmentIds).toHaveLength(2);
    expect(reopened.conversation(runtime.conversationId)).toMatchObject({
      status: "failed",
      attentionKind: null,
    });
    expect(reopened.snapshot().activities).toContainEqual(expect.objectContaining({
      turnId: queued.turn.id,
      runId: queued.turn.runId,
      kind: "error",
    }));
    reopened.close();
  });
});
