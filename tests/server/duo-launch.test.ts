import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";
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
import type { GitRepositoryStatus } from "../../src/server/git";
import type {
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  DuoLaunchCoordinator,
  reconcileInterruptedDuoLaunches,
} from "../../src/server/runtime/duo/duo-launch-coordinator";
import {
  TurnController,
  type TurnControllerHooks,
  type TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller";
import { recoverInterruptedTurns } from "../../src/server/runtime/turns/turn-recovery";
import { resolveNativeModelRoute } from "./model-route-fixture";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

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
  throwOnRun: number | null = null;

  resolveModelRoute = resolveNativeModelRoute;

  harnessIdFor(input: ProviderRunInput): string {
    return input.harnessId;
  }

  run(
    input: ProviderRunInput,
    _callbacks: ProviderRunCallbacks,
  ): Promise<ProviderRunResult> {
    this.inputs.push(input);
    if (this.inputs.length === this.throwOnRun) {
      throw new Error("provider invocation rejected");
    }
    return new Promise(() => undefined);
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

function createIntent(runtime: DuoTestRuntime): {
  conversationIds: [string, string];
  launchId: string;
} {
  const launchId = randomUUID();
  const conversationIds: [string, string] = [randomUUID(), randomUUID()];
  runtime.store.createPairedLaunch(launchId, [
    {
      ordinal: 0,
      projectId: runtime.projectId,
      plannedConversationId: conversationIds[0],
      plannedWorktreePath: null,
      plannedBranch: null,
      ownsWorktree: false,
    },
    {
      ordinal: 1,
      projectId: runtime.projectId,
      plannedConversationId: conversationIds[1],
      plannedWorktreePath: null,
      plannedBranch: null,
      ownsWorktree: false,
    },
  ]);
  return { conversationIds, launchId };
}

function adoptConversations(
  runtime: DuoTestRuntime,
  launchId: string,
  conversationIds: [string, string],
) {
  const selection = nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-test",
    alias: "GPT Test",
    reasoningEffort: "high",
  });
  return runtime.store.createPairedConversations(launchId, [
    {
      projectId: runtime.projectId,
      title: "Duo left",
      options: {
        id: conversationIds[0],
        providerId: "codex",
        modelSelection: selection,
        interactionMode: "plan",
        accessMode: "supervised",
        activate: false,
      },
    },
    {
      projectId: runtime.projectId,
      title: "Duo right",
      options: {
        id: conversationIds[1],
        providerId: "codex",
        modelSelection: selection,
        interactionMode: "build",
        accessMode: "full",
        activate: false,
      },
    },
  ]);
}

function preparePair(runtime: DuoTestRuntime) {
  const intent = createIntent(runtime);
  const conversations = adoptConversations(
    runtime,
    intent.launchId,
    intent.conversationIds,
  );
  const queued = runtime.controller.queuePair(intent.launchId, [
    {
      conversationId: conversations[0].id,
      content: "Preserve this exact paired prompt.",
      activateConversation: false,
    },
    {
      conversationId: conversations[1].id,
      content: "Preserve this exact paired prompt.",
      activateConversation: false,
    },
  ]);
  return { ...intent, conversations, queued };
}

