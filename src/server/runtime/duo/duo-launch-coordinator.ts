import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  isAgentTurnTerminalStatus,
  type AgentTurn,
  ClientCommand,
  DuoLaunchStatus,
  ModelSelection,
  ProviderInfo,
} from "../../../shared/contracts";
import {
  legacyProviderIdForHarness,
  nativeModelSelection,
} from "../../../shared/model-routing";
import type { RuntimeStore } from "../../database";
import {
  getRepositoryStatus,
  GitError,
} from "../../git";
import type { NewConversationOptions } from "../../persistence/types";
import type { ProviderManager } from "../../providers";
import { normalizeIdentityPath } from "../../project-identity";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { TurnController } from "../turns/turn-controller";
import type { WorkspaceRunController } from "../workspace-run-controller";
import {
  type PinnedWorktreeSourceIdentity,
  pinWorktreeSourceIdentity,
  verifyWorktreeSourceIdentity,
  withWorktreeSourceReservations,
} from "../worktree-source-identity";
import { buildDuoComparisonPrompt } from "./duo-comparison";
import {
  reconcileDuoDeletionLaunches,
  reconcileInactiveDuoLaunchTurns,
} from "./duo-inactive-recovery";
import { publicDuoLaunchStatus as publicStatus } from "./duo-launch-status";
import {
  cleanupFailureMessage,
  cleanupUnadoptedOwnedWorktree,
  defaultDuoWorktreeOperations,
  duoLaunchErrorMessage as errorMessage,
  type DuoWorktreeOperations,
} from "./duo-worktree-recovery";

export type { DuoWorktreeOperations } from "./duo-worktree-recovery";

type DuoPrepareCommand = Extract<ClientCommand, { type: "duo.prepare" }>;
type DuoPreparePayload = DuoPrepareCommand["payload"];
type DuoSidePayload = DuoPreparePayload["sides"][number];
type DuoComparisonPayload = NonNullable<DuoPreparePayload["comparison"]>;
const MAX_PENDING_DUO_LAUNCHES = 16;
const MAX_DUO_DELETION_RECOVERIES = 16;
// Terminal projections can trigger a bounded native-workflow refresh for a
// source conversation before the locked judge claims that same checkout.
// A native-goal read is bounded at six seconds and its owned process cleanup
// at two more. Leave scheduling headroom so this local handoff can drain
// without retrying a provider or leaving the comparison waiting forever.
const DEFAULT_COMPARISON_CHECKOUT_ACQUIRE_TIMEOUT_MS = 10_000;
const COMPARISON_CHECKOUT_ACQUIRE_POLL_MS = 50;

export interface PreparedDuoLaunch {
  launchId: string;
  state: "prepared";
  sides: [
    { ordinal: 0; conversationId: string; turnId: string },
    { ordinal: 1; conversationId: string; turnId: string },
  ];
  comparison?: {
    conversationId: string;
  };
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
  worktreeSource: PinnedWorktreeSourceIdentity | null;
}

interface PreflightComparison {
  payload: DuoComparisonPayload;
  conversationId: string;
  selection: ModelSelection;
}

type DuoSourceControlOperations = Pick<
  WorkspaceRunController<unknown>,
  "trackSourceControl"
>;

class DuoLaunchCancelledError extends Error {
  constructor() {
    super("The Duo launch was cancelled before provider dispatch.");
    this.name = "DuoLaunchCancelledError";
  }
}

export class DuoLaunchCoordinator {
  private readonly prepareTasks = new Map<string, Promise<PreparedDuoLaunch>>();
  private readonly recoveryCleanupTasks = new Map<
    string,
    Promise<DuoLaunchStatus>
  >();
  private readonly cancellationRequests = new Set<string>();
  private readonly comparisonTasks = new Map<
    string,
    Promise<DuoLaunchStatus>
  >();
  /** Launch ids needing another comparison pass, and whether it is an explicit retry. */
  private readonly comparisonRechecks = new Map<string, boolean>();
  private readonly worktrees: DuoWorktreeOperations;
  private readonly workspaceRuns: DuoSourceControlOperations | null;
  private readonly comparisonCheckoutAcquireTimeoutMs: number;
  private readonly runtimeClosed: () => boolean;

