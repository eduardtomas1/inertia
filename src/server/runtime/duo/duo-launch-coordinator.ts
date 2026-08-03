import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  ClientCommand,
  DuoGitRecoveryAction,
  DuoLaunchStatus,
  DuoWorktreeRecoveryGuidance,
  ModelSelection,
  ProviderInfo,
} from "../../../shared/contracts";
import {
  legacyProviderIdForHarness,
  nativeModelSelection,
} from "../../../shared/model-routing";
import type { RuntimeStore } from "../../database";
import {
  createWorktreeWithOwnershipReceipt,
  getRepositoryStatus,
  GitError,
  inspectBranchCleanupOutcome,
  inspectOwnedWorktreeCleanupState,
  inspectUnacknowledgedWorktreeCreation,
  preflightWorktreeFilesystemIdentity,
  type OwnedWorktreeCreationHooks,
} from "../../git";
import type { NewConversationOptions } from "../../persistence/types";
import type { WorktreeFilesystemReceipt } from "../../worktree-filesystem-identity";
import type { ProviderManager } from "../../providers";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { TurnController } from "../turns/turn-controller";

type DuoPrepareCommand = Extract<ClientCommand, { type: "duo.prepare" }>;
type DuoPreparePayload = DuoPrepareCommand["payload"];
type DuoSidePayload = DuoPreparePayload["sides"][number];
const MAX_PENDING_DUO_LAUNCHES = 16;

export interface PreparedDuoLaunch {
  launchId: string;
  state: "prepared";
  sides: [
    { ordinal: 0; conversationId: string; turnId: string },
    { ordinal: 1; conversationId: string; turnId: string },
  ];
}

interface PreflightSide {
  ordinal: 0 | 1;
  payload: DuoSidePayload;
  conversationId: string;
  repositoryPath: string;
  selection: ModelSelection;
  startPoint: string | null;
  branch: string | null;
  worktreePath: string | null;
  ownsWorktree: boolean;
}

export interface DuoWorktreeOperations {
  preflightFilesystem(repositoryPath: string): Promise<void>;
  create(
    repositoryPath: string,
    worktreePath: string,
    options: { branch: string; createBranch: true; startPoint: string },
    hooks: OwnedWorktreeCreationHooks,
  ): ReturnType<typeof createWorktreeWithOwnershipReceipt>;
  inspectWorktree(
    repositoryPath: string,
    worktreePath: string,
    expectedBranch: string,
    expectedHead: string,
    expectedWorktreeId: string,
    expectedRepositoryIdentity: string,
    expectedOwnershipToken: string,
    expectedFilesystemReceipt: WorktreeFilesystemReceipt,
  ): ReturnType<typeof inspectOwnedWorktreeCleanupState>;
  inspectCreatingWorktree(
    repositoryPath: string,
    worktreePath: string,
    expectedBranch: string,
  ): ReturnType<typeof inspectUnacknowledgedWorktreeCreation>;
  inspectBranch(
    repositoryPath: string,
    branch: string,
    expectedHead: string,
  ): ReturnType<typeof inspectBranchCleanupOutcome>;
}

class DuoLaunchCancelledError extends Error {
  constructor() {
    super("The Duo launch was cancelled before provider dispatch.");
    this.name = "DuoLaunchCancelledError";
  }
}

class RetainedWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetainedWorktreeError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The Duo launch could not be prepared.";
}

