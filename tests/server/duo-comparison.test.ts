import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentApprovalDecision,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import type {
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  DuoLaunchCoordinator,
} from "../../src/server/runtime/duo/duo-launch-coordinator";
import {
  TurnController,
  type TurnControllerHooks,
  type TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller";
import { recoverInterruptedTurns } from "../../src/server/runtime/turns/turn-recovery";
import { resolveNativeModelRoute } from "./model-route-fixture";

const temporaryDirectories: string[] = [];


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

class PairProvider implements TurnProviderRuntime {
  readonly inputs: ProviderRunInput[] = [];
  readonly cancellations: string[] = [];
  readonly callbacks: ProviderRunCallbacks[] = [];
  readonly completions: Array<{
    input: ProviderRunInput;
    resolve: (result: ProviderRunResult) => void;
  }> = [];
  throwOnRun: number | null = null;
  rejectOnRun: number | null = null;

  resolveModelRoute = resolveNativeModelRoute;

  harnessIdFor(input: ProviderRunInput): string {
    return input.harnessId;
  }

  run(
    input: ProviderRunInput,
    callbacks: ProviderRunCallbacks,
  ): Promise<ProviderRunResult> {
    this.inputs.push(input);
    this.callbacks.push(callbacks);
    if (this.inputs.length === this.throwOnRun) {
      throw new Error("provider invocation rejected");
    }
    if (this.inputs.length === this.rejectOnRun) {
      return Promise.reject(new Error("backend launch rejected before harness start"));
    }
    callbacks.onStarted?.();
    return new Promise((resolve) => {
      this.completions.push({ input, resolve });
    });
  }

  completeAll(texts: readonly string[] = []): void {
    for (const [index, { input, resolve }] of this.completions.splice(0).entries()) {
      resolve({
        providerId: input.providerId,
        conversationId: input.conversationId ?? input.threadId,
        status: "completed",
        text: texts[index] ?? "",
        textTruncated: false,
        exitCode: 0,
        signal: null,
      });
    }
  }

  cancel(conversationId: string): boolean {
    this.cancellations.push(conversationId);
    return true;
  }

  stopOwned(): Promise<"settled"> {
    return Promise.resolve("settled");
  }

  isRunning(): boolean {
    return this.inputs.length > 0;
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
    return Promise.resolve();
  }
}

interface DuoTestRuntime {
  controller: TurnController;
  databasePath: string;
  projectId: string;
  provider: PairProvider;
  store: RuntimeStore;
  workspace: string;
}

async function createRuntime(
  hookOverrides: Partial<TurnControllerHooks> = {},
): Promise<DuoTestRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-duo-launch-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Duo project", workspace);
  const provider = new PairProvider();
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
      ...hookOverrides,
    },
  );
  return {
    controller,
    databasePath,
    projectId: project.id,
    provider,
    store,
    workspace,
  };
}

function preparePayload(
  runtime: DuoTestRuntime,
  useWorktree = false,
): Parameters<DuoLaunchCoordinator["prepare"]>[0] {
  const modelSelection = modelSelectionSchema.parse(nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-test",
    alias: "GPT Test",
    reasoningEffort: "high",
  }));
  return {
    launchId: randomUUID(),
    prompt: "Prepare both sides before dispatch.",
    sides: [
      {
        projectId: runtime.projectId,
        title: "Prepared left",
        modelSelection,
        interactionMode: "plan",
        accessMode: "supervised",
        activate: false,
        useWorktree,
      },
      {
        projectId: runtime.projectId,
        title: "Prepared right",
        modelSelection,
        interactionMode: "build",
        accessMode: "full",
        activate: false,
        useWorktree,
      },
    ],
  };
}

function comparisonPreparePayload(
  runtime: DuoTestRuntime,
): Parameters<DuoLaunchCoordinator["prepare"]>[0] {
  const payload = preparePayload(runtime);
  return {
    ...payload,
    comparison: {
      projectId: runtime.projectId,
      title: "Independent judge",
      modelSelection: payload.sides[0].modelSelection,
      interactionMode: "plan",
      accessMode: "supervised",
      activate: false,
    },
  };
}

