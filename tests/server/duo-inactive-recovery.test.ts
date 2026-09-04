import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalDecision,
  ClientCommand,
  ProviderInfo,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type {
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import {
  createProjectWorkspaceCommandHandler,
  type ProjectWorkspaceCommandDependencies,
} from "../../src/server/runtime/commands/project-workspace-commands";
import {
  DuoLaunchCoordinator,
  reconcileInterruptedDuoLaunches,
} from "../../src/server/runtime/duo/duo-launch-coordinator";
import {
  TurnController,
  type TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller";
import { resolveNativeModelRoute } from "./model-route-fixture";

const temporaryDirectories: string[] = [];
const openStores = new Set<RuntimeStore>();

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
      inputModalities: ["text"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
    }],
    rateLimits: [],
    metadataState: { models: field, rateLimits: field },
  };
}

class RecoveryProvider implements TurnProviderRuntime {
  readonly active = new Map<string, { runId: string; turnId: string | null }>();
  readonly pendingStops = new Map<
    string,
    () => void
  >();
  ambiguousIdentity: { runId: string; turnId: string | null } | null = null;
  deferStops = false;
  forceDetachStops = false;

  resolveModelRoute = resolveNativeModelRoute;

  harnessIdFor(input: ProviderRunInput): string {
    return input.harnessId;
  }

  run(
    input: ProviderRunInput,
    callbacks: ProviderRunCallbacks,
  ): Promise<ProviderRunResult> {
    const conversationId = input.conversationId ?? input.threadId;
    this.active.set(conversationId, {
      runId: input.runId ?? conversationId,
      turnId: input.turnId ?? null,
    });
    callbacks.onStarted?.();
    return new Promise(() => undefined);
  }

  cancel(): boolean {
    return true;
  }

  stopOwned(
    conversationId: string,
    identity: { runId: string; turnId: string | null },
    _graceMs?: number,
  ): Promise<
    "missing" | "identity-mismatch" | "settled" | "force-detached"
  > {
    const active = this.ambiguousIdentity ?? this.active.get(conversationId);
    if (!active) return Promise.resolve("missing");
    if (
      active.runId !== identity.runId
      || active.turnId !== identity.turnId
    ) return Promise.resolve("identity-mismatch");
    if (this.forceDetachStops) {
      return Promise.resolve("force-detached");
    }
    if (!this.deferStops) {
      this.active.delete(conversationId);
      this.ambiguousIdentity = null;
      return Promise.resolve("settled");
    }
    return new Promise((resolve) => {
      this.pendingStops.set(conversationId, () => {
        this.pendingStops.delete(conversationId);
        this.active.delete(conversationId);
        this.ambiguousIdentity = null;
        resolve("settled");
      });
    });
  }

  releaseStop(conversationId: string): void {
    this.pendingStops.get(conversationId)?.();
  }

  isRunning(conversationId: string): boolean {
    return this.ambiguousIdentity !== null || this.active.has(conversationId);
  }

  ownsRun(
    conversationId: string,
    identity: { runId: string; turnId: string | null },
  ): boolean {
    const active = this.ambiguousIdentity ?? this.active.get(conversationId);
    return active?.runId === identity.runId && active.turnId === identity.turnId;
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

  disposeAll(): Promise<void> {
    this.active.clear();
    return Promise.resolve();
  }
}

interface TestRuntime {
  controller: TurnController;
  databasePath: string;
  projectId: string;
  provider: RecoveryProvider;
  store: RuntimeStore;
  workspace: string;
}

function controller(store: RuntimeStore, provider: RecoveryProvider): TurnController {
  return new TurnController(
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
  );
}

function coordinator(runtime: TestRuntime): DuoLaunchCoordinator {
  return new DuoLaunchCoordinator(
    runtime.store,
    { resolveModelRoute: resolveNativeModelRoute },
    {} as never,
    runtime.controller,
    join(runtime.workspace, ".inertia"),
    () => [providerInfo()],
  );
}

async function createRuntime(): Promise<TestRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-duo-inactive-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await Promise.all([
    mkdir(join(workspace, ".detached-0")),
    mkdir(join(workspace, ".detached-1")),
  ]);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace, {
    recoverInterruptedRuns: false,
  });
  openStores.add(store);
  const projectId = store.createProject("Duo recovery", workspace).id;
  const provider = new RecoveryProvider();
  return {
    controller: controller(store, provider),
    databasePath,
    projectId,
    provider,
    store,
    workspace,
  };
}