function recoveryGuidance(
  store: RuntimeStore,
  status: ReturnType<RuntimeStore["pairedLaunch"]>,
): DuoWorktreeRecoveryGuidance[] {
  if (status.state !== "recovery-required") return [];
  return status.plans.flatMap((plan): DuoWorktreeRecoveryGuidance[] => {
    if (
      !plan.ownsWorktree
      || !plan.plannedWorktreePath
      || !plan.plannedBranch
      || status.sides[plan.ordinal].conversationId
    ) return [];
    let topology: DuoWorktreeRecoveryGuidance["topology"];
    if (
      plan.worktreeCleanupOutcome === "absent"
      && plan.branchCleanupOutcome === "retained"
    ) {
      topology = "branch-retained";
    } else if (plan.worktreeCleanupOutcome === "retained") {
      topology = plan.worktreeCleanupTopology ?? "ambiguous";
    } else if (
      plan.worktreeCreationState === "creating"
      || plan.worktreeCreationState === "created"
    ) {
      topology = "ambiguous";
    } else {
      return [];
    }
    const cwd = store.projectPath(plan.projectId);
    const branchAction: DuoGitRecoveryAction = {
      label: "Remove generated branch after inspecting it",
      cwd,
      executable: "git",
      args: ["branch", "-d", "--", plan.plannedBranch],
    };
    const actions: DuoGitRecoveryAction[] = topology === "owned"
      && plan.cleanupObservedPath
      ? [
        {
          label: "Remove retained linked worktree",
          cwd,
          executable: "git",
          args: ["worktree", "remove", "--", plan.cleanupObservedPath],
        },
        branchAction,
      ]
      : topology === "branch-retained"
        ? [branchAction]
        : [];
    return [{
      kind: "git-worktree",
      ordinal: plan.ordinal,
      topology,
      repositoryPath: cwd,
      plannedPath: plan.plannedWorktreePath,
      observedPath: plan.cleanupObservedPath,
      worktreeId: plan.cleanupWorktreeId,
      generatedBranch: plan.plannedBranch,
      expectedHead: plan.cleanupBranchHead,
      observedBranch: plan.cleanupObservedBranch,
      observedHead: plan.cleanupObservedHead,
      actions,
    }];
  });
}

function publicStatus(
  store: RuntimeStore,
  status: ReturnType<RuntimeStore["pairedLaunch"]>,
): DuoLaunchStatus {
  return {
    launchId: status.launchId,
    state: status.state,
    error: status.error,
    sides: status.sides,
    recoveryGuidance: recoveryGuidance(store, status),
  };
}

function expectedLaunchOwnedBranch(
  plan: ReturnType<RuntimeStore["pairedLaunch"]>["plans"][number],
): string {
  const expected = `inertia/${plan.plannedConversationId.slice(0, 8)}`;
  if (plan.plannedBranch !== expected) {
    throw new Error(
      "The Duo cleanup branch does not match its generated launch identity.",
    );
  }
  return expected;
}