function comparisonCoordinator(
  runtime: DuoTestRuntime,
): DuoLaunchCoordinator {
  return new DuoLaunchCoordinator(
    runtime.store,
    { resolveModelRoute: resolveNativeModelRoute },
    {
      validateSelection: (selection: unknown) => selection,
      readiness: async () => null,
    } as never,
    runtime.controller,
    join(runtime.workspace, ".inertia"),
    () => [providerInfo()],
  );
}

async function settleNextProvider(
  runtime: DuoTestRuntime,
  text: string,
  status: "completed" | "failed" = "completed",
): Promise<void> {
  const completion = runtime.provider.completions.shift();
  if (!completion) throw new Error("Expected an active provider completion.");
  completion.resolve({
    providerId: completion.input.providerId,
    conversationId: completion.input.conversationId
      ?? completion.input.threadId,
    status,
    text,
    textTruncated: false,
    exitCode: status === "completed" ? 0 : 1,
    signal: null,
    ...(status === "failed" ? { error: "Expected provider failure" } : {}),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Duo third-model comparison", () => {
  it("waits for both locked terminal turns and sends only bounded attributed evidence", async () => {
    const runtime = await createRuntime();
    const launches = comparisonCoordinator(runtime);
    const prepared = await launches.prepare(comparisonPreparePayload(runtime));
    const judgeId = prepared.comparison?.conversationId;
    expect(judgeId).toBeTruthy();
    expect(new Set([
      prepared.sides[0].conversationId,
      prepared.sides[1].conversationId,
      judgeId,
    ]).size).toBe(3);
    expect(runtime.store.conversation(judgeId!)).toMatchObject({
      title: "Independent judge",
      projectId: runtime.projectId,
      providerSessionId: null,
      interactionMode: "plan",
      accessMode: "supervised",
    });
    runtime.store.updateConversation(prepared.sides[0].conversationId, {
      providerSessionId: "source-session-must-not-cross",
    });
    runtime.store.addActivity({
      conversationId: prepared.sides[0].conversationId,
      runId: runtime.store.agentTurn(prepared.sides[0].turnId).runId,
      turnId: prepared.sides[0].turnId,
      kind: "tool",
      title: "hidden-tool-history-must-not-cross",
      detail: runtime.workspace,
      status: "completed",
    });

    await expect(launches.dispatch(prepared.launchId)).resolves.toMatchObject({
      state: "running",
      comparison: { state: "waiting", attempt: 0 },
    });
    await settleNextProvider(runtime, "Source A result");
    await launches.onTurnSettled(
      runtime.store.agentTurn(prepared.sides[0].turnId),
    );
    expect(runtime.store.pairedLaunch(prepared.launchId).comparison?.state)
      .toBe("waiting");
    expect(runtime.provider.inputs).toHaveLength(2);

    await settleNextProvider(runtime, "B".repeat(8_000));
    await launches.onTurnSettled(
      runtime.store.agentTurn(prepared.sides[1].turnId),
    );
    const running = runtime.store.pairedLaunch(prepared.launchId);
    expect(running.comparison).toMatchObject({
      state: "running",
      attempt: 1,
      conversationId: judgeId,
    });
    expect(runtime.provider.inputs).toHaveLength(3);
    const judgePrompt = runtime.provider.inputs[2]!.prompt;
    expect(judgePrompt.length).toBeLessThanOrEqual(20_000);
    expect(judgePrompt).toContain("## Source A — quoted evidence");
    expect(judgePrompt).toContain("Source A result");
    expect(judgePrompt).toContain("## Source B — quoted evidence");
    expect(judgePrompt).toContain("Source B assistant result truncated by Inertia");
    expect(judgePrompt).toContain("Authoritative terminal status: completed");
    expect(judgePrompt).not.toContain("source-session-must-not-cross");
    expect(judgePrompt).not.toContain("hidden-tool-history-must-not-cross");
    expect(judgePrompt).not.toContain(runtime.workspace);
    expect(judgePrompt).not.toContain("Prepared left");
    expect(judgePrompt).not.toContain("gpt-test");
    expect(judgePrompt).not.toContain("Access used by source");
    expect(judgePrompt).not.toContain("Reasoning:");

    await settleNextProvider(runtime, "Source A is stronger.");
    const comparisonTurnId = running.comparison?.turnId;
    expect(comparisonTurnId).toBeTruthy();
    await launches.onTurnSettled(runtime.store.agentTurn(comparisonTurnId!));
    expect(launches.status(prepared.launchId).comparison).toMatchObject({
      state: "completed",
      attempt: 1,
    });
    const judgeDetail = runtime.store.conversationDetail(judgeId!);
    expect(judgeDetail?.messages.map(({ role, content }) => ({ role, content })))
      .toEqual([
        { role: "user", content: judgePrompt },
        { role: "assistant", content: "Source A is stronger." },
      ]);
    expect(() => runtime.store.assertConversationDeletionAllowed(
      prepared.sides[0].conversationId,
    )).not.toThrow();
    runtime.store.close();
  });

  it("compares a cancelled sibling, retries only explicitly, and releases the lock on cancel", async () => {
    const runtime = await createRuntime();
    const launches = comparisonCoordinator(runtime);
    const prepared = await launches.prepare(comparisonPreparePayload(runtime));
    runtime.provider.throwOnRun = 3;
    await launches.dispatch(prepared.launchId);

    expect(runtime.controller.cancel(prepared.sides[0].conversationId)).toBe(true);
    await launches.onTurnSettled(
      runtime.store.agentTurn(prepared.sides[0].turnId),
    );
    const secondIndex = runtime.provider.completions.findIndex(({ input }) =>
      input.conversationId === prepared.sides[1].conversationId);
    const second = runtime.provider.completions.splice(secondIndex, 1)[0]!;
    second.resolve({
      providerId: second.input.providerId,
      conversationId: second.input.conversationId!,
      status: "completed",
      text: "Only surviving result",
      textTruncated: false,
      exitCode: 0,
      signal: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await launches.onTurnSettled(
      runtime.store.agentTurn(prepared.sides[1].turnId),
    );
    expect(launches.status(prepared.launchId).comparison).toMatchObject({
      state: "failed",
      attempt: 1,
    });
    expect(runtime.provider.inputs[2]?.prompt).toContain(
      "Authoritative terminal status: cancelled",
    );
    expect(() => runtime.store.assertConversationDeletionAllowed(
      prepared.sides[0].conversationId,
    )).toThrow(/locked comparison/u);
    expect(() => runtime.store.assertProjectDeletionAllowed(runtime.projectId))
      .toThrow(/locked comparison/u);
    expect(() => runtime.store.assertDuoComparisonTurnAllowed(
      prepared.comparison!.conversationId,
    )).toThrow(/reserved/u);
    expect(() => runtime.controller.queue({
      conversationId: prepared.comparison!.conversationId,
      content: "Unrelated turn from an alternate entry path",
    })).toThrow(/reserved/u);

    runtime.provider.throwOnRun = null;
    expect(runtime.store.conversationWork.reserve(
      prepared.comparison!.conversationId,
    )).toBe(true);
    await expect(launches.retryComparison(prepared.launchId)).resolves
      .toMatchObject({ comparison: { state: "failed", attempt: 2 } });
    expect(runtime.provider.inputs).toHaveLength(3);
    runtime.store.conversationWork.release(
      prepared.comparison!.conversationId,
    );
    await expect(launches.retryComparison(prepared.launchId)).resolves
      .toMatchObject({ comparison: { state: "running", attempt: 3 } });
    expect(runtime.provider.inputs).toHaveLength(4);
    expect(runtime.provider.inputs[3]?.prompt).toContain("Only surviving result");
    expect(launches.cancelComparison(prepared.launchId).comparison)
      .toMatchObject({ state: "cancelled", attempt: 3 });
    expect(runtime.provider.cancellations).toContain(
      prepared.comparison!.conversationId,
    );
    expect(() => runtime.store.assertDuoComparisonTurnAllowed(
      prepared.comparison!.conversationId,
    )).not.toThrow();
    expect(() => runtime.store.assertConversationDeletionAllowed(
      prepared.sides[0].conversationId,
    )).not.toThrow();
    runtime.store.close();
  });

  it("still judges the surviving result when one source fails", async () => {
    const runtime = await createRuntime();
    const launches = comparisonCoordinator(runtime);
    const prepared = await launches.prepare(comparisonPreparePayload(runtime));
    await launches.dispatch(prepared.launchId);

    await settleNextProvider(runtime, "Partial failed output", "failed");
    await launches.onTurnSettled(
      runtime.store.agentTurn(prepared.sides[0].turnId),
    );
    await settleNextProvider(runtime, "Surviving source result");
    await launches.onTurnSettled(
      runtime.store.agentTurn(prepared.sides[1].turnId),
    );

    expect(launches.status(prepared.launchId).comparison).toMatchObject({
      state: "running",
      attempt: 1,
    });
    expect(runtime.provider.inputs[2]?.prompt).toContain(
      "Authoritative terminal status: failed",
    );
    expect(runtime.provider.inputs[2]?.prompt).toContain("Surviving source result");
    launches.cancelComparison(prepared.launchId);
    runtime.store.close();
  });

  it("starts a still-waiting comparison after restart once both sources are terminal", async () => {
    const runtime = await createRuntime();
    const launches = comparisonCoordinator(runtime);
    const prepared = await launches.prepare(comparisonPreparePayload(runtime));
    await launches.dispatch(prepared.launchId);
    runtime.provider.completeAll(["First persisted result", "Second persisted result"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(launches.status(prepared.launchId).comparison?.state).toBe("waiting");
    runtime.store.close();

    const reopened = new RuntimeStore(
      runtime.databasePath,
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    const provider = new PairProvider();
    const controller = new TurnController(
      reopened,
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
    const restarted = new DuoLaunchCoordinator(
      reopened,
      { resolveModelRoute: resolveNativeModelRoute },
      {
        validateSelection: (selection: unknown) => selection,
        readiness: async () => null,
      } as never,
      controller,
      join(runtime.workspace, ".inertia"),
      () => [providerInfo()],
    );

    await restarted.resumeComparisons();

    expect(restarted.status(prepared.launchId).comparison).toMatchObject({
      state: "running",
      attempt: 1,
    });
    expect(provider.inputs[0]?.prompt).toContain("First persisted result");
    expect(provider.inputs[0]?.prompt).toContain("Second persisted result");
    restarted.cancelComparison(prepared.launchId);
    await controller.dispose();
    reopened.close();
  });

  it("reconciles a running judge as interrupted after restart without an automatic retry", async () => {
    const runtime = await createRuntime();
    const launches = comparisonCoordinator(runtime);
    const prepared = await launches.prepare(comparisonPreparePayload(runtime));
    await launches.dispatch(prepared.launchId);
    runtime.provider.completeAll(["First", "Second"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await launches.onTurnSettled(
      runtime.store.agentTurn(prepared.sides[0].turnId),
    );
    await launches.onTurnSettled(
      runtime.store.agentTurn(prepared.sides[1].turnId),
    );
    expect(launches.status(prepared.launchId).comparison?.state).toBe("running");
    runtime.store.close();

    const reopened = new RuntimeStore(
      runtime.databasePath,
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    recoverInterruptedTurns(reopened);
    const provider = new PairProvider();
    const controller = new TurnController(
      reopened,
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
    const restarted = new DuoLaunchCoordinator(
      reopened,
      { resolveModelRoute: resolveNativeModelRoute },
      {} as never,
      controller,
      join(runtime.workspace, ".inertia"),
      () => [providerInfo()],
    );
    await restarted.resumeComparisons();
    expect(restarted.status(prepared.launchId).comparison).toMatchObject({
      state: "interrupted",
      attempt: 1,
    });
    expect(provider.inputs).toHaveLength(0);

    await expect(restarted.retryComparison(prepared.launchId)).resolves
      .toMatchObject({ comparison: { state: "running", attempt: 2 } });
    expect(provider.inputs).toHaveLength(1);
    await controller.dispose();
    reopened.close();
  });
});