function coordinator(
  runtime: DuoTestRuntime,
  turns: Pick<TurnController, "startPair" | "cancel"> = runtime.controller,
): DuoLaunchCoordinator {
  return new DuoLaunchCoordinator(
    runtime.store,
    { resolveModelRoute: resolveNativeModelRoute },
    {} as never,
    turns as TurnController,
    join(runtime.workspace, ".inertia"),
    () => [providerInfo()],
  );
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("atomic Duo launch persistence", () => {
  it("rolls back the first chat when the second chat cannot be created", async () => {
    const runtime = await createRuntime();
    const { conversationIds, launchId } = createIntent(runtime);
    const database = new Database(runtime.databasePath);
    database.exec(`
      CREATE TRIGGER reject_second_duo_conversation
      BEFORE INSERT ON conversations
      WHEN (SELECT COUNT(*) FROM conversations) = 1
      BEGIN
        SELECT RAISE(ABORT, 'second Duo conversation rejected');
      END
    `);

    expect(() => adoptConversations(runtime, launchId, conversationIds))
      .toThrow(/second Duo conversation rejected/u);
    expect(runtime.store.snapshot().conversations).toEqual([]);
    expect(runtime.store.pairedLaunch(launchId).sides.map(
      ({ conversationId }) => conversationId,
    )).toEqual([null, null]);
    database.close();
    runtime.store.close();
  });

  it.each(["first", "second"] as const)(
    "rolls back both chats' prompt records when the %s turn queue write fails",
    async (failure) => {
      const runtime = await createRuntime();
      const { conversationIds, launchId } = createIntent(runtime);
      const conversations = adoptConversations(runtime, launchId, conversationIds);
      const database = new Database(runtime.databasePath);
      database.exec(`
        CREATE TRIGGER reject_duo_turn
        BEFORE INSERT ON agent_turns
        ${failure === "second"
          ? "WHEN (SELECT COUNT(*) FROM agent_turns) = 1"
          : ""}
        BEGIN
          SELECT RAISE(ABORT, '${failure} Duo turn rejected');
        END
      `);

      expect(() => runtime.controller.queuePair(launchId, [
        { conversationId: conversations[0].id, content: "Atomic prompt" },
        { conversationId: conversations[1].id, content: "Atomic prompt" },
      ])).toThrow(new RegExp(`${failure} Duo turn rejected`, "u"));
      expect(runtime.store.snapshot().messages).toEqual([]);
      expect(runtime.store.snapshot().agentTurns).toEqual([]);
      expect(runtime.store.pairedLaunch(launchId).sides.map(({ turnId }) => turnId))
        .toEqual([null, null]);
      database.close();
      runtime.store.close();
    },
  );

  it("preserves each side's immutable request and routing identity", async () => {
    const runtime = await createRuntime();
    const prepared = preparePair(runtime);
    const [left, right] = prepared.conversations;
    expect(left).toMatchObject({
      id: prepared.conversationIds[0],
      interactionMode: "plan",
      accessMode: "supervised",
      model: "gpt-test",
    });
    expect(right).toMatchObject({
      id: prepared.conversationIds[1],
      interactionMode: "build",
      accessMode: "full",
      model: "gpt-test",
    });
    expect(runtime.store.snapshot().messages.map(({ content }) => content))
      .toEqual([
        "Preserve this exact paired prompt.",
        "Preserve this exact paired prompt.",
      ]);
    expect(runtime.store.pairedLaunch(prepared.launchId)).toMatchObject({
      state: "prepared",
      sides: [
        { conversationId: left.id, turnId: prepared.queued[0].turn.id },
        { conversationId: right.id, turnId: prepared.queued[1].turn.id },
      ],
    });
    runtime.store.close();
  });

  it("acknowledges cancellation requested while both sides are still validating", async () => {
    let readinessCount = 0;
    let announceReady!: () => void;
    let releaseReadiness!: () => void;
    const bothValidating = new Promise<void>((resolve) => {
      announceReady = resolve;
    });
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    const runtime = await createRuntime();
    const launches = new DuoLaunchCoordinator(
      runtime.store,
      { resolveModelRoute: resolveNativeModelRoute },
      {
        validateSelection: (selection: unknown) => selection,
        readiness: async () => {
          readinessCount += 1;
          if (readinessCount === 2) announceReady();
          await readinessGate;
          return null;
        },
      } as never,
      runtime.controller,
      join(runtime.workspace, ".inertia"),
      () => [providerInfo()],
    );
    const payload = preparePayload(runtime);
    const preparation = launches.prepare(payload);
    await bothValidating;
    const cancellation = launches.cancel(payload.launchId);
    releaseReadiness();

    await expect(preparation).rejects.toThrow(/cancelled/u);
    await expect(cancellation).resolves.toMatchObject({ state: "cancelled" });
    expect(runtime.store.snapshot().conversations).toEqual([]);
    expect(runtime.provider.inputs).toEqual([]);
    runtime.store.close();
  });

  it("compensates the first owned worktree when the second creation fails", async () => {
    const runtime = await createRuntime();
    await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
    const created: string[] = [];
    const removed: string[] = [];
    const launches = new DuoLaunchCoordinator(
      runtime.store,
      { resolveModelRoute: resolveNativeModelRoute },
      {
        validateSelection: (selection: unknown) => selection,
        readiness: async () => null,
      } as never,
      runtime.controller,
      join(runtime.workspace, ".inertia"),
      () => [providerInfo()],
      {
        worktrees: {
          create: async (_repositoryPath, worktreePath, options) => {
            created.push(worktreePath);
            if (created.length === 2) {
              throw new Error("second worktree rejected");
            }
            return {
              root: worktreePath,
              branch: options.branch,
              detached: false,
              upstream: null,
              ahead: 0,
              behind: 0,
              hasRemote: false,
              pullRequest: {
                available: false,
                remoteName: null,
                forge: null,
                unavailableReason: "no-remotes",
              },
              files: [],
              insertions: 0,
              deletions: 0,
              clean: true,
              truncated: false,
            } satisfies GitRepositoryStatus;
          },
          remove: async (_repositoryPath, worktreePath) => {
            removed.push(worktreePath);
            return {
              status: {
                root: runtime.workspace,
                branch: "main",
                detached: false,
                upstream: null,
                ahead: 0,
                behind: 0,
                hasRemote: false,
                pullRequest: {
                  available: false,
                  remoteName: null,
                  forge: null,
                  unavailableReason: "no-remotes",
                },
                files: [],
                insertions: 0,
                deletions: 0,
                clean: true,
                truncated: false,
              },
            };
          },
        },
      },
    );
    const payload = preparePayload(runtime, true);

    await expect(launches.prepare(payload)).rejects.toThrow(
      /second worktree rejected/u,
    );
    expect(created).toHaveLength(2);
    expect(removed).toEqual([created[0]]);
    expect(runtime.store.snapshot().conversations).toEqual([]);
    expect(runtime.store.pairedLaunch(payload.launchId).state).toBe("failed");
    runtime.store.close();
  });
});

describe("Duo dispatch ownership", () => {
  it("waits for both pre-capture barriers and compensates a deferred second-provider failure", async () => {
    let releaseCapture!: () => void;
    const capture = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const runtime = await createRuntime({ captureGitBefore: () => capture });
    const prepared = preparePair(runtime);
    runtime.provider.throwOnRun = 2;
    const dispatch = coordinator(runtime).dispatch(prepared.launchId);
    await Promise.resolve();
    expect(runtime.provider.inputs).toEqual([]);

    releaseCapture();
    const status = await dispatch;
    expect(status).toMatchObject({
      state: "failed",
      sides: [
        { dispatchState: "started" },
        { dispatchState: "failed" },
      ],
    });
    expect(runtime.provider.inputs).toHaveLength(2);
    expect(runtime.provider.cancellations).toContain(prepared.conversations[0].id);
    expect(runtime.store.agentTurn(prepared.queued[0].turn.id).status)
      .toBe("cancelled");
    expect(runtime.store.agentTurn(prepared.queued[1].turn.id).status)
      .toBe("failed");
    runtime.store.close();
  });

  it("cancels both idle survivors when cancellation races the dispatch barrier", async () => {
    let releaseCapture!: () => void;
    const capture = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const runtime = await createRuntime({ captureGitBefore: () => capture });
    const prepared = preparePair(runtime);
    const launches = coordinator(runtime);
    const dispatch = launches.dispatch(prepared.launchId);
    await Promise.resolve();
    const cancelled = await launches.cancel(prepared.launchId);
    releaseCapture();

    expect(cancelled.state).toBe("cancelled");
    await expect(dispatch).resolves.toMatchObject({ state: "cancelled" });
    expect(runtime.provider.inputs).toEqual([]);
    expect(runtime.store.pairedLaunch(prepared.launchId).sides.map(
      ({ dispatchState }) => dispatchState,
    )).toEqual(["cancelled", "cancelled"]);
    runtime.store.close();
  });

  it("claims dispatch exactly once across concurrent duplicate delivery", async () => {
    const runtime = await createRuntime();
    const prepared = preparePair(runtime);
    let starts = 0;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const launches = coordinator(runtime, {
      startPair: async () => {
        starts += 1;
        await startGate;
        return [true, true];
      },
      cancel: () => false,
    });
    const first = launches.dispatch(prepared.launchId);
    const duplicate = launches.dispatch(prepared.launchId);
    await Promise.resolve();
    expect(starts).toBe(1);
    await expect(duplicate).resolves.toMatchObject({ state: "dispatching" });
    releaseStart();
    await expect(first).resolves.toMatchObject({ state: "running" });
    expect(starts).toBe(1);
    runtime.store.close();
  });

  it("marks restart-interrupted dispatch uncertain and never retries it", async () => {
    const runtime = await createRuntime();
    const prepared = preparePair(runtime);
    expect(runtime.store.claimPairedLaunchDispatch(prepared.launchId)).toBe(true);
    runtime.store.close();

    const reopened = new RuntimeStore(
      runtime.databasePath,
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    recoverInterruptedTurns(reopened);
    await reconcileInterruptedDuoLaunches(reopened);
    let starts = 0;
    const launches = new DuoLaunchCoordinator(
      reopened,
      { resolveModelRoute: resolveNativeModelRoute },
      {} as never,
      {
        startPair: async () => {
          starts += 1;
          return [true, true];
        },
        cancel: () => false,
      } as unknown as TurnController,
      join(runtime.workspace, ".inertia"),
      () => [providerInfo()],
    );
    expect(launches.status(prepared.launchId)).toMatchObject({
      state: "interrupted",
      sides: [
        { dispatchState: "uncertain" },
        { dispatchState: "uncertain" },
      ],
    });
    await expect(launches.dispatch(prepared.launchId)).resolves.toMatchObject({
      state: "interrupted",
    });
    expect(starts).toBe(0);
    reopened.close();
  });
});