async function cleanupUnadoptedOwnedWorktree(
  store: RuntimeStore,
  launchId: string,
  ordinal: 0 | 1,
  worktrees: DuoWorktreeOperations,
): Promise<void> {
  const launch = store.pairedLaunch(launchId);
  const plan = launch.plans[ordinal];
  const side = launch.sides[ordinal];
  if (
    !plan.ownsWorktree
    || !plan.plannedWorktreePath
    || side.conversationId
  ) return;
  const worktreePath = plan.plannedWorktreePath;
  const branch = expectedLaunchOwnedBranch(plan);
  const repositoryPath = store.projectPath(plan.projectId);
  if (
    plan.worktreeCreationState === "pending"
    || plan.worktreeCreationState === "not-created"
  ) return;
  if (plan.worktreeCreationState === "creating") {
    const inspection = await worktrees.inspectCreatingWorktree(
      repositoryPath,
      worktreePath,
      branch,
    );
    if (inspection === "retained") {
      throw new RetainedWorktreeError(
        "Worktree creation was interrupted before durable ownership acknowledgement and planned artifacts may remain. Automatic cleanup was withheld.",
      );
    }
    store.rejectPairedLaunchWorktreeCreation(launchId, ordinal);
    return;
  }
  const branchHead = plan.cleanupBranchHead;
  const worktreeId = plan.cleanupWorktreeId;
  const repositoryIdentity = plan.cleanupRepositoryIdentity;
  const ownershipToken = plan.cleanupWorktreeToken;
  const filesystemReceipt = plan.cleanupFilesystemReceipt;
  if (
    !branchHead
    || !worktreeId
    || !repositoryIdentity
    || !ownershipToken
    || !filesystemReceipt
  ) {
    throw new Error(
      "The durable linked-worktree identity is incomplete. Automatic cleanup was withheld and absence cannot be inferred.",
    );
  }
  const inspection = await worktrees.inspectWorktree(
    repositoryPath,
    worktreePath,
    branch,
    branchHead,
    worktreeId,
    repositoryIdentity,
    ownershipToken,
    filesystemReceipt,
  );
  if (inspection.state !== "absent") {
    const registered = inspection.state === "registered"
      ? inspection.identity
      : null;
    const exact = registered !== null
      && resolve(registered.path) === resolve(worktreePath)
      && registered.branch === branch
      && registered.head === branchHead;
    store.recordPairedLaunchWorktreeCleanupObservation(
      launchId,
      ordinal,
      "retained",
      {
        topology: exact ? "owned" : "conflict",
        path: registered?.path ?? null,
        branch: registered?.branch ?? null,
        head: registered?.head ?? null,
      },
    );
    if (!exact) {
      throw new RetainedWorktreeError(
        "A launch-owned linked-worktree identity remains or conflicts with the expected topology. Automatic cleanup was withheld. Review the structured recovery details before making a manual change.",
      );
    }
    throw new RetainedWorktreeError(
      "A launch-owned linked worktree remains registered. Automatic cleanup was withheld because Git cannot atomically guard its identity during removal. Review the structured recovery details and remove it manually with a platform-appropriate Git client.",
    );
  }
  store.recordPairedLaunchWorktreeCleanupObservation(
    launchId,
    ordinal,
    "absent",
    { topology: null, path: null, branch: null, head: null },
  );
  const branchOutcome = await worktrees.inspectBranch(
    repositoryPath,
    branch,
    branchHead,
  );
  store.recordPairedLaunchBranchCleanupOutcome(
    launchId,
    ordinal,
    branchOutcome,
  );
  if (branchOutcome === "retained") {
    throw new RetainedWorktreeError(
      "The launch-owned linked worktree registration is absent, but its generated branch remains. Review the structured recovery details and remove the branch manually with a platform-appropriate Git client.",
    );
  }
}

function cleanupFailureMessage(
  results: readonly PromiseSettledResult<void>[],
  prefix: string,
): string | null {
  const failures = [...new Set(results.flatMap((result) =>
    result.status === "rejected" ? [errorMessage(result.reason)] : []))];
  return failures.length === 0 ? null : `${prefix}: ${failures.join(" ")}`;
}

export class DuoLaunchCoordinator {
  private readonly prepareTasks = new Map<string, Promise<PreparedDuoLaunch>>();
  private readonly recoveryCleanupTasks = new Map<
    string,
    Promise<DuoLaunchStatus>
  >();
  private readonly cancellationRequests = new Set<string>();
  private readonly worktrees: DuoWorktreeOperations;

  constructor(
    private readonly store: RuntimeStore,
    private readonly providers: Pick<ProviderManager, "resolveModelRoute">,
    private readonly backendProfiles: BackendProfileController,
    private readonly turns: TurnController,
    private readonly dataDirectory: string,
    private readonly providerInfo: () => readonly ProviderInfo[],
    options: { worktrees?: DuoWorktreeOperations } = {},
  ) {
    this.worktrees = options.worktrees ?? {
      preflightFilesystem: preflightWorktreeFilesystemIdentity,
      create: createWorktreeWithOwnershipReceipt,
      inspectCreatingWorktree: inspectUnacknowledgedWorktreeCreation,
      inspectWorktree: inspectOwnedWorktreeCleanupState,
      inspectBranch: inspectBranchCleanupOutcome,
    };
  }

  prepare(payload: DuoPreparePayload): Promise<PreparedDuoLaunch> {
    const current = this.prepareTasks.get(payload.launchId);
    if (current) return current;
    const durable = this.store.findPairedLaunch(payload.launchId);
    if (durable) return Promise.resolve(this.preparedResult(durable));
    const task = this.prepareFresh(payload).finally(() => {
      this.prepareTasks.delete(payload.launchId);
      this.cancellationRequests.delete(payload.launchId);
    });
    this.prepareTasks.set(payload.launchId, task);
    return task;
  }