  constructor(
    private readonly store: RuntimeStore,
    private readonly providers: Pick<ProviderManager, "resolveModelRoute">,
    private readonly backendProfiles: BackendProfileController,
    private readonly turns: TurnController,
    private readonly dataDirectory: string,
    private readonly providerInfo: () => readonly ProviderInfo[],
    options: {
      worktrees?: DuoWorktreeOperations;
      workspaceRuns?: DuoSourceControlOperations;
      comparisonCheckoutAcquireTimeoutMs?: number;
      runtimeClosed?: () => boolean;
    } = {},
  ) {
    this.worktrees = options.worktrees ?? defaultDuoWorktreeOperations();
    this.workspaceRuns = options.workspaceRuns ?? null;
    this.runtimeClosed = options.runtimeClosed ?? (() => false);
    this.comparisonCheckoutAcquireTimeoutMs = Math.max(
      0,
      Math.min(
        options.comparisonCheckoutAcquireTimeoutMs
          ?? DEFAULT_COMPARISON_CHECKOUT_ACQUIRE_TIMEOUT_MS,
        DEFAULT_COMPARISON_CHECKOUT_ACQUIRE_TIMEOUT_MS,
      ),
    );
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
      this.cancelComparisonTurn(launch);
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
      this.cancelComparisonProviderTurn(this.store.pairedLaunch(launchId));
      await this.waitForLaunchProviderCleanup(launch);
      this.cancelComparisonTurn(this.store.pairedLaunch(launchId));
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
    if (failure) await this.waitForLaunchProviderCleanup(launch);
    const finished = this.store.finishPairedLaunchDispatch(
      launchId,
      started,
      failure,
    );
    if (finished.state === "running") {
      // Synchronous settlements may have observed the pre-finish state.
      return this.startComparison(launchId, false);
    }
    return publicStatus(this.store, finished);
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
    ) {
      await this.waitForLaunchProviderCleanup(latest);
      if (!await this.reconcileInactiveLaunchTurns(
        latest,
        false,
      )) {
        return publicStatus(this.store, this.store.pairedLaunch(launchId));
      }
      this.store.cancelPairedLaunchComparison(launchId);
      return publicStatus(this.store, this.store.pairedLaunch(launchId));
    }
    if (!await this.reconcileInactiveLaunchTurns(
      latest,
      false,
    )) {
      return publicStatus(this.store, this.store.pairedLaunch(launchId));
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

  async acknowledgeInterrupted(launchId: string): Promise<DuoLaunchStatus> {
    const current = this.store.pairedLaunch(launchId);
    if (current.state === "interrupted") {
      if (!await this.reconcileInactiveLaunchTurns(
        current,
        false,
      )) {
        return publicStatus(this.store, this.store.pairedLaunch(launchId));
      }
      this.cancelComparisonTurn(current);
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

  reconcileConversationDeletion(
    conversationId: string,
    authorizedCheckoutReservationId: string,
  ): Promise<boolean> {
    return reconcileDuoDeletionLaunches(
      this.store,
      this.turns,
      this.store.pairedLaunchIdsForDeletionRecovery(
        { conversationId },
        MAX_DUO_DELETION_RECOVERIES,
      ),
      [authorizedCheckoutReservationId],
    );
  }

  reconcileProjectDeletion(
    projectId: string,
    authorizedCheckoutReservationIds: readonly string[] = [],
  ): Promise<boolean> {
    return reconcileDuoDeletionLaunches(
      this.store,
      this.turns,
      this.store.pairedLaunchIdsForDeletionRecovery(
        { projectId },
        MAX_DUO_DELETION_RECOVERIES,
      ),
      authorizedCheckoutReservationIds,
    );
  }

  async onTurnSettled(turn: AgentTurn): Promise<void> {
    if (!isAgentTurnTerminalStatus(turn.status)) return;
    const owner = this.store.pairedLaunchForTurn(turn.id);
    if (!owner) return;
    if (owner.role === "comparison") {
      await this.turns.waitForProviderCleanup([turn.conversationId]);
      this.store.settlePairedLaunchComparisonTurn(
        owner.launchId,
        turn.id,
        turn.status,
      );
      return;
    }
    await this.startComparison(owner.launchId, false);
  }

  async resumeComparisons(): Promise<void> {
    for (const launchId of this.store.pairedLaunchComparisonIds()) {
      if (this.runtimeClosed()) return;
      const launch = this.store.pairedLaunch(launchId);
      const comparison = launch.comparison;
      if (!comparison) continue;
      if (launch.cancelRequested || launch.state === "cancelled") {
        this.cancelComparisonTurn(launch);
        continue;
      }
      if (
        comparison.state === "dispatching"
        || comparison.state === "running"
      ) {
        if (!comparison.turnId) {
          this.store.failPairedLaunchComparison(
            launchId,
            "interrupted",
            "The judge dispatch was interrupted before its durable turn identity was recorded. It was not retried automatically.",
          );
          continue;
        }
        try {
          const turn = this.store.agentTurn(comparison.turnId);
          if (
            turn.status === "completed"
            || turn.status === "failed"
            || turn.status === "cancelled"
            || turn.status === "interrupted"
          ) {
            this.store.settlePairedLaunchComparisonTurn(
              launchId,
              turn.id,
              turn.status,
            );
          } else {
            this.store.failPairedLaunchComparison(
              launchId,
              "interrupted",
              "The judge dispatch remained nonterminal after runtime recovery. It was not retried automatically.",
            );
          }
        } catch {
          this.store.failPairedLaunchComparison(
            launchId,
            "interrupted",
            "The judge dispatch could not be reconciled and was not retried automatically.",
          );
        }
        continue;
      }
      if (comparison.state === "waiting") {
        await this.startComparison(launchId, false);
      }
    }
  }

  retryComparison(launchId: string): Promise<DuoLaunchStatus> {
    return this.startComparison(launchId, true);
  }

  async cancelComparison(launchId: string): Promise<DuoLaunchStatus> {
    const launch = this.store.pairedLaunch(launchId);
    if (!await this.reconcileInactiveLaunchTurns(
      launch,
      true,
    )) {
      return publicStatus(this.store, this.store.pairedLaunch(launchId));
    }
    this.cancelComparisonTurn(launch);
    return publicStatus(this.store, this.store.pairedLaunch(launchId));
  }

  private cancelComparisonProviderTurn(
    launch: ReturnType<RuntimeStore["pairedLaunch"]>,
  ): boolean {
    const comparison = launch.comparison;
    if (
      comparison?.conversationId
      && (comparison.state === "dispatching" || comparison.state === "running")
    ) return this.turns.cancel(comparison.conversationId);
    return false;
  }

  private waitForLaunchProviderCleanup(
    launch: ReturnType<RuntimeStore["pairedLaunch"]>,
    comparisonOnly = false,
  ): Promise<void> {
    const conversationIds = [
      ...(comparisonOnly ? [] : launch.sides.map(({ conversationId }) => conversationId)),
      launch.comparison?.conversationId ?? null,
    ].filter((id): id is string => id !== null);
    if (conversationIds.length === 0) return Promise.resolve();
    return this.turns.waitForProviderCleanup(conversationIds);
  }

  private async reconcileInactiveLaunchTurns(
    launch: ReturnType<RuntimeStore["pairedLaunch"]>,
    comparisonOnly = false,
    providerRunOwnershipConfirmedTurnIds: ReadonlySet<string> = new Set(),
    allowProviderStop = true,
  ): Promise<boolean> {
    return reconcileInactiveDuoLaunchTurns(
      this.store,
      this.turns,
      launch,
      {
        comparisonOnly,
        providerRunOwnershipConfirmedTurnIds,
        allowProviderStop,
      },
    );
  }

  private cancelComparisonTurn(
    launch: ReturnType<RuntimeStore["pairedLaunch"]>,
  ): void {
    const comparison = launch.comparison;
    if (!comparison) return;
    this.store.cancelPairedLaunchComparison(launch.launchId);
    this.cancelComparisonProviderTurn(launch);
  }

  private startComparison(
    launchId: string,
    retry: boolean,
  ): Promise<DuoLaunchStatus> {
    const current = this.comparisonTasks.get(launchId);
    if (current) {
      // The current pass may have read state before this settlement landed.
      this.comparisonRechecks.set(
        launchId,
        (this.comparisonRechecks.get(launchId) ?? false) || retry,
      );
      return current;
    }
    const task = (async () => {
      try {
        let status = await this.startComparisonFresh(launchId, retry);
        // The durable claim makes every pass idempotent.
        while (this.comparisonRechecks.has(launchId)) {
          const recheckRetry = this.comparisonRechecks.get(launchId) ?? false;
          this.comparisonRechecks.delete(launchId);
          status = await this.startComparisonFresh(launchId, recheckRetry);
        }
        return status;
      } finally {
        // Avoid the extra cleanup microtask introduced by a chained finally.
        this.comparisonTasks.delete(launchId);
        this.comparisonRechecks.delete(launchId);
      }
    })();
    this.comparisonTasks.set(launchId, task);
    return task;
  }

  private async startComparisonFresh(
    launchId: string,
    retry: boolean,
  ): Promise<DuoLaunchStatus> {
    let launch = this.store.pairedLaunch(launchId);
    if (this.runtimeClosed() || this.turns.isClosing()) {
      return publicStatus(this.store, launch);
    }
    const comparison = launch.comparison;
    if (!comparison?.conversationId) return publicStatus(this.store, launch);
    if (
      launch.state !== "running"
      || launch.sides.some(({ dispatchState }) => dispatchState !== "started")
    ) {
      return publicStatus(this.store, launch);
    }
    const sourceTurnIds = launch.sides.map(({ turnId }) => turnId);
    if (!sourceTurnIds[0] || !sourceTurnIds[1]) {
      return publicStatus(this.store, launch);
    }
    const sourceTurns = [
      this.store.agentTurn(sourceTurnIds[0]),
      this.store.agentTurn(sourceTurnIds[1]),
    ];
    if (sourceTurns.some((turn) => !isAgentTurnTerminalStatus(turn.status))) {
      return publicStatus(this.store, launch);
    }

    let prompt: string;
    try {
      prompt = buildDuoComparisonPrompt(this.store, launch);
    } catch {
      return publicStatus(this.store, this.store.failPairedLaunchComparison(
        launchId,
        "failed",
        "The bounded judge input could not be assembled. Retry explicitly or cancel the comparison.",
      ));
    }
    const sourceConversationIds = launch.sides
      .map(({ conversationId }) => conversationId)
      .filter((id): id is string => id !== null);
    await this.turns.waitForProviderCleanup(sourceConversationIds);
    // Shutdown settlements stay waiting so startup can recover them.
    if (this.runtimeClosed() || this.turns.isClosing())
      return publicStatus(this.store, this.store.pairedLaunch(launchId));

    let turnId: string | null = null;
    let startAccepted = false;
    let transitionReserved = false;
    const checkoutPath = this.store.conversationPath(
      comparison.conversationId,
    );
    const reservation = await this.reserveComparisonCheckout(
      comparison.conversationId,
    );
    if (reservation === "closing") {
      return publicStatus(this.store, this.store.pairedLaunch(launchId));
    }
    transitionReserved = reservation === "reserved";
    let comparisonClaimed = false;
    try {
      if (!this.store.claimPairedLaunchComparison(launchId, retry)) {
        return publicStatus(this.store, this.store.pairedLaunch(launchId));
      }
      comparisonClaimed = true;
      if (reservation !== "reserved") {
        throw new Error(
          "The judge checkout is already owned by another provider or workspace operation.",
        );
      }
      if (this.turns.hasActiveCheckout(checkoutPath)) {
        throw new Error(
          "Another agent is already working in the judge checkout.",
        );
      }
      const queued = this.turns.queue({
        conversationId: comparison.conversationId,
        authorizedDuoComparisonLaunchId: launchId,
        content: prompt,
        attachments: [],
        activateConversation: false,
        skills: [],
      });
      turnId = queued.turn.id;
      this.store.attachPairedLaunchComparisonTurn(launchId, turnId);
      startAccepted = this.turns.start(turnId);
      if (!startAccepted) {
        this.turns.failBeforeStart(
          comparison.conversationId,
          "The locked Duo judge turn could not start.",
        );
        return publicStatus(this.store, this.store.failPairedLaunchComparison(
          launchId,
          "failed",
          "The locked Duo judge turn could not start. Retry explicitly or cancel the comparison.",
        ));
      }
      launch = this.store.markPairedLaunchComparisonRunning(
        launchId,
        turnId,
      );
      return publicStatus(this.store, launch);
    } catch (error) {
      if (!comparisonClaimed) throw error;
      this.turns.cancel(comparison.conversationId);
      return publicStatus(this.store, this.store.failPairedLaunchComparison(
        launchId,
        startAccepted ? "interrupted" : "failed",
        `${startAccepted
          ? "The judge start outcome became uncertain"
          : "The judge could not be queued"} and was not retried automatically.`,
      ));
    } finally {
      if (transitionReserved) {
        this.store.conversationWork.release(comparison.conversationId);
      }
    }
  }

  private async reserveComparisonCheckout(
    conversationId: string,
  ): Promise<"reserved" | "busy" | "closing"> {
    const deadlineAt = Date.now()
      + this.comparisonCheckoutAcquireTimeoutMs;
    while (true) {
      if (this.runtimeClosed() || this.turns.isClosing()) return "closing";
      try {
        if (this.store.conversationWork.reserve(conversationId)) {
          return "reserved";
        }
      } catch {
        return "busy";
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return "busy";
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          Math.min(COMPARISON_CHECKOUT_ACQUIRE_POLL_MS, remainingMs),
        );
        timer.unref();
      });
    }
  }

  private async prepareFresh(
    payload: DuoPreparePayload,
  ): Promise<PreparedDuoLaunch> {
    // Preflights can own Git or provider resources, so a sibling failure must
    // not return to callers until every concurrent preflight has settled.
    let firstFailure: PromiseRejectedResult | null = null;
    const observeFailure = async <T>(preflight: Promise<T>): Promise<T> => {
      try {
        return await preflight;
      } catch (reason) {
        firstFailure ??= { status: "rejected", reason };
        throw reason;
      }
    };
    const [firstSide, secondSide, comparisonResult] = await Promise.allSettled([
      observeFailure(this.preflightSide(payload.sides[0], 0)),
      observeFailure(this.preflightSide(payload.sides[1], 1)),
      observeFailure(payload.comparison
        ? this.preflightComparison(payload.comparison)
        : Promise.resolve(null)),
    ] as const);
    const rejected = [firstSide, secondSide, comparisonResult].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw (firstFailure ?? rejected).reason;
    if (
      firstSide.status !== "fulfilled"
      || secondSide.status !== "fulfilled"
      || comparisonResult.status !== "fulfilled"
    ) {
      throw new Error("Duo preflight settlement was incomplete.");
    }
    const sides: [PreflightSide, PreflightSide] = [
      firstSide.value,
      secondSide.value,
    ];
    const comparison = comparisonResult.value;
    const prepareReserved = async (): Promise<PreparedDuoLaunch> => {
      const now = new Date().toISOString();
      this.store.createPairedLaunch(payload.launchId, [
        this.sidePlan(sides[0]),
        this.sidePlan(sides[1]),
      ], now, comparison
        ? { plannedConversationId: comparison.conversationId }
        : null);

      let conversationsAdopted = false;
      try {
      this.assertNotCancelled(payload.launchId);
      for (const side of sides) {
        if (!side.ownsWorktree || !side.worktreePath || !side.branch) continue;
        if (!side.worktreeSource) {
          throw new Error(
            "The Duo source repository identity is unavailable.",
          );
        }
        mkdirSync(resolve(side.worktreePath, ".."), {
          recursive: true,
          mode: 0o700,
        });
        const plannedWorktreePath = side.worktreePath;
        const plannedBranch = side.branch;
        const verifiedRoot = await verifyWorktreeSourceIdentity(
          side.repositoryPath,
          side.worktreeSource,
        );
        const status = await this.worktrees.create(
          verifiedRoot,
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
        await verifyWorktreeSourceIdentity(
          side.repositoryPath,
          side.worktreeSource,
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

      const conversations = this.store.createDuoConversations(
        payload.launchId,
        [
          this.conversationPlan(sides[0]),
          this.conversationPlan(sides[1]),
        ],
        comparison
          ? this.comparisonConversationPlan(comparison)
          : null,
      );
      conversationsAdopted = true;
      this.assertNotCancelled(payload.launchId);
      const queued = this.turns.queuePair(payload.launchId, [
        {
          conversationId: conversations.sides[0].id,
          content: payload.prompt,
          attachments: [],
          activateConversation: false,
          skills: [],
        },
        {
          conversationId: conversations.sides[1].id,
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
            conversationId: conversations.sides[0].id,
            turnId: queued[0].turn.id,
          },
          {
            ordinal: 1,
            conversationId: conversations.sides[1].id,
            turnId: queued[1].turn.id,
          },
        ],
        ...(conversations.comparison
          ? {
              comparison: {
                conversationId: conversations.comparison.id,
              },
            }
          : {}),
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
          if (comparison) {
            this.store.cancelPairedLaunchComparison(payload.launchId);
          }
        }
        throw error;
      }
    };
    return await withWorktreeSourceReservations(
      this.workspaceRuns,
      payload.launchId,
      sides.flatMap((side) => side.ownsWorktree && side.worktreeSource
        ? [{
            identity: side.worktreeSource,
            ordinal: side.ordinal,
            projectId: side.payload.projectId,
            workspacePath: side.repositoryPath,
          }]
        : []),
      prepareReserved,
    );
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

  private async preflightComparison(
    payload: DuoComparisonPayload,
  ): Promise<PreflightComparison> {
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
        readiness.message ?? "The selected judge backend is unavailable.",
      );
    }
    if (!readiness && !provider?.canRun) {
      throw new Error(
        provider?.statusMessage
          ?? "The judge route is not ready. Open Settings to finish setup.",
      );
    }
    this.store.projectPath(payload.projectId);
    return {
      payload,
      conversationId: randomUUID(),
      selection,
    };
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
      const reusable = this.store.shellSnapshot().conversations.find(
        (conversation) => conversation.projectId === payload.projectId
          && conversation.worktreePath !== null
          && normalizeIdentityPath(resolve(conversation.worktreePath))
            === normalizeIdentityPath(requestedPath),
      );
      const reusablePath = reusable
        ? this.store.conversationPath(reusable.id)
        : null;
      if (
        reusablePath === null
        || normalizeIdentityPath(reusablePath)
          !== normalizeIdentityPath(requestedPath)
        || normalizeIdentityPath(requestedPath)
          === normalizeIdentityPath(resolve(repositoryPath))
      ) {
        throw new Error(
          "That worktree is not attached to a chat in this project.",
        );
      }
      const status = await getRepositoryStatus(reusablePath);
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
        worktreeSource: null,
      };
    }

    const worktreeSource = payload.useWorktree
      ? await pinWorktreeSourceIdentity(repositoryPath)
      : null;
    let status: Awaited<ReturnType<typeof getRepositoryStatus>> | null = null;
    try {
      status = await getRepositoryStatus(
        worktreeSource?.root ?? repositoryPath,
      );
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
      await this.worktrees.preflightFilesystem(worktreeSource!.root);
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
      worktreeSource,
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

  private comparisonConversationPlan(
    comparison: PreflightComparison,
  ): Parameters<RuntimeStore["createDuoConversations"]>[2] {
    const providerId = legacyProviderIdForHarness(
      comparison.selection.harnessId,
    );
    if (!providerId) {
      throw new Error("That judge harness is unavailable in this build.");
    }
    return {
      projectId: comparison.payload.projectId,
      title: comparison.payload.title,
      options: {
        id: comparison.conversationId,
        providerId,
        modelSelection: comparison.selection,
        interactionMode: comparison.payload.interactionMode,
        accessMode: comparison.payload.accessMode,
        branch: null,
        worktreePath: null,
        activate: false,
      },
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
      ...(launch.comparison?.conversationId
        ? {
            comparison: {
              conversationId: launch.comparison.conversationId,
            },
          }
        : {}),
    };
  }
}

/**
 * Reconciles durable launch state before providers or clients are admitted.
 * Requested cancellations are finalized after turn recovery has detached the
 * providers. Dispatch claims are never replayed. Only worktrees that this
 * launch created and never attached to a conversation are compensated.
 */
export async function reconcileInterruptedDuoLaunches(
  store: RuntimeStore,
  options: { worktrees?: DuoWorktreeOperations } = {},
): Promise<void> {
  const worktrees = options.worktrees ?? defaultDuoWorktreeOperations();
  store.recoverRequestedPairedLaunchCancellations();
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
