import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
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
import {
  createWorktree,
  createWorktreeWithOwnershipReceipt,
  GitError,
  inspectOwnedWorktreeCleanupState,
  inspectRegisteredWorktreeOwnership,
  type GitRepositoryStatus,
} from "../../src/server/git";
import type {
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  DuoLaunchCoordinator,
  reconcileInterruptedDuoLaunches,
  type DuoWorktreeOperations,
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
const OWNED_WORKTREE_HEAD = "a".repeat(40);

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

  completeAll(): void {
    for (const { input, resolve } of this.completions.splice(0)) {
      resolve({
        providerId: input.providerId,
        conversationId: input.conversationId ?? input.threadId,
        status: "completed",
        text: "",
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

function createIntent(
  runtime: DuoTestRuntime,
  projectIds: readonly [string, string] = [runtime.projectId, runtime.projectId],
): {
  conversationIds: [string, string];
  launchId: string;
} {
  const launchId = randomUUID();
  const conversationIds: [string, string] = [randomUUID(), randomUUID()];
  runtime.store.createPairedLaunch(launchId, [
    {
      ordinal: 0,
      projectId: projectIds[0],
      plannedConversationId: conversationIds[0],
      plannedWorktreePath: null,
      plannedBranch: null,
      ownsWorktree: false,
    },
    {
      ordinal: 1,
      projectId: projectIds[1],
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
  projectIds: readonly [string, string] = [runtime.projectId, runtime.projectId],
) {
  const selection = nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-test",
    alias: "GPT Test",
    reasoningEffort: "high",
  });
  return runtime.store.createPairedConversations(launchId, [
    {
      projectId: projectIds[0],
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
      projectId: projectIds[1],
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

function preparePair(
  runtime: DuoTestRuntime,
  projectIds: readonly [string, string] = [runtime.projectId, runtime.projectId],
) {
  const intent = createIntent(runtime, projectIds);
  const conversations = adoptConversations(
    runtime,
    intent.launchId,
    intent.conversationIds,
    projectIds,
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

function ownedWorktreeOperations(
  runtime: DuoTestRuntime,
  overrides: Partial<DuoWorktreeOperations> = {},
): DuoWorktreeOperations {
  return {
    create: async (_repositoryPath, worktreePath, options, hooks) => {
      hooks.beforeAdd();
      hooks.added({
        branch: options.branch,
        head: OWNED_WORKTREE_HEAD,
        path: worktreePath,
      });
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
      };
    },
    inspectWorktree: async () => ({ state: "absent" }),
    inspectBranch: async () => "absent",
    ...overrides,
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

  it.each(["preparing", "prepared", "running"] as const)(
    "blocks cross-project removal while a Duo launch is %s",
    async (state) => {
      const runtime = await createRuntime();
      const otherProject = runtime.store.createProject(
        "Other Duo project",
        join(runtime.workspace, "other"),
      );
      const projectIds = [runtime.projectId, otherProject.id] as const;
      let launchId: string;
      let conversations: ReturnType<typeof preparePair>["conversations"] | null = null;
      if (state === "preparing") {
        launchId = createIntent(runtime, projectIds).launchId;
      } else {
        const prepared = preparePair(runtime, projectIds);
        launchId = prepared.launchId;
        conversations = prepared.conversations;
        if (state === "running") {
          await expect(coordinator(runtime).dispatch(launchId))
          .resolves.toMatchObject({ state: "running" });
        }
      }

      expect(() => runtime.store.removeProject(runtime.projectId)).toThrow(
        /Cancel the active Duo launch/u,
      );
      expect(runtime.store.findPairedLaunch(launchId)).not.toBeNull();
      expect(runtime.store.snapshot().projects.map(({ id }) => id))
        .toEqual(expect.arrayContaining([...projectIds]));
      if (conversations) {
        expect(conversations.every(({ id }) =>
          runtime.controller.isActive(id))).toBe(true);
      }
      runtime.store.close();
    },
  );

  it("purges terminal cross-project history only after both queued turns are settled", async () => {
    const runtime = await createRuntime();
    const otherProject = runtime.store.createProject(
      "Other Duo project",
      join(runtime.workspace, "other"),
    );
    const prepared = preparePair(
      runtime,
      [runtime.projectId, otherProject.id],
    );
    await expect(coordinator(runtime).cancel(prepared.launchId))
      .resolves.toMatchObject({ state: "cancelled" });

    runtime.store.removeProject(runtime.projectId);

    expect(runtime.store.findPairedLaunch(prepared.launchId)).toBeNull();
    expect(runtime.store.snapshot().projects.map(({ id }) => id))
      .toEqual([otherProject.id]);
    expect(runtime.store.snapshot().conversations.map(({ id }) => id))
      .toEqual([prepared.conversations[1].id]);
    expect(runtime.store.agentTurn(prepared.queued[1].turn.id).status)
      .toBe("cancelled");
    runtime.store.close();
  });

  it("allows failed pre-turn launch history to be purged with its project", async () => {
    const runtime = await createRuntime();
    const otherProject = runtime.store.createProject(
      "Other Duo project",
      join(runtime.workspace, "other"),
    );
    const launch = createIntent(
      runtime,
      [runtime.projectId, otherProject.id],
    );
    runtime.store.failPairedLaunch(
      launch.launchId,
      "failed",
      "Expected pre-turn failure",
    );

    runtime.store.removeProject(runtime.projectId);

    expect(runtime.store.findPairedLaunch(launch.launchId)).toBeNull();
    expect(runtime.store.snapshot().projects.map(({ id }) => id))
      .toEqual([otherProject.id]);
    runtime.store.close();
  });

  it("allows cross-project removal after both running providers complete", async () => {
    const runtime = await createRuntime();
    const otherProject = runtime.store.createProject(
      "Other Duo project",
      join(runtime.workspace, "other"),
    );
    const prepared = preparePair(
      runtime,
      [runtime.projectId, otherProject.id],
    );
    await expect(coordinator(runtime).dispatch(prepared.launchId))
      .resolves.toMatchObject({ state: "running" });
    runtime.provider.completeAll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prepared.queued.map(({ turn }) =>
      runtime.store.agentTurn(turn.id).status)).toEqual([
      "completed",
      "completed",
    ]);

    runtime.store.removeProject(runtime.projectId);

    expect(runtime.store.findPairedLaunch(prepared.launchId)).toBeNull();
    expect(runtime.store.snapshot().projects.map(({ id }) => id))
      .toEqual([otherProject.id]);
    expect(runtime.store.agentTurn(prepared.queued[1].turn.id).status)
      .toBe("completed");
    runtime.store.close();
  });

  it("blocks deletion of either prepared chat until the paired launch is cancelled", async () => {
    const runtime = await createRuntime();
    const prepared = preparePair(runtime);

    for (const { id } of prepared.conversations) {
      expect(() => runtime.store.assertConversationDeletionAllowed(id))
        .toThrow(/Cancel the active Duo launch/u);
    }
    expect(() => runtime.store.assertProjectDeletionAllowed(runtime.projectId))
      .toThrow(/Cancel the active Duo launch/u);
    expect(() => runtime.store.deleteConversation(
      prepared.conversations[0].id,
    )).toThrow(/Cancel the active Duo launch/u);
    expect(runtime.store.findPairedLaunch(prepared.launchId)).not.toBeNull();
    expect(prepared.conversations.every(({ id }) =>
      runtime.controller.isActive(id))).toBe(true);

    await expect(coordinator(runtime).cancel(prepared.launchId))
      .resolves.toMatchObject({ state: "cancelled" });
    runtime.store.deleteConversation(prepared.conversations[0].id);
    expect(runtime.store.findPairedLaunch(prepared.launchId)).toBeNull();
    expect(runtime.store.conversation(prepared.conversations[1].id).id)
      .toBe(prepared.conversations[1].id);
    runtime.store.close();
  });

  it("retains recovery-required chat identity until cleanup is cancelled", async () => {
    const runtime = await createRuntime();
    const prepared = preparePair(runtime);
    runtime.store.failPairedLaunch(
      prepared.launchId,
      "recovery-required",
      "Owned worktree cleanup needs attention.",
    );

    for (const { id } of prepared.conversations) {
      expect(() => runtime.store.assertConversationDeletionAllowed(id))
        .toThrow(/Cancel the active Duo launch/u);
      expect(() => runtime.store.deleteConversation(id))
        .toThrow(/Cancel the active Duo launch/u);
    }
    expect(runtime.store.pairedLaunch(prepared.launchId)).toMatchObject({
      state: "recovery-required",
      sides: [
        { conversationId: prepared.conversations[0].id },
        { conversationId: prepared.conversations[1].id },
      ],
    });

    await expect(coordinator(runtime).cancel(prepared.launchId))
      .resolves.toMatchObject({ state: "cancelled" });
    expect(prepared.queued.map(({ turn }) =>
      runtime.store.agentTurn(turn.id).status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(() => runtime.store.assertConversationDeletionAllowed(
      prepared.conversations[0].id,
    )).not.toThrow();
    runtime.store.deleteConversation(prepared.conversations[0].id);
    expect(runtime.store.findPairedLaunch(prepared.launchId)).toBeNull();
    runtime.store.close();
  });

  it.each([0, 1] as const)(
    "purges completed Duo history when chat %s is deleted",
    async (deletedOrdinal) => {
      const runtime = await createRuntime();
      const prepared = preparePair(runtime);
      await expect(coordinator(runtime).dispatch(prepared.launchId))
        .resolves.toMatchObject({ state: "running" });
      runtime.provider.completeAll();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(prepared.queued.map(({ turn }) =>
        runtime.store.agentTurn(turn.id).status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(() => runtime.store.assertConversationDeletionAllowed(
        prepared.conversations[deletedOrdinal].id,
      )).not.toThrow();
      expect(() => runtime.store.assertProjectDeletionAllowed(
        runtime.projectId,
      )).not.toThrow();

      runtime.store.deleteConversation(
        prepared.conversations[deletedOrdinal].id,
      );

      expect(runtime.store.findPairedLaunch(prepared.launchId)).toBeNull();
      const survivor = prepared.conversations[deletedOrdinal === 0 ? 1 : 0];
      expect(runtime.store.conversation(survivor.id).id).toBe(survivor.id);
      runtime.store.removeProject(runtime.projectId);
      expect(runtime.store.snapshot().projects).toEqual([]);
      runtime.store.close();
    },
  );

  it.each(["prepared", "running"] as const)(
    "settles a cross-project %s launch on restart before project removal",
    async (state) => {
      const runtime = await createRuntime();
      const otherProject = runtime.store.createProject(
        "Other Duo project",
        join(runtime.workspace, "other"),
      );
      const prepared = preparePair(
        runtime,
        [runtime.projectId, otherProject.id],
      );
      if (state === "running") {
        await expect(coordinator(runtime).dispatch(prepared.launchId))
          .resolves.toMatchObject({ state: "running" });
      }
      runtime.store.close();

      const reopened = new RuntimeStore(
        runtime.databasePath,
        runtime.workspace,
        { recoverInterruptedRuns: false },
      );
      recoverInterruptedTurns(reopened);
      await reconcileInterruptedDuoLaunches(reopened);
      expect(prepared.queued.map(({ turn }) =>
        reopened.agentTurn(turn.id).status)).toEqual([
        "interrupted",
        "interrupted",
      ]);

      reopened.removeProject(runtime.projectId);

      expect(reopened.findPairedLaunch(prepared.launchId)).toBeNull();
      expect(reopened.snapshot().projects.map(({ id }) => id))
        .toEqual([otherProject.id]);
      expect(reopened.agentTurn(prepared.queued[1].turn.id).status)
        .toBe("interrupted");
      reopened.close();
    },
  );

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

  it("finishes cancellation with an actionable retained-branch outcome", async () => {
    const runtime = await createRuntime();
    await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
    let announceCreated!: () => void;
    let releaseCreate!: () => void;
    const created = new Promise<void>((resolve) => {
      announceCreated = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const inspected: string[] = [];
    const successful = ownedWorktreeOperations(runtime);
    let createCount = 0;
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
        worktrees: ownedWorktreeOperations(runtime, {
          create: async (repositoryPath, worktreePath, options, hooks) => {
            createCount += 1;
            if (createCount === 1) {
              announceCreated();
              await createGate;
            }
            return successful.create(
              repositoryPath,
              worktreePath,
              options,
              hooks,
            );
          },
          inspectWorktree: async (_repositoryPath, worktreePath, branch, head) => {
            inspected.push(worktreePath);
            return {
              state: "owned",
              ownership: { path: worktreePath, branch, head },
            };
          },
        }),
      },
    );
    const payload = preparePayload(runtime, true);
    const preparation = launches.prepare(payload);
    await created;

    await expect(launches.cancel(payload.launchId)).resolves.toMatchObject({
      state: "preparing",
    });
    releaseCreate();

    await expect(preparation).rejects.toThrow(/cancelled/u);
    const retained = runtime.store.pairedLaunch(payload.launchId);
    expect(retained.state).toBe("recovery-required");
    expect(retained.error).toContain(retained.plans[0].plannedWorktreePath);
    expect(retained.error).toContain(retained.plans[0].plannedBranch);
    expect(retained.error).toContain(
      `git worktree remove -- ${JSON.stringify(retained.plans[0].plannedWorktreePath)}`,
    );
    expect(createCount).toBe(1);
    expect(inspected).toEqual([retained.plans[0].plannedWorktreePath]);
    expect(retained.plans[0]).toMatchObject({
      worktreeCleanupOutcome: "retained",
      branchCleanupOutcome: null,
    });
    runtime.store.close();
  });

  it("joins a concurrent duplicate after durable preparation has begun", async () => {
    const runtime = await createRuntime();
    await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
    let createCount = 0;
    let announceDurablePreparing!: () => void;
    let releaseFirstCreate!: () => void;
    const durablePreparing = new Promise<void>((resolve) => {
      announceDurablePreparing = resolve;
    });
    const firstCreateGate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
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
        worktrees: ownedWorktreeOperations(runtime, {
          create: async (_repositoryPath, worktreePath, options, hooks) => {
            createCount += 1;
            hooks.beforeAdd();
            hooks.added({
              branch: options.branch,
              head: OWNED_WORKTREE_HEAD,
              path: worktreePath,
            });
            if (createCount === 1) {
              announceDurablePreparing();
              await firstCreateGate;
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
          inspectWorktree: async () => {
            throw new Error("Duplicate preparation must not compensate.");
          },
        }),
      },
    );
    const payload = preparePayload(runtime, true);
    const first = launches.prepare(payload);
    await durablePreparing;

    const duplicate = launches.prepare(payload);
    expect(duplicate).toBe(first);
    releaseFirstCreate();

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ launchId: payload.launchId, state: "prepared" }),
      expect.objectContaining({ launchId: payload.launchId, state: "prepared" }),
    ]);
    expect(createCount).toBe(2);
    expect(runtime.store.snapshot().conversations).toHaveLength(2);
    runtime.store.close();
  });

  it("does not delete a colliding pre-existing branch when worktree creation fails", async () => {
    const runtime = await createRuntime();
    await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
    const attemptedBranches: string[] = [];
    let cleanupInspections = 0;
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
        worktrees: ownedWorktreeOperations(runtime, {
          create: async (_repositoryPath, _worktreePath, options, hooks) => {
            attemptedBranches.push(options.branch);
            hooks.beforeAdd();
            hooks.notAdded();
            throw new GitError(
              "conflict",
              `A branch named ${options.branch} already exists.`,
            );
          },
          inspectWorktree: async () => {
            cleanupInspections += 1;
            throw new Error("A collision must not trigger cleanup inspection.");
          },
        }),
      },
    );
    const payload = preparePayload(runtime, true);

    await expect(launches.prepare(payload)).rejects.toThrow(/already exists/u);

    expect(attemptedBranches).toHaveLength(1);
    expect(cleanupInspections).toBe(0);
    expect(runtime.store.pairedLaunch(payload.launchId)).toMatchObject({
      state: "failed",
      plans: [
        {
          cleanupBranchHead: null,
          worktreeCreationState: "not-created",
          worktreeRemovalConfirmed: false,
        },
        {
          cleanupBranchHead: null,
          worktreeCreationState: "pending",
          worktreeRemovalConfirmed: false,
        },
      ],
    });
    runtime.store.close();
  });

  it("retains ambiguous create ownership without adopting matching post-state", async () => {
    const runtime = await createRuntime();
    await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
    let cleanupInspections = 0;
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
        worktrees: ownedWorktreeOperations(runtime, {
          create: async (_repositoryPath, _worktreePath, _options, hooks) => {
            hooks.beforeAdd();
            throw new GitError(
              "timeout",
              "worktree add delivery was ambiguous after mutation",
            );
          },
          inspectWorktree: async () => {
            cleanupInspections += 1;
            return { state: "absent" };
          },
        }),
      },
    );
    const payload = preparePayload(runtime, true);

    await expect(launches.prepare(payload)).rejects.toThrow(/ambiguous/u);

    expect(launches.status(payload.launchId)).toMatchObject({
      state: "recovery-required",
    });
    expect(runtime.store.pairedLaunch(payload.launchId).plans[0]).toMatchObject({
      worktreeCreationState: "creating",
      cleanupBranchHead: null,
      worktreeRemovalStarted: false,
      worktreeRemovalConfirmed: false,
    });
    await expect(launches.cancel(payload.launchId)).resolves.toMatchObject({
      state: "recovery-required",
    });
    expect(cleanupInspections).toBe(0);
    runtime.store.close();
  });

  it("retains both generated worktrees when the second post-create status read fails", async () => {
    const runtime = await createRuntime();
    await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
    const created: string[] = [];
    const inspectedPaths: string[] = [];
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
        worktrees: ownedWorktreeOperations(runtime, {
          create: async (_repositoryPath, worktreePath, options, hooks) => {
            created.push(worktreePath);
            hooks.beforeAdd();
            hooks.added({
              branch: options.branch,
              head: OWNED_WORKTREE_HEAD,
              path: worktreePath,
            });
            if (created.length === 2) {
              throw new Error("second worktree status rejected after add");
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
          inspectWorktree: async (_repositoryPath, worktreePath, branch, head) => {
            inspectedPaths.push(worktreePath);
            return {
              state: "owned",
              ownership: { path: worktreePath, branch, head },
            };
          },
        }),
      },
    );
    const payload = preparePayload(runtime, true);

    await expect(launches.prepare(payload)).rejects.toThrow(
      /second worktree status rejected after add/u,
    );
    expect(created).toHaveLength(2);
    expect(inspectedPaths).toEqual([created[1], created[0]]);
    expect(runtime.store.snapshot().conversations).toEqual([]);
    const failed = runtime.store.pairedLaunch(payload.launchId);
    expect(failed.state).toBe("recovery-required");
    expect(failed.plans).toEqual([
      expect.objectContaining({
        cleanupBranchHead: OWNED_WORKTREE_HEAD,
        worktreeCleanupOutcome: "retained",
        branchCleanupOutcome: null,
      }),
      expect.objectContaining({
        cleanupBranchHead: OWNED_WORKTREE_HEAD,
        worktreeCleanupOutcome: "retained",
        branchCleanupOutcome: null,
      }),
    ]);
    expect(failed.error).toContain(created[0]);
    expect(failed.error).toContain(created[1]);
    expect(failed.error).toContain(failed.plans[0].plannedBranch);
    expect(failed.error).toContain(failed.plans[1].plannedBranch);
    runtime.store.close();
  });

  it("never cleans launch branches after conversations adopt both worktrees", async () => {
    const runtime = await createRuntime();
    await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
    let cleanupCalls = 0;
    const launches = new DuoLaunchCoordinator(
      runtime.store,
      { resolveModelRoute: resolveNativeModelRoute },
      {
        validateSelection: (selection: unknown) => selection,
        readiness: async () => null,
      } as never,
      {
        queuePair: () => {
          throw new Error("second queue write rejected");
        },
      } as unknown as TurnController,
      join(runtime.workspace, ".inertia"),
      () => [providerInfo()],
      {
        worktrees: ownedWorktreeOperations(runtime, {
          inspectWorktree: async () => {
            cleanupCalls += 1;
            throw new Error("Adopted worktrees must not be inspected for cleanup.");
          },
          inspectBranch: async () => {
            cleanupCalls += 1;
            throw new Error("Adopted branches must not be deleted.");
          },
        }),
      },
    );
    const payload = preparePayload(runtime, true);

    await expect(launches.prepare(payload)).rejects.toThrow(
      /second queue write rejected/u,
    );

    expect(cleanupCalls).toBe(0);
    expect(runtime.store.snapshot().conversations).toHaveLength(2);
    expect(runtime.store.pairedLaunch(payload.launchId)).toMatchObject({
      state: "failed",
      sides: [
        { conversationId: expect.any(String) },
        { conversationId: expect.any(String) },
      ],
    });
    runtime.store.close();
  });

  it("persists recovery identity when owned-worktree compensation fails", async () => {
    const runtime = await createRuntime();
    try {
      await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
      const created: string[] = [];
      let manualCleanupComplete = false;
      const inspectedPaths: string[] = [];
      const inspectedBranches: string[] = [];
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
          worktrees: ownedWorktreeOperations(runtime, {
            create: async (_repositoryPath, worktreePath, options, hooks) => {
              created.push(worktreePath);
              hooks.beforeAdd();
              hooks.added({
                branch: options.branch,
                head: OWNED_WORKTREE_HEAD,
                path: worktreePath,
              });
              if (created.length === 2) {
                throw new Error("second worktree status rejected after add");
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
            inspectWorktree: async (_repositoryPath, worktreePath, branch, head) => {
              inspectedPaths.push(worktreePath);
              return manualCleanupComplete
                ? { state: "absent" }
                : {
                  state: "owned",
                  ownership: { path: worktreePath, branch, head },
                };
            },
            inspectBranch: async (_repositoryPath, branch) => {
              inspectedBranches.push(branch);
              return "absent";
            },
          }),
        },
      );
      const payload = preparePayload(runtime, true);

      await expect(launches.prepare(payload)).rejects.toThrow(
        /second worktree status rejected after add/u,
      );

      expect(created).toHaveLength(2);
      expect(() => runtime.store.assertProjectDeletionAllowed(runtime.projectId))
        .toThrow(/Cancel the active Duo launch/u);
      expect(() => runtime.store.removeProject(runtime.projectId))
        .toThrow(/Cancel the active Duo launch/u);
      expect(launches.status(payload.launchId)).toMatchObject({
        launchId: payload.launchId,
        state: "recovery-required",
        error: expect.stringContaining(
          `git worktree remove -- ${JSON.stringify(created[1])}`,
        ),
        sides: [
          { ordinal: 0, conversationId: null, turnId: null },
          { ordinal: 1, conversationId: null, turnId: null },
        ],
      });
      const recovery = runtime.store.pairedLaunch(payload.launchId);
      expect(recovery.plans[1]).toMatchObject({
        plannedWorktreePath: created[1],
        ownsWorktree: true,
        worktreeCreationState: "created",
        cleanupBranchHead: OWNED_WORKTREE_HEAD,
        worktreeCleanupOutcome: "retained",
      });
      expect(recovery.plans[0]).toMatchObject({
        worktreeCreationState: "created",
        cleanupBranchHead: OWNED_WORKTREE_HEAD,
        worktreeCleanupOutcome: "retained",
        branchCleanupOutcome: null,
      });
      expect(runtime.store.snapshot().conversations).toEqual([]);
      manualCleanupComplete = true;
      await expect(launches.cancel(payload.launchId)).resolves.toMatchObject({
        launchId: payload.launchId,
        state: "cancelled",
        error: null,
      });
      expect(inspectedPaths).toEqual([
        created[1],
        created[0],
        created[0],
        created[1],
      ]);
      expect(inspectedBranches).toEqual([
        recovery.plans[0].plannedBranch,
        recovery.plans[1].plannedBranch,
      ]);
      expect(() => runtime.store.assertProjectDeletionAllowed(runtime.projectId))
        .not.toThrow();
      runtime.store.removeProject(runtime.projectId);
      expect(runtime.store.findPairedLaunch(payload.launchId)).toBeNull();
    } finally {
      runtime.store.close();
    }
  });

  it("reconciles an interrupted cleanup inspection after restart without Git mutation", async () => {
    const runtime = await createRuntime();
    let originalClosed = false;
    let reopened: RuntimeStore | null = null;
    try {
      await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
      const created: string[] = [];
      const initialInspections: string[] = [];
      const successful = ownedWorktreeOperations(runtime);
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
          worktrees: ownedWorktreeOperations(runtime, {
            create: async (repositoryPath, worktreePath, options, hooks) => {
              created.push(worktreePath);
              const status = await successful.create(
                repositoryPath,
                worktreePath,
                options,
                hooks,
              );
              if (created.length === 2) {
                throw new Error("second worktree status rejected after add");
              }
              return status;
            },
            inspectWorktree: async (_repositoryPath, path, branch, head) => {
              initialInspections.push(path);
              if (path === created[1]) {
                throw new GitError(
                  "timeout",
                  "worktree inspection completion was ambiguous",
                );
              }
              return {
                state: "owned",
                ownership: { path, branch, head },
              };
            },
            inspectBranch: async () => {
              throw new Error(
                "A retained or ambiguous worktree must prevent branch inspection.",
              );
            },
          }),
        },
      );
      const payload = preparePayload(runtime, true);

      await expect(launches.prepare(payload)).rejects.toThrow(
        /second worktree status rejected after add/u,
      );
      const recovery = runtime.store.pairedLaunch(payload.launchId);
      expect(recovery.state).toBe("recovery-required");
      expect(recovery.error).toContain(
        "worktree inspection completion was ambiguous",
      );
      expect(initialInspections).toEqual([created[1], created[0]]);
      expect(recovery.plans[0]).toMatchObject({
        worktreeCleanupOutcome: "retained",
        worktreeRemovalStarted: false,
        worktreeRemovalConfirmed: false,
      });
      expect(recovery.plans[1]).toMatchObject({
        worktreeCleanupOutcome: null,
        worktreeRemovalStarted: false,
        worktreeRemovalConfirmed: false,
      });

      runtime.store.close();
      originalClosed = true;
      reopened = new RuntimeStore(
        runtime.databasePath,
        runtime.workspace,
        { recoverInterruptedRuns: false },
      );
      const retryPaths: string[] = [];
      const retryBranches: string[] = [];
      const retryWorktrees = ownedWorktreeOperations(
        { ...runtime, store: reopened },
        {
          inspectWorktree: async (_repositoryPath, path) => {
            retryPaths.push(path);
            return { state: "absent" };
          },
          inspectBranch: async (_repositoryPath, branch) => {
            retryBranches.push(branch);
            return "absent";
          },
        },
      );
      const restarted = new DuoLaunchCoordinator(
        reopened,
        { resolveModelRoute: resolveNativeModelRoute },
        {} as never,
        {
          startPair: async () => [false, false],
          cancel: () => false,
        } as unknown as TurnController,
        join(runtime.workspace, ".inertia"),
        () => [providerInfo()],
        { worktrees: retryWorktrees },
      );

      await expect(restarted.cancel(payload.launchId)).resolves.toMatchObject({
        state: "cancelled",
        error: null,
      });
      expect(retryPaths).toEqual(recovery.plans.map(
        ({ plannedWorktreePath }) => plannedWorktreePath,
      ));
      expect(retryBranches).toEqual(recovery.plans.map(
        ({ plannedBranch }) => plannedBranch,
      ));
      const terminal = reopened.pairedLaunch(payload.launchId);
      expect(terminal.plans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          worktreeCleanupOutcome: "absent",
          branchCleanupOutcome: "absent",
        }),
        expect.objectContaining({
          worktreeCleanupOutcome: "absent",
          branchCleanupOutcome: "absent",
        }),
      ]));
    } finally {
      reopened?.close();
      if (!originalClosed) runtime.store.close();
    }
  });

  it("retries ambiguous read-only cleanup after restart and resolves only exact absence", async () => {
    const runtime = await createRuntime();
    let originalClosed = false;
    let reopened: RuntimeStore | null = null;
    try {
      await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
      let initialInspections = 0;
      let branchInspections = 0;
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
          worktrees: ownedWorktreeOperations(runtime, {
            create: async (
              _repositoryPath,
              worktreePath,
              options,
              hooks,
            ) => {
              hooks.beforeAdd();
              hooks.added({
                branch: options.branch,
                head: OWNED_WORKTREE_HEAD,
                path: worktreePath,
              });
              throw new Error("post-create status inspection failed");
            },
            inspectWorktree: async () => {
              initialInspections += 1;
              throw new GitError(
                "timeout",
                "worktree cleanup inspection was ambiguous",
              );
            },
            inspectBranch: async () => {
              branchInspections += 1;
              return "absent";
            },
          }),
        },
      );
      const payload = preparePayload(runtime, true);
      payload.sides[1].useWorktree = false;

      await expect(launches.prepare(payload)).rejects.toThrow(
        /post-create status inspection failed/u,
      );
      const recovery = runtime.store.pairedLaunch(payload.launchId);
      expect(recovery).toMatchObject({ state: "recovery-required" });
      expect(recovery.plans[0]).toMatchObject({
        worktreeCreationState: "created",
        cleanupBranchHead: OWNED_WORKTREE_HEAD,
        worktreeCleanupOutcome: null,
        worktreeRemovalStarted: false,
        worktreeRemovalConfirmed: false,
      });
      expect(initialInspections).toBe(1);
      expect(branchInspections).toBe(0);

      runtime.store.close();
      originalClosed = true;
      reopened = new RuntimeStore(
        runtime.databasePath,
        runtime.workspace,
        { recoverInterruptedRuns: false },
      );
      let retryInspections = 0;
      let retryBranchInspections = 0;
      let manualCleanupComplete = false;
      const restarted = new DuoLaunchCoordinator(
        reopened,
        { resolveModelRoute: resolveNativeModelRoute },
        {} as never,
        {
          startPair: async () => [false, false],
          cancel: () => false,
        } as unknown as TurnController,
        join(runtime.workspace, ".inertia"),
        () => [providerInfo()],
        {
          worktrees: ownedWorktreeOperations(
            { ...runtime, store: reopened },
            {
              inspectWorktree: async (_repositoryPath, path, branch, head) => {
                retryInspections += 1;
                if (manualCleanupComplete) return { state: "absent" };
                return {
                  state: "conflict",
                  ownership: { path, branch, head },
                } as never;
              },
              inspectBranch: async () => {
                retryBranchInspections += 1;
                return "absent";
              },
            },
          ),
        },
      );

      await expect(restarted.cancel(payload.launchId)).resolves.toMatchObject({
        state: "recovery-required",
        error: expect.stringContaining(
          "retained Duo worktree topology changed",
        ),
      });
      expect(retryInspections).toBe(1);
      expect(retryBranchInspections).toBe(0);
      expect(reopened.pairedLaunch(payload.launchId).plans[0]).toMatchObject({
        worktreeCleanupOutcome: "retained",
        worktreeRemovalStarted: false,
        worktreeRemovalConfirmed: false,
      });

      manualCleanupComplete = true;
      await expect(restarted.cancel(payload.launchId)).resolves.toMatchObject({
        state: "cancelled",
        error: null,
      });
      expect(retryInspections).toBe(2);
      expect(retryBranchInspections).toBe(1);
    } finally {
      reopened?.close();
      if (!originalClosed) runtime.store.close();
    }
  });

  it("preserves a worktree changed after read-only inspection", async () => {
    const runtime = await createRuntime();
    try {
      await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
      await execFileAsync("git", [
        "-C",
        runtime.workspace,
        "config",
        "user.name",
        "Inertia Tests",
      ]);
      await execFileAsync("git", [
        "-C",
        runtime.workspace,
        "config",
        "user.email",
        "tests@inertia.invalid",
      ]);
      await execFileAsync("git", [
        "-C",
        runtime.workspace,
        "commit",
        "--allow-empty",
        "-m",
        "Initial",
      ]);
      const replacementBranch = "user/changed-after-read-only-inspection";
      let changedAfterInspection = false;
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
            create: async (repositoryPath, worktreePath, options, hooks) => {
              await createWorktreeWithOwnershipReceipt(
                repositoryPath,
                worktreePath,
                options,
                hooks,
              );
              throw new Error("force compensation after worktree creation");
            },
            inspectWorktree: async (
              repositoryPath,
              worktreePath,
              branch,
              head,
            ) => {
              const inspection = await inspectOwnedWorktreeCleanupState(
                repositoryPath,
                worktreePath,
                branch,
                head,
              );
              if (inspection.state === "owned" && !changedAfterInspection) {
                changedAfterInspection = true;
                execFileSync(
                  "git",
                  ["switch", "-q", "-c", replacementBranch],
                  { cwd: worktreePath },
                );
                execFileSync(
                  "git",
                  [
                    "commit",
                    "--allow-empty",
                    "-q",
                    "-m",
                    "Change identity after read-only inspection",
                  ],
                  { cwd: worktreePath },
                );
              }
              return inspection;
            },
            inspectBranch: async () => {
              throw new Error("Changed ownership must prevent branch deletion.");
            },
          },
        },
      );
      const payload = preparePayload(runtime, true);
      payload.sides[1].useWorktree = false;

      await expect(launches.prepare(payload)).rejects.toThrow(
        /force compensation after worktree creation/u,
      );

      const recovery = runtime.store.pairedLaunch(payload.launchId);
      expect(recovery).toMatchObject({ state: "recovery-required" });
      expect(recovery.plans[0]).toMatchObject({
        worktreeCreationState: "created",
        worktreeCleanupOutcome: "retained",
        worktreeRemovalStarted: false,
        worktreeRemovalConfirmed: false,
      });
      const changedOwnership = await inspectRegisteredWorktreeOwnership(
        runtime.workspace,
        recovery.plans[0].plannedWorktreePath!,
        replacementBranch,
      );
      expect(changedOwnership.branch).toBe(replacementBranch);
      expect(changedOwnership.head).not.toBe(
        recovery.plans[0].cleanupBranchHead,
      );
      await expect(launches.cancel(payload.launchId)).resolves.toMatchObject({
        state: "recovery-required",
        error: expect.stringContaining(
          "retained Duo worktree topology changed",
        ),
      });
      await expect(inspectRegisteredWorktreeOwnership(
        runtime.workspace,
        recovery.plans[0].plannedWorktreePath!,
        replacementBranch,
      )).resolves.toMatchObject({
        branch: replacementBranch,
        head: changedOwnership.head,
      });
    } finally {
      runtime.store.close();
    }
  });

  it("preserves an exact worktree reattached after a legacy removal claim", async () => {
    const runtime = await createRuntime();
    try {
      await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
      await execFileAsync("git", [
        "-C",
        runtime.workspace,
        "-c",
        "user.name=Inertia Tests",
        "-c",
        "user.email=tests@inertia.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Initial",
      ]);
      const launchId = randomUUID();
      const conversationId = randomUUID();
      const worktreePath = join(runtime.workspace, "replacement path");
      const branch = `inertia/${conversationId.slice(0, 8)}`;
      runtime.store.createPairedLaunch(launchId, [
        {
          ordinal: 0,
          projectId: runtime.projectId,
          plannedConversationId: conversationId,
          plannedWorktreePath: worktreePath,
          plannedBranch: branch,
          ownsWorktree: true,
        },
        {
          ordinal: 1,
          projectId: runtime.projectId,
          plannedConversationId: randomUUID(),
          plannedWorktreePath: null,
          plannedBranch: "main",
          ownsWorktree: false,
        },
      ]);
      await createWorktreeWithOwnershipReceipt(
        runtime.workspace,
        worktreePath,
        { branch, createBranch: true, startPoint: "main" },
        {
          beforeAdd: () => {
            runtime.store.beginPairedLaunchWorktreeCreation(
              launchId,
              0,
              worktreePath,
              branch,
            );
          },
          notAdded: () => {
            runtime.store.rejectPairedLaunchWorktreeCreation(launchId, 0);
          },
          added: (ownership) => {
            runtime.store.recordPairedLaunchWorktreeCleanupOwnership(
              launchId,
              0,
              worktreePath,
              ownership.path,
              ownership.branch,
              ownership.head,
            );
          },
        },
      );
      const created = runtime.store.pairedLaunch(launchId).plans[0];
      runtime.store.beginPairedLaunchWorktreeRemoval(launchId, 0);
      await execFileAsync("git", [
        "-C",
        runtime.workspace,
        "worktree",
        "remove",
        "--",
        worktreePath,
      ]);
      runtime.store.failPairedLaunch(
        launchId,
        "recovery-required",
        "A legacy removal completed before its durable confirmation.",
      );
      await createWorktree(runtime.workspace, worktreePath, {
        branch,
      });

      await expect(coordinator(runtime).cancel(launchId)).resolves.toMatchObject({
        state: "recovery-required",
        error: expect.stringContaining(
          "owned Duo worktree remains",
        ),
      });
      expect(runtime.store.pairedLaunch(launchId).plans[0]).toMatchObject({
        worktreeCleanupOutcome: "retained",
        worktreeRemovalStarted: true,
        worktreeRemovalConfirmed: false,
      });
      await expect(inspectRegisteredWorktreeOwnership(
        runtime.workspace,
        worktreePath,
        branch,
      )).resolves.toMatchObject({
        branch,
        head: created.cleanupBranchHead,
      });
      await expect(execFileAsync("git", [
        "-C",
        runtime.workspace,
        "rev-parse",
        branch,
      ])).resolves.toMatchObject({ stdout: expect.stringMatching(/[0-9a-f]{40}/u) });
    } finally {
      runtime.store.close();
    }
  });

  it("confirms exact manual absence with a surviving descendant branch", async () => {
    const runtime = await createRuntime();
    let originalClosed = false;
    let reopened: RuntimeStore | null = null;
    try {
      await execFileAsync("git", ["init", "-b", "main", runtime.workspace]);
      await execFileAsync("git", [
        "-C",
        runtime.workspace,
        "-c",
        "user.name=Inertia Tests",
        "-c",
        "user.email=tests@inertia.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Initial",
      ]);
      const launchId = randomUUID();
      const conversationId = randomUUID();
      const worktreePath = join(runtime.workspace, "removed before receipt");
      const branch = `inertia/${conversationId.slice(0, 8)}`;
      runtime.store.createPairedLaunch(launchId, [
        {
          ordinal: 0,
          projectId: runtime.projectId,
          plannedConversationId: conversationId,
          plannedWorktreePath: worktreePath,
          plannedBranch: branch,
          ownsWorktree: true,
        },
        {
          ordinal: 1,
          projectId: runtime.projectId,
          plannedConversationId: randomUUID(),
          plannedWorktreePath: null,
          plannedBranch: "main",
          ownsWorktree: false,
        },
      ]);
      await createWorktreeWithOwnershipReceipt(
        runtime.workspace,
        worktreePath,
        { branch, createBranch: true, startPoint: "main" },
        {
          beforeAdd: () => {
            runtime.store.beginPairedLaunchWorktreeCreation(
              launchId,
              0,
              worktreePath,
              branch,
            );
          },
          notAdded: () => {
            runtime.store.rejectPairedLaunchWorktreeCreation(launchId, 0);
          },
          added: (ownership) => {
            runtime.store.recordPairedLaunchWorktreeCleanupOwnership(
              launchId,
              0,
              worktreePath,
              ownership.path,
              ownership.branch,
              ownership.head,
            );
          },
        },
      );
      const created = runtime.store.pairedLaunch(launchId).plans[0];
      runtime.store.beginPairedLaunchWorktreeRemoval(launchId, 0);
      await execFileAsync("git", [
        "-C",
        runtime.workspace,
        "worktree",
        "remove",
        "--",
        worktreePath,
      ]);
      runtime.store.failPairedLaunch(
        launchId,
        "recovery-required",
        "A legacy removal completed before its durable confirmation.",
      );
      const descendantBranch = `${branch}/user-topic`;
      await execFileAsync("git", [
        "-C",
        runtime.workspace,
        "branch",
        "-D",
        branch,
      ]);
      await execFileAsync("git", [
        "-C",
        runtime.workspace,
        "branch",
        descendantBranch,
        "main",
      ]);
      expect(runtime.store.pairedLaunch(launchId).plans[0]).toMatchObject({
        worktreeRemovalStarted: true,
        worktreeRemovalConfirmed: false,
      });

      runtime.store.close();
      originalClosed = true;
      reopened = new RuntimeStore(
        runtime.databasePath,
        runtime.workspace,
        { recoverInterruptedRuns: false },
      );
      const restarted = coordinator({ ...runtime, store: reopened });

      await expect(restarted.cancel(launchId)).resolves.toMatchObject({
        state: "cancelled",
        error: null,
      });
      expect(reopened.pairedLaunch(launchId).plans[0]).toMatchObject({
        worktreeRemovalStarted: true,
        worktreeRemovalConfirmed: false,
        worktreeCleanupOutcome: "absent",
        branchCleanupOutcome: "absent",
      });
      await expect(execFileAsync("git", [
        "-C",
        runtime.workspace,
        "show-ref",
        "--verify",
        `refs/heads/${branch}`,
      ])).rejects.toBeDefined();
      await expect(execFileAsync("git", [
        "-C",
        runtime.workspace,
        "rev-parse",
        descendantBranch,
      ])).resolves.toMatchObject({
        stdout: expect.stringContaining(created.cleanupBranchHead!),
      });
    } finally {
      reopened?.close();
      if (!originalClosed) runtime.store.close();
    }
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

  it.each([1, 2] as const)(
    "awaits real provider acknowledgement and compensates async launch rejection on side %s",
    async (rejectedSide) => {
      const runtime = await createRuntime();
      const prepared = preparePair(runtime);
      runtime.provider.rejectOnRun = rejectedSide;

      const status = await coordinator(runtime).dispatch(prepared.launchId);

      expect(status.state).toBe("failed");
      expect(runtime.provider.inputs).toHaveLength(2);
      const sibling = prepared.conversations[rejectedSide === 1 ? 1 : 0];
      expect(runtime.provider.cancellations).toContain(sibling.id);
      expect(runtime.store.agentTurn(
        prepared.queued[rejectedSide === 1 ? 1 : 0].turn.id,
      ).status).toBe("cancelled");
      expect(runtime.store.agentTurn(
        prepared.queued[rejectedSide - 1].turn.id,
      ).status).toBe("failed");
      runtime.store.close();
    },
  );

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