  async dispatch(launchId: string): Promise<DuoLaunchStatus> {
    let launch = this.store.pairedLaunch(launchId);
    if (launch.state !== "prepared") return publicStatus(this.store, launch);
    if (launch.cancelRequested || this.cancellationRequests.has(launchId)) {
      return this.cancel(launchId);
    }
    if (!this.store.claimPairedLaunchDispatch(launchId)) {
      return publicStatus(this.store, this.store.pairedLaunch(launchId));
    }
    launch = this.store.pairedLaunch(launchId);
    const turnIds = launch.sides.map(({ turnId }) => turnId);
    if (!turnIds[0] || !turnIds[1]) {
      return publicStatus(this.store, this.store.failPairedLaunch(
        launchId,
        "interrupted",
        "The durable Duo dispatch claim is missing a turn identity. It was not retried.",
      ));
    }
    let started: [boolean, boolean];
    try {
      started = await this.turns.startPair([turnIds[0], turnIds[1]]);
    } catch (error) {
      for (const { conversationId } of launch.sides) {
        if (conversationId) this.turns.cancel(conversationId);
      }
      return publicStatus(this.store, this.store.failPairedLaunch(
        launchId,
        "interrupted",
        `Provider dispatch returned an ambiguous result and was not retried: ${errorMessage(error)}`,
      ));
    }
    const afterStart = this.store.pairedLaunch(launchId);
    if (afterStart.state !== "dispatching") {
      return publicStatus(this.store, afterStart);
    }
    const failure = started.every(Boolean)
      ? null
      : "Only part of the provider dispatch was accepted. Cancellation was requested for any started sibling, but provider-side effects are not atomic and must be inspected. Dispatch was not retried.";
    return publicStatus(this.store, this.store.finishPairedLaunchDispatch(
      launchId,
      started,
      failure,
    ));
  }

  async cancel(launchId: string): Promise<DuoLaunchStatus> {
    this.cancellationRequests.add(launchId);
    let launch = this.store.findPairedLaunch(launchId);
    if (!launch) {
      const preparing = this.prepareTasks.get(launchId);
      if (preparing) {
        await preparing.catch(() => undefined);
        launch = this.store.findPairedLaunch(launchId);
      }
      if (!launch) {
        return publicStatus(this.store, this.store.pairedLaunch(launchId));
      }
    }
    this.store.requestPairedLaunchCancellation(launchId);
    const latest = this.store.pairedLaunch(launchId);
    if (
      latest.state === "cancelled"
      || latest.state === "failed"
      || latest.state === "interrupted"
    ) return publicStatus(this.store, latest);
    for (const { conversationId } of latest.sides) {
      if (conversationId) this.turns.cancel(conversationId);
    }
    if (latest.state === "recovery-required") {
      const current = this.recoveryCleanupTasks.get(launchId);
      if (current) return current;
      const cleanup = this.retryRecoveryCleanup(latest).finally(() => {
        this.recoveryCleanupTasks.delete(launchId);
      });
      this.recoveryCleanupTasks.set(launchId, cleanup);
      return cleanup;
    }
    if (latest.state === "preparing" && this.prepareTasks.has(launchId)) {
      return publicStatus(this.store, latest);
    }
    return publicStatus(
      this.store,
      this.store.finishPairedLaunchCancellation(launchId),
    );
  }

  status(launchId: string): DuoLaunchStatus {
    return publicStatus(this.store, this.store.pairedLaunch(launchId));
  }

  acknowledgeInterrupted(launchId: string): DuoLaunchStatus {
    const current = this.store.pairedLaunch(launchId);
    if (current.state === "interrupted") {
      for (const { conversationId } of current.sides) {
        if (conversationId) this.turns.cancel(conversationId);
      }
    }
    return publicStatus(
      this.store,
      this.store.acknowledgeInterruptedPairedLaunch(launchId),
    );
  }

  pending(projectIds: readonly string[]): {
    launchIds: string[];
    hasMore: boolean;
  } {
    return this.store.pendingPairedLaunchIds(
      projectIds,
      MAX_PENDING_DUO_LAUNCHES,
    );
  }