function reopen(runtime: TestRuntime): TestRuntime {
  runtime.store.close();
  const store = new RuntimeStore(runtime.databasePath, runtime.workspace, {
    recoverInterruptedRuns: false,
  });
  openStores.add(store);
  const provider = new RecoveryProvider();
  return {
    ...runtime,
    controller: controller(store, provider),
    provider,
    store,
  };
}

function prepareLaunch(
  runtime: TestRuntime,
  withComparison = false,
  isolatedCheckouts = false,
  sideProjectIds: readonly [string, string] = [
    runtime.projectId,
    runtime.projectId,
  ],
) {
  const launchId = randomUUID();
  const conversationIds = [randomUUID(), randomUUID()] as const;
  const comparisonId = withComparison ? randomUUID() : null;
  runtime.store.createPairedLaunch(launchId, [0, 1].map((ordinal) => ({
    ordinal: ordinal as 0 | 1,
    projectId: sideProjectIds[ordinal],
    plannedConversationId: conversationIds[ordinal],
    plannedWorktreePath: null,
    plannedBranch: null,
    ownsWorktree: false,
  })) as never, new Date().toISOString(), comparisonId
    ? { plannedConversationId: comparisonId }
    : null);
  const selection = providerNativeModelSelection({
    providerId: "codex",
    modelId: "gpt-test",
    alias: "GPT Test",
    reasoningEffort: "high",
  });
  const conversationPlan = (
    id: string,
    title: string,
    projectId: string,
    ordinal: 0 | 1 | null,
  ) => ({
    projectId,
    title,
    options: {
      id,
      providerId: "codex" as const,
      modelSelection: selection,
      interactionMode: "build" as const,
      accessMode: "supervised" as const,
      worktreePath: isolatedCheckouts && ordinal !== null
        ? join(runtime.workspace, `.detached-${ordinal}`)
        : null,
      activate: false,
    },
  });
  const conversations = runtime.store.createDuoConversations(
    launchId,
    [
      conversationPlan(
        conversationIds[0],
        "Duo left",
        sideProjectIds[0],
        0,
      ),
      conversationPlan(
        conversationIds[1],
        "Duo right",
        sideProjectIds[1],
        1,
      ),
    ],
    comparisonId
      ? conversationPlan(
          comparisonId,
          "Duo judge",
          runtime.projectId,
          null,
        )
      : null,
  );
  const queued = runtime.controller.queuePair(launchId, [
    { conversationId: conversations.sides[0].id, content: "Compare safely." },
    { conversationId: conversations.sides[1].id, content: "Compare safely." },
  ]);
  return {
    launchId,
    conversations,
    queued,
  };
}

function conversationHandler(
  store: RuntimeStore,
  launches?: DuoLaunchCoordinator,
) {
  const dependencies: ConversationCommandDependencies = {
    store,
    conversationAttachments: {
      release: vi.fn(async () => undefined),
    } as never,
    providers: {} as never,
    backendProfileController: {} as never,
    workspaceRuns: {} as never,
    providerTerminalResumes: new ProviderTerminalResumeRegistry(
      store.conversationWork,
    ),
    runtimeSync: {} as never,
    duoLaunches: launches,
    deletedConversationIds: new Set(),
    dataDirectory: "/data",
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    broadcastSnapshot: vi.fn(),
    publicError: (error) => String(error),
    send: vi.fn(),
  };
  return createConversationCommandHandler(dependencies);
}