  private async prepareFresh(
    payload: DuoPreparePayload,
  ): Promise<PreparedDuoLaunch> {
    const sides = await Promise.all([
      this.preflightSide(payload.sides[0], 0),
      this.preflightSide(payload.sides[1], 1),
    ]);
    const now = new Date().toISOString();
    this.store.createPairedLaunch(payload.launchId, [
      this.sidePlan(sides[0]),
      this.sidePlan(sides[1]),
    ], now);

    let conversationsAdopted = false;
    try {
      this.assertNotCancelled(payload.launchId);
      for (const side of sides) {
        if (!side.ownsWorktree || !side.worktreePath || !side.branch) continue;
        mkdirSync(resolve(side.worktreePath, ".."), {
          recursive: true,
          mode: 0o700,
        });
        const plannedWorktreePath = side.worktreePath;
        const plannedBranch = side.branch;
        const status = await this.worktrees.create(
          side.repositoryPath,
          side.worktreePath,
          {
            branch: side.branch,
            createBranch: true,
            startPoint: side.startPoint!,
          },
          {
            beforeAdd: (ownershipToken) => {
              this.store.beginPairedLaunchWorktreeCreation(
                payload.launchId,
                side.ordinal,
                plannedWorktreePath,
                plannedBranch,
                ownershipToken,
              );
            },
            notAdded: () => {
              this.store.rejectPairedLaunchWorktreeCreation(
                payload.launchId,
                side.ordinal,
              );
            },
            added: (ownership) => {
              this.store.recordPairedLaunchWorktreeCleanupOwnership(
                payload.launchId,
                side.ordinal,
                plannedWorktreePath,
                ownership.path,
                ownership.branch,
                ownership.head,
                ownership.worktreeId,
                ownership.repositoryIdentity,
                ownership.ownershipToken,
                ownership.filesystemReceipt,
              );
              side.worktreePath = ownership.path;
              side.branch = ownership.branch;
            },
          },
        );
        if (
          resolve(status.root) !== resolve(side.worktreePath)
          || status.branch !== side.branch
        ) {
          throw new Error(
            "The created Duo worktree status did not match its durable ownership receipt.",
          );
        }
        this.assertNotCancelled(payload.launchId);
      }

      const conversations = this.store.createPairedConversations(
        payload.launchId,
        [
          this.conversationPlan(sides[0]),
          this.conversationPlan(sides[1]),
        ],
      );
      conversationsAdopted = true;
      this.assertNotCancelled(payload.launchId);
      const queued = this.turns.queuePair(payload.launchId, [
        {
          conversationId: conversations[0].id,
          content: payload.prompt,
          attachments: [],
          activateConversation: false,
          skills: [],
        },
        {
          conversationId: conversations[1].id,
          content: payload.prompt,
          attachments: [],
          activateConversation: false,
          skills: [],
        },
      ]);
      return {
        launchId: payload.launchId,
        state: "prepared",
        sides: [
          {
            ordinal: 0,
            conversationId: conversations[0].id,
            turnId: queued[0].turn.id,
          },
          {
            ordinal: 1,
            conversationId: conversations[1].id,
            turnId: queued[1].turn.id,
          },
        ],
      };
    } catch (error) {
      const cancellation = error instanceof DuoLaunchCancelledError;
      let compensationFailure: string | null = null;
      if (!conversationsAdopted) {
        const compensation = await Promise.allSettled(
          [...this.store.pairedLaunch(payload.launchId).plans].reverse().map((plan) =>
            cleanupUnadoptedOwnedWorktree(
              this.store,
              payload.launchId,
              plan.ordinal,
              this.worktrees,
            )),
        );
        compensationFailure = cleanupFailureMessage(
          compensation,
          "Owned worktree cleanup needs attention",
        );
      }
      const failure = [errorMessage(error), compensationFailure]
        .filter(Boolean)
        .join(" ");
      if (cancellation && !compensationFailure) {
        this.store.finishPairedLaunchCancellation(payload.launchId);
      } else {
        this.store.failPairedLaunch(
          payload.launchId,
          compensationFailure ? "recovery-required" : "failed",
          failure,
        );
      }
      throw error;
    }
  }

  private async retryRecoveryCleanup(
    launch: ReturnType<RuntimeStore["pairedLaunch"]>,
  ): Promise<DuoLaunchStatus> {
    const cleanup = await Promise.allSettled(launch.plans.map((plan) =>
      cleanupUnadoptedOwnedWorktree(
        this.store,
        launch.launchId,
        plan.ordinal,
        this.worktrees,
      )));
    const failure = cleanupFailureMessage(
      cleanup,
      "Owned worktree cleanup still needs attention",
    );
    if (failure) {
      return publicStatus(this.store, this.store.failPairedLaunch(
        launch.launchId,
        "recovery-required",
        failure,
      ));
    }
    return publicStatus(
      this.store,
      this.store.finishPairedLaunchCancellation(launch.launchId),
    );
  }

  private async preflightSide(
    payload: DuoSidePayload,
    ordinal: 0 | 1,
  ): Promise<PreflightSide> {
    const settings = this.store.shellSnapshot().settings;
    const selection = this.backendProfiles.validateSelection(
      payload.modelSelection ?? nativeModelSelection({
        providerId: payload.providerId ?? settings.defaultProvider,
        modelId: payload.model || settings.defaultModel || "provider-default",
        alias: payload.model || settings.defaultModel || null,
        reasoningEffort: payload.reasoningEffort
          ?? settings.defaultReasoningEffort
          ?? null,
      }),
    );
    this.providers.resolveModelRoute(selection);
    const providerId = legacyProviderIdForHarness(selection.harnessId);
    const provider = this.providerInfo().find(({ id }) => id === providerId);
    const readiness = await this.backendProfiles.readiness(selection, provider);
    if (readiness && !readiness.ready) {
      throw new Error(
        readiness.message ?? "The selected model backend is unavailable.",
      );
    }
    if (!readiness && !provider?.canRun) {
      throw new Error(
        provider?.statusMessage
          ?? "This agent is not ready. Open Settings to finish setup.",
      );
    }

    const repositoryPath = this.store.projectPath(payload.projectId);
    if (payload.useWorktree && payload.worktreePath) {
      throw new Error(
        "Choose either an existing worktree or a new isolated worktree.",
      );
    }
    const conversationId = randomUUID();
    if (payload.worktreePath) {
      const requestedPath = resolve(payload.worktreePath);
      const reusable = this.store.shellSnapshot().conversations.some(
        (conversation) => conversation.projectId === payload.projectId
          && conversation.worktreePath !== null
          && resolve(conversation.worktreePath) === requestedPath,
      );
      if (!reusable || requestedPath === resolve(repositoryPath)) {
        throw new Error(
          "That worktree is not attached to a chat in this project.",
        );
      }
      const status = await getRepositoryStatus(requestedPath);
      if (payload.branch && payload.branch !== status.branch) {
        throw new Error(
          `That worktree is currently on ${status.branch ?? "a detached checkout"}, not ${payload.branch}.`,
        );
      }
      return {
        ordinal,
        payload,
        conversationId,
        repositoryPath,
        selection,
        startPoint: null,
        branch: status.branch,
        worktreePath: status.root,
        ownsWorktree: false,
      };
    }

    let status: Awaited<ReturnType<typeof getRepositoryStatus>> | null = null;
    try {
      status = await getRepositoryStatus(repositoryPath);
    } catch (error) {
      if (!(error instanceof GitError && error.code === "not-repository")) {
        throw error;
      }
    }
    if (payload.branch && payload.branch !== status?.branch) {
      throw new Error(
        `The project checkout is currently on ${status?.branch ?? "a detached checkout"}, not ${payload.branch}.`,
      );
    }
    if (payload.useWorktree && !status?.branch) {
      throw new Error("Check out a branch before creating an isolated worktree.");
    }
    if (payload.useWorktree) {
      await this.worktrees.preflightFilesystem(repositoryPath);
    }
    return {
      ordinal,
      payload,
      conversationId,
      repositoryPath,
      selection,
      startPoint: payload.useWorktree ? status!.branch : null,
      branch: payload.useWorktree
        ? `inertia/${conversationId.slice(0, 8)}`
        : status?.branch ?? null,
      worktreePath: payload.useWorktree
        ? join(this.dataDirectory, "worktrees", conversationId)
        : null,
      ownsWorktree: payload.useWorktree === true,
    };
  }