function projectHandler(
  runtime: TestRuntime,
  providerTerminalResumes = new ProviderTerminalResumeRegistry(
    runtime.store.conversationWork,
  ),
) {
  const dependencies: ProjectWorkspaceCommandDependencies = {
    store: runtime.store,
    conversationAttachments: {
      release: vi.fn(async () => undefined),
    } as never,
    workspaceRuns: {} as never,
    turns: runtime.controller,
    providers: runtime.provider as never,
    providerTerminalResumes,
    duoLaunches: coordinator(runtime),
    terminals: {} as never,
    secureFiles: {} as never,
    secureFileAuthorities: {} as never,
    workspacePath: () => runtime.workspace,
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    broadcastSnapshot: vi.fn(),
    send: vi.fn(),
  };
  return createProjectWorkspaceCommandHandler(dependencies);
}

function deleteConversationCommand(conversationId: string): ClientCommand {
  return {
    type: "conversation.delete",
    requestId: randomUUID(),
    payload: { conversationId },
  };
}

afterEach(async () => {
  for (const store of openStores) store.close();
  openStores.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 5 : 1,
      retryDelay: 50,
    })));
});

describe("inactive Duo turn recovery", () => {
  it("recovers a legacy cancelled ghost through the delete command before partial chat deletion and project removal", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime);
    expect(prepared.queued.map(({ message }) => message.attachments)).toEqual([
      [],
      [],
    ]);
    runtime = reopen(runtime);
    runtime.store.finishPairedLaunchCancellation(prepared.launchId);

    expect(() => runtime.store.assertConversationDeletionAllowed(
      prepared.conversations.sides[0].id,
    )).toThrow(/Cancel the active Duo launch/u);
    expect(() => runtime.store.assertProjectDeletionAllowed(runtime.projectId))
      .toThrow(/Cancel the active Duo launch/u);

    const removeConversation = conversationHandler(
      runtime.store,
      coordinator(runtime),
    );
    await expect(removeConversation(
      {} as never,
      deleteConversationCommand(prepared.conversations.sides[0].id),
    )).resolves.toBe("mutation");
    expect(runtime.store.agentTurn(prepared.queued[1].turn.id).status)
      .toBe("cancelled");
    await expect(removeConversation(
      {} as never,
      deleteConversationCommand(prepared.conversations.sides[1].id),
    )).resolves.toBe("mutation");
    await expect(projectHandler(runtime)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).resolves.toBe("mutation");
  });

  it("reconciles and removes stale Duo history after its stored checkouts disappear", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime, false, true);
    runtime = reopen(runtime);
    runtime.store.finishPairedLaunchCancellation(prepared.launchId);
    await rm(runtime.workspace, { recursive: true, force: true });

    const competingReservationId = "missing-checkout-owner";
    expect(runtime.store.conversationWork.reserveAtCheckout(
      competingReservationId,
      runtime.projectId,
      prepared.conversations.sides[0].worktreePath!,
    )).toBe(true);
    await expect(projectHandler(runtime)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).rejects.toThrow(/Stop active work/u);
    expect(runtime.store.project(runtime.projectId).id).toBe(runtime.projectId);
    runtime.store.conversationWork.release(competingReservationId);

    await expect(projectHandler(runtime)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).resolves.toBe("mutation");

    expect(() => runtime.store.project(runtime.projectId)).toThrow();
    for (const { id } of prepared.conversations.sides) {
      expect(() => runtime.store.conversation(id)).toThrow();
    }
  });

  it("reconciles a detached optional judge and its exact durable projections before all three chats delete", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime, true);
    expect(runtime.store.claimPairedLaunchDispatch(prepared.launchId)).toBe(true);
    runtime.store.finishPairedLaunchDispatch(prepared.launchId, [true, true]);
    for (const { turn } of prepared.queued) {
      const now = new Date().toISOString();
      runtime.store.settleAgentTurn(turn.id, {
        status: "completed",
        terminalAssistantMessageId: null,
        providerSessionAfter: null,
        terminalReason: "provider-completed",
        checkpointId: null,
        usageAtCompletion: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      });
    }
    expect(runtime.store.claimPairedLaunchComparison(
      prepared.launchId,
      false,
    )).toBe(true);
    const judgeId = prepared.conversations.comparison!.id;
    const judge = runtime.controller.queue({
      conversationId: judgeId,
      authorizedDuoComparisonLaunchId: prepared.launchId,
      content: "Judge the two completed sides.",
    });
    expect(judge.message.attachments).toEqual([]);
    runtime.store.attachPairedLaunchComparisonTurn(
      prepared.launchId,
      judge.turn.id,
    );
    const now = new Date().toISOString();
    runtime.store.updateAgentTurnLifecycle(judge.turn.id, {
      status: "running",
      startedAt: now,
      updatedAt: now,
    });
    runtime.store.createWorkspaceRun({
      id: judge.turn.runId,
      kind: "agent",
      projectId: runtime.projectId,
      conversationId: judgeId,
      label: "Detached judge",
      detail: null,
      status: "running",
      port: null,
    });
    const activity = runtime.store.addActivity({
      conversationId: judgeId,
      runId: judge.turn.runId,
      turnId: judge.turn.id,
      kind: "tool",
      title: "Detached activity",
      detail: null,
      status: "running",
    });
    const reasoning = runtime.store.createReasoning(
      judgeId,
      judge.turn.runId,
      judge.turn.id,
    );
    runtime.store.markPairedLaunchComparisonRunning(
      prepared.launchId,
      judge.turn.id,
    );
    runtime = reopen(runtime);

    const status = await coordinator(runtime).cancelComparison(
      prepared.launchId,
    );
    expect(status.comparison?.state).toBe("cancelled");
    expect(runtime.store.agentTurn(judge.turn.id).status).toBe("cancelled");
    expect(runtime.store.workspaceRun(judge.turn.runId).status).toBe("cancelled");
    const detail = runtime.store.conversationDetail(judgeId)!;
    expect(detail.activities.find(({ id }) => id === activity.id)?.status)
      .toBe("failed");
    expect(detail.activities.find(({ id }) => id === activity.id)?.title)
      .toBe("Interrupted · Detached activity");
    expect(detail.reasonings.find(({ id }) => id === reasoning.id)?.status)
      .toBe("failed");

    const removeConversation = conversationHandler(runtime.store);
    for (const conversationId of [
      judgeId,
      prepared.conversations.sides[0].id,
      prepared.conversations.sides[1].id,
    ]) {
      await expect(removeConversation(
        {} as never,
        deleteConversationCommand(conversationId),
      )).resolves.toBe("mutation");
    }
    await expect(projectHandler(runtime)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).resolves.toBe("mutation");
  });

  it("recovers a detached running launch directly through chat deletion when no provider owns either side", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime);
    expect(runtime.store.claimPairedLaunchDispatch(prepared.launchId)).toBe(true);
    runtime.store.finishPairedLaunchDispatch(prepared.launchId, [true, true]);
    runtime = reopen(runtime);

    const removeConversation = conversationHandler(
      runtime.store,
      coordinator(runtime),
    );
    await expect(removeConversation(
      {} as never,
      deleteConversationCommand(prepared.conversations.sides[0].id),
    )).resolves.toBe("mutation");
    expect(runtime.store.agentTurn(prepared.queued[1].turn.id).status)
      .toBe("cancelled");
    await expect(removeConversation(
      {} as never,
      deleteConversationCommand(prepared.conversations.sides[1].id),
    )).resolves.toBe("mutation");
    await expect(projectHandler(runtime)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).resolves.toBe("mutation");
  });

  it("authorizes only the target deletion reservation across distinct Duo checkouts", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime, false, true);
    runtime = reopen(runtime);
    runtime.store.finishPairedLaunchCancellation(prepared.launchId);

    await expect(conversationHandler(
      runtime.store,
      coordinator(runtime),
    )(
      {} as never,
      deleteConversationCommand(prepared.conversations.sides[0].id),
    )).resolves.toBe("mutation");
    expect(runtime.store.agentTurn(prepared.queued[1].turn.id).status)
      .toBe("cancelled");
  });

  it("authorizes an exact sole deletion reservation across project records sharing one checkout", async () => {
    let runtime = await createRuntime();
    const duplicateProjectId = runtime.store.createProject(
      "Same checkout project",
      runtime.workspace,
    ).id;
    const prepared = prepareLaunch(runtime, false, false, [
      runtime.projectId,
      duplicateProjectId,
    ]);
    runtime = reopen(runtime);
    runtime.store.finishPairedLaunchCancellation(prepared.launchId);

    await expect(conversationHandler(
      runtime.store,
      coordinator(runtime),
    )(
      {} as never,
      deleteConversationCommand(prepared.conversations.sides[0].id),
    )).resolves.toBe("mutation");
    expect(runtime.store.agentTurn(prepared.queued[1].turn.id).status)
      .toBe("cancelled");
  });

  it("keeps deletion locked for an identity mismatch or checkout owner, then succeeds after an explicit retry", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime);
    runtime = reopen(runtime);
    runtime.provider.ambiguousIdentity = {
      runId: "some-other-run",
      turnId: "some-other-turn",
    };

    const ambiguous = await coordinator(runtime).cancel(prepared.launchId);
    expect(ambiguous.state).toBe("prepared");
    expect(ambiguous.cancelRequested).toBe(true);
    await expect(conversationHandler(
      runtime.store,
      coordinator(runtime),
    )(
      {} as never,
      deleteConversationCommand(prepared.conversations.sides[0].id),
    )).rejects.toThrow(/Cancel the active Duo launch/u);
    expect(runtime.store.agentTurn(prepared.queued[0].turn.id).status)
      .toBe("queued");

    runtime.provider.ambiguousIdentity = null;
    expect(runtime.store.conversationWork.reserve(
      prepared.conversations.sides[0].id,
    )).toBe(true);
    await expect(conversationHandler(
      runtime.store,
      coordinator(runtime),
    )(
      {} as never,
      deleteConversationCommand(prepared.conversations.sides[0].id),
    )).rejects.toThrow(/End the resumed provider terminal/u);
    expect(runtime.store.agentTurn(prepared.queued[0].turn.id).status)
      .toBe("queued");
    const reserved = await coordinator(runtime).cancel(prepared.launchId);
    expect(reserved.state).toBe("prepared");
    expect(runtime.store.agentTurn(prepared.queued[0].turn.id).status)
      .toBe("queued");
    runtime.store.conversationWork.release(prepared.conversations.sides[0].id);

    const recovered = await coordinator(runtime).cancel(prepared.launchId);
    expect(recovered.state).toBe("cancelled");
    await expect(coordinator(runtime).cancel(prepared.launchId)).resolves
      .toMatchObject({ state: "cancelled" });
    expect(() => runtime.store.assertProjectDeletionAllowed(runtime.projectId))
      .not.toThrow();
  });

  it("keeps a misbound exact workspace run and its Duo turn deletion-locked", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime);
    const foreignProjectId = runtime.store.createProject(
      "Foreign workspace",
      join(runtime.workspace, ".detached-0"),
    ).id;
    const foreignConversation = runtime.store.createConversation(
      foreignProjectId,
      "Foreign workspace owner",
      { activate: false },
    );
    const targetTurn = prepared.queued[0].turn;
    runtime.store.createWorkspaceRun({
      id: targetTurn.runId,
      kind: "agent",
      projectId: foreignProjectId,
      conversationId: foreignConversation.id,
      label: "Misbound Duo run",
      detail: null,
      status: "running",
      port: null,
    });
    runtime = reopen(runtime);
    runtime.store.finishPairedLaunchCancellation(prepared.launchId);

    await expect(conversationHandler(
      runtime.store,
      coordinator(runtime),
    )(
      {} as never,
      deleteConversationCommand(prepared.conversations.sides[0].id),
    )).rejects.toThrow(/Cancel the active Duo launch/u);
    expect(runtime.store.agentTurn(targetTurn.id).status).toBe("queued");
    expect(runtime.store.workspaceRun(targetTurn.runId)).toMatchObject({
      status: "running",
      projectId: foreignProjectId,
      conversationId: foreignConversation.id,
    });
    expect(() => runtime.store.assertConversationDeletionAllowed(
      prepared.conversations.sides[0].id,
    )).toThrow(/Cancel the active Duo launch/u);
  });

  it("keeps a target chat when a terminal sibling has a misbound active exact run", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime);
    const now = new Date().toISOString();
    for (const { turn } of prepared.queued) {
      runtime.store.settleAgentTurn(turn.id, {
        status: "cancelled",
        terminalAssistantMessageId: null,
        providerSessionAfter: null,
        terminalReason: "user-cancelled",
        checkpointId: null,
        usageAtCompletion: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      });
    }
    runtime.store.finishPairedLaunchCancellation(prepared.launchId);
    const foreignProjectId = runtime.store.createProject(
      "Foreign terminal workspace",
      join(runtime.workspace, ".detached-1"),
    ).id;
    const foreignConversation = runtime.store.createConversation(
      foreignProjectId,
      "Foreign terminal workspace owner",
      { activate: false },
    );
    const siblingTurn = prepared.queued[1].turn;
    runtime.store.createWorkspaceRun({
      id: siblingTurn.runId,
      kind: "agent",
      projectId: foreignProjectId,
      conversationId: foreignConversation.id,
      label: "Misbound terminal sibling",
      detail: null,
      status: "running",
      port: null,
    });
    runtime = reopen(runtime);

    const targetConversationId = prepared.conversations.sides[0].id;
    await expect(conversationHandler(
      runtime.store,
      coordinator(runtime),
    )(
      {} as never,
      deleteConversationCommand(targetConversationId),
    )).rejects.toThrow(/Cancel the active Duo launch/u);
    expect(runtime.store.conversation(targetConversationId).id)
      .toBe(targetConversationId);
    expect(runtime.store.workspaceRun(siblingTurn.runId).status)
      .toBe("running");
  });

  it("does not release deletion while genuinely live providers are still inside their bounded stop barrier", async () => {
    const runtime = await createRuntime();
    const prepared = prepareLaunch(runtime);
    expect((await coordinator(runtime).dispatch(prepared.launchId)).state)
      .toBe("running");
    runtime.provider.deferStops = true;

    const cancellation = coordinator(runtime).cancel(prepared.launchId);
    await vi.waitFor(() => expect(runtime.provider.pendingStops.size).toBe(2));
    await expect(projectHandler(runtime)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).rejects.toThrow(/Stop active work/u);
    for (const { id } of prepared.conversations.sides) {
      runtime.provider.releaseStop(id);
    }
    await expect(cancellation).resolves.toMatchObject({ state: "cancelled" });
    expect(() => runtime.store.assertProjectDeletionAllowed(runtime.projectId))
      .not.toThrow();
  });

  it("keeps an active Duo blocked across retries when provider termination is force-detached", async () => {
    const runtime = await createRuntime();
    const prepared = prepareLaunch(runtime);
    expect((await coordinator(runtime).dispatch(prepared.launchId)).state)
      .toBe("running");
    runtime.provider.forceDetachStops = true;

    await expect(coordinator(runtime).cancel(prepared.launchId)).resolves
      .toMatchObject({ state: "running", cancelRequested: true });
    expect(runtime.provider.active.size).toBe(2);
    await expect(coordinator(runtime).cancel(prepared.launchId)).resolves
      .toMatchObject({ state: "running", cancelRequested: true });
    for (const conversationId of prepared.conversations.sides.map(({ id }) => id)) {
      expect(runtime.controller.isActive(conversationId)).toBe(true);
      expect(runtime.controller.hasActiveCheckout(runtime.workspace)).toBe(true);
    }
    await expect(projectHandler(runtime)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).rejects.toThrow(/Stop active work/u);
    expect(runtime.store.project(runtime.projectId).id).toBe(runtime.projectId);
  });

  it("preflights a resumed project terminal before making any ghost repair mutation", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime);
    runtime = reopen(runtime);
    runtime.store.finishPairedLaunchCancellation(prepared.launchId);
    const resumes = new ProviderTerminalResumeRegistry(
      runtime.store.conversationWork,
    );
    expect(resumes.acquire(prepared.conversations.sides[0].id)).toBe(true);

    await expect(projectHandler(runtime, resumes)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).rejects.toThrow(/End resumed provider terminals/u);
    expect(runtime.store.pairedLaunch(prepared.launchId).state).toBe("cancelled");
    expect(prepared.queued.map(({ turn }) =>
      runtime.store.agentTurn(turn.id).status)).toEqual(["queued", "queued"]);
    resumes.release(prepared.conversations.sides[0].id);
  });

  it("recovers detached turns on restart before Duo recovery and remains deletion-safe", async () => {
    let runtime = await createRuntime();
    const prepared = prepareLaunch(runtime);
    runtime.store.close();
    const store = new RuntimeStore(runtime.databasePath, runtime.workspace);
    openStores.add(store);
    runtime = {
      ...runtime,
      store,
      provider: new RecoveryProvider(),
      controller: undefined as never,
    };
    runtime.controller = controller(runtime.store, runtime.provider);
    await reconcileInterruptedDuoLaunches(runtime.store);

    expect(prepared.queued.map(({ turn }) =>
      runtime.store.agentTurn(turn.id).status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(() => runtime.store.assertProjectDeletionAllowed(runtime.projectId))
      .not.toThrow();
  });

  it("bounds recovery candidates without counting unrelated completed launch history", async () => {
    let runtime = await createRuntime();
    for (let index = 0; index < 17; index += 1) {
      const historical = prepareLaunch(runtime);
      expect(runtime.store.claimPairedLaunchDispatch(historical.launchId))
        .toBe(true);
      runtime.store.finishPairedLaunchDispatch(
        historical.launchId,
        [true, true],
      );
      for (const { turn } of historical.queued) {
        const now = new Date().toISOString();
        runtime.store.settleAgentTurn(turn.id, {
          status: "completed",
          terminalAssistantMessageId: null,
          providerSessionAfter: null,
          terminalReason: "provider-completed",
          checkpointId: null,
          usageAtCompletion: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        });
      }
    }
    const ghost = prepareLaunch(runtime);
    runtime = reopen(runtime);
    runtime.store.finishPairedLaunchCancellation(ghost.launchId);

    await expect(conversationHandler(
      runtime.store,
      coordinator(runtime),
    )(
      {} as never,
      deleteConversationCommand(ghost.conversations.sides[0].id),
    )).resolves.toBe("mutation");
    expect(runtime.store.agentTurn(ghost.queued[1].turn.id).status)
      .toBe("cancelled");
  });

  it("makes bounded progress across ghost recovery retries before project deletion", async () => {
    let runtime = await createRuntime();
    const ghosts = Array.from({ length: 17 }, () => prepareLaunch(runtime));
    for (const ghost of ghosts) {
      runtime.store.finishPairedLaunchCancellation(ghost.launchId);
    }
    runtime = reopen(runtime);

    await expect(projectHandler(runtime)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).rejects.toThrow(/Cancel the active Duo launch/u);
    const statuses = ghosts.flatMap(({ queued }) => queued.map(({ turn }) =>
      runtime.store.agentTurn(turn.id).status));
    expect(statuses.filter((status) => status === "cancelled")).toHaveLength(32);
    expect(statuses.filter((status) => status === "queued")).toHaveLength(2);
    await expect(projectHandler(runtime)(
      {} as never,
      {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: runtime.projectId },
      },
    )).resolves.toBe("mutation");
  });
});