  private conversationOptions(side: PreflightSide): NewConversationOptions {
    const providerId = legacyProviderIdForHarness(side.selection.harnessId);
    if (!providerId) {
      throw new Error("That agent harness is unavailable in this build.");
    }
    return {
      id: side.conversationId,
      providerId,
      modelSelection: side.selection,
      interactionMode: side.payload.interactionMode,
      accessMode: side.payload.accessMode,
      branch: side.branch,
      worktreePath: side.worktreePath,
      activate: false,
    };
  }

  private sidePlan(
    side: PreflightSide,
  ): Parameters<RuntimeStore["createPairedLaunch"]>[1][number] {
    return {
      ordinal: side.ordinal,
      projectId: side.payload.projectId,
      plannedConversationId: side.conversationId,
      plannedWorktreePath: side.worktreePath,
      plannedBranch: side.branch,
      ownsWorktree: side.ownsWorktree,
    };
  }

  private conversationPlan(
    side: PreflightSide,
  ): Parameters<RuntimeStore["createPairedConversations"]>[1][number] {
    return {
      projectId: side.payload.projectId,
      title: side.payload.title,
      options: this.conversationOptions(side),
    };
  }

  private assertNotCancelled(launchId: string): void {
    if (
      this.cancellationRequests.has(launchId)
      || this.store.pairedLaunch(launchId).cancelRequested
    ) {
      throw new DuoLaunchCancelledError();
    }
  }

  private preparedResult(
    launch: ReturnType<RuntimeStore["pairedLaunch"]>,
  ): PreparedDuoLaunch {
    if (
      launch.state !== "prepared"
      || !launch.sides[0].conversationId
      || !launch.sides[0].turnId
      || !launch.sides[1].conversationId
      || !launch.sides[1].turnId
    ) {
      throw new Error(
        launch.error
          ?? `The Duo launch is ${launch.state}; inspect its status before continuing.`,
      );
    }
    return {
      launchId: launch.launchId,
      state: "prepared",
      sides: [
        {
          ordinal: 0,
          conversationId: launch.sides[0].conversationId,
          turnId: launch.sides[0].turnId,
        },
        {
          ordinal: 1,
          conversationId: launch.sides[1].conversationId,
          turnId: launch.sides[1].turnId,
        },
      ],
    };
  }
}

/**
 * Reconciles durable pre-dispatch state before providers or clients are
 * admitted. Dispatch claims are never replayed. Only worktrees that this
 * launch created and never attached to a conversation are compensated.
 */
export async function reconcileInterruptedDuoLaunches(
  store: RuntimeStore,
  options: { worktrees?: DuoWorktreeOperations } = {},
): Promise<void> {
  const worktrees = options.worktrees ?? {
    preflightFilesystem: preflightWorktreeFilesystemIdentity,
    create: createWorktreeWithOwnershipReceipt,
    inspectCreatingWorktree: inspectUnacknowledgedWorktreeCreation,
    inspectWorktree: inspectOwnedWorktreeCleanupState,
    inspectBranch: inspectBranchCleanupOutcome,
  };
  const recovered = store.recoverInterruptedPairedLaunches();
  for (const launch of recovered) {
    if (launch.state === "interrupted") continue;
    const cleanup = await Promise.allSettled(launch.plans.map((plan) =>
      cleanupUnadoptedOwnedWorktree(
        store,
        launch.launchId,
        plan.ordinal,
        worktrees,
      )));
    const failure = cleanupFailureMessage(
      cleanup,
      "Duo restart cleanup needs attention",
    );
    if (failure) {
      store.failPairedLaunch(
        launch.launchId,
        "recovery-required",
        failure,
      );
    } else {
      store.failPairedLaunch(
        launch.launchId,
        "failed",
        "Duo preparation was interrupted before dispatch. Owned worktrees are absent and no provider was retried.",
      );
    }
  }
}
