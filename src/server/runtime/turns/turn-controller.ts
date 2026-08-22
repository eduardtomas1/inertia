import { randomUUID } from "node:crypto";

import {
  isAgentTurnTerminalStatus,
  type AgentApprovalDecision,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentPlan,
  type AgentRunState,
  type AgentTurn,
  type AgentTurnTerminalStatus,
  type ChatAttachment,
  type ChatMessage,
  type SubagentTrace,
} from "../../../shared/contracts";
import { RuntimeStore } from "../../database";
import type {
  ProviderEvent,
  ProviderRunFailure,
  ProviderRunResult,
  ProviderSteerInput,
} from "../../provider/contracts";
import type {
  ActiveTurn,
  FollowUpAdmissionLease,
  ProviderStartAttempt,
  QueuedTurn,
  QueueTurnRequest,
  TurnControllerHooks,
  TurnProviderRuntime,
  TurnTerminalCause,
  TurnTimerScheduler,
} from "./turn-controller-types";
import {
  defaultTurnScheduler,
  broadcastTurnConversationShell,
  DEFAULT_TURN_MAX_LIFETIME_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  normalizedProviderRunFailure,
  providerLabel,
  providerPromiseFailure,
  publicTurnError,
  updateActiveTurnProviderSession,
} from "./turn-controller-support";
import {
  prepareTurnRequest,
  resolveTurnRequest,
  type PreparedTurnRequest,
} from "./turn-request-preparation";
import { TurnStreamProjection } from "./turn-stream-projection";
import { TurnActivityProjection } from "./turn-activity-projection";
import { TurnInteractionCoordinator } from "./turn-interaction-coordinator";
import { TurnSettlementCoordinator } from "./turn-settlement-coordinator";
import { TurnProviderEventProjector } from "./turn-provider-event-projector";
import { TurnArtifactSequencer } from "./turn-artifact-sequencer";
import { confirmDuoProviderCleanup } from "../duo/duo-provider-cleanup";
import { quarantineActiveDuoTurn } from "../duo/duo-active-turn-quarantine";
import { hasActiveTurnCheckout, providerConversationIds } from "./turn-checkout-activity";
import { settleInactiveDuoTurn } from "../duo/duo-inactive-turn-settlement";
import { TurnNativeGoalCoordinator } from "./turn-native-goal-coordinator";
import { TurnNativeGoalMutationGate } from "./turn-native-goal-mutation-gate";
import { providerFailureCause } from "./turn-provider-result";
import { TurnFollowUpCoordinator } from "./turn-follow-up-coordinator";
import { TurnTimeoutCoordinator } from "./turn-timeout-coordinator";
import { TurnRunStateCoordinator } from "./turn-run-state-coordinator";

export type {
  QueuedTurn,
  QueueTurnRequest,
  TurnControllerHooks,
  TurnGitArtifactHookInput,
  TurnMetadataRefreshHookInput,
  TurnProviderRuntime,
  TurnStructuredContextCapture,
  TurnStructuredContextRecord,
  TurnTerminalCause,
  TurnTimerScheduler,
} from "./turn-controller-types";

/**
 * Server-authoritative owner for every live agent-turn lifecycle. Provider
 * transports only emit normalized events; conversation and workspace rows are
 * projections written after the durable turn transition.
 */
export class TurnController {
  private readonly activeByConversation = new Map<string, ActiveTurn>();
  private readonly activeByTurn = new Map<string, ActiveTurn>();
  private readonly scheduler: TurnTimerScheduler;
  private readonly clock: () => Date;
  private readonly id: () => string;
  private readonly runtimeGenerationId: string;
  private readonly systemBootId: string;
  private readonly streams: TurnStreamProjection;
  private readonly activities: TurnActivityProjection;
  private readonly artifacts: TurnArtifactSequencer;
  private readonly interactions: TurnInteractionCoordinator;
  private readonly settlement: TurnSettlementCoordinator;
  private readonly runStates: TurnRunStateCoordinator;
  private readonly providerEvents: TurnProviderEventProjector;
  private readonly nativeGoals: TurnNativeGoalCoordinator;
  private readonly settlementTasks = new Set<Promise<unknown>>();
  private readonly gitArtifactBarriers = new Map<string, Promise<void>>();
  private readonly providerRunOwnershipBarriers = new Map<string, Promise<void>>();
  private readonly followUps: TurnFollowUpCoordinator;
  private readonly timeouts: TurnTimeoutCoordinator;
  private readonly nativeGoalMutations = new TurnNativeGoalMutationGate();
  private closing = false;

  constructor(
    private readonly store: RuntimeStore,
    private readonly providers: TurnProviderRuntime,
    private readonly pendingApprovals: Map<string, AgentApprovalRequest>,
    private readonly pendingInputs: Map<string, AgentInputRequest>,
    private readonly agentPlans: Map<string, AgentPlan>,
    private readonly hooks: TurnControllerHooks,
    options: {
      scheduler?: TurnTimerScheduler;
      clock?: () => Date;
      id?: () => string;
      turnTimeoutMs?: number;
      turnMaxLifetimeMs?: number;
      runtimeGenerationId?: string;
      systemBootId?: string;
    } = {},
  ) {
    this.scheduler = options.scheduler ?? defaultTurnScheduler();
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    const turnTimeoutMs = Math.max(1, options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    const turnMaxLifetimeMs = Math.max(
      turnTimeoutMs,
      options.turnMaxLifetimeMs ?? DEFAULT_TURN_MAX_LIFETIME_MS,
    );
    this.runtimeGenerationId = options.runtimeGenerationId ?? `${randomUUID()}:1`;
    this.systemBootId = options.systemBootId ?? `test:${randomUUID()}`;
    this.followUps = new TurnFollowUpCoordinator({
      store: this.store,
      providers: this.providers,
      now: () => this.now(),
      activeForConversation: (conversationId) =>
        this.activeByConversation.get(conversationId),
    });
    this.timeouts = new TurnTimeoutCoordinator({
      scheduler: this.scheduler,
      inactivityMs: turnTimeoutMs,
      maxLifetimeMs: turnMaxLifetimeMs,
      status: (active) => this.store.agentTurn(active.turn.id).status,
      cancel: (active) => { this.providers.cancel(active.conversation.id); },
      fail: (active, message) => {
        this.settle(active, "failed", "turn-timeout", message);
      },
    });
    this.activities = new TurnActivityProjection({
      store: this.store,
      hooks: this.hooks,
      now: () => this.now(),
    });
    this.artifacts = new TurnArtifactSequencer({
      hooks: this.hooks,
      barriers: this.gitArtifactBarriers,
      track: (value) => this.track(value),
    });
    this.streams = new TurnStreamProjection({
      store: this.store,
      hooks: this.hooks,
      scheduler: this.scheduler,
      now: () => this.now(),
      onPersistenceFailure: (active, error) => {
        this.providers.cancel(active.conversation.id);
        this.settle(
          active,
          "failed",
          "stream-persistence-failed",
          publicTurnError(error),
        );
      },
    });
    this.settlement = new TurnSettlementCoordinator({
      store: this.store,
      hooks: this.hooks,
      scheduler: this.scheduler,
      activities: this.activities,
      artifacts: this.artifacts,
      streams: this.streams,
      now: () => this.now(),
      cleanup: (active) => this.cleanup(active),
      track: (value) => this.track(value),
    });
    this.runStates = new TurnRunStateCoordinator({
      store: this.store,
      providers: this.providers,
      hooks: this.hooks,
      scheduler: this.scheduler,
      pendingApprovals: this.pendingApprovals,
      pendingInputs: this.pendingInputs,
      settlement: this.settlement,
      providerRunOwnershipBarriers: this.providerRunOwnershipBarriers,
      now: () => this.now(),
      activity: (active) => this.timeouts.activity(active),
      release: (active) => this.releaseTurnAttachmentsWithRetry(active),
      track: (value) => this.track(value),
    });
    this.interactions = new TurnInteractionCoordinator({
      store: this.store,
      providers: this.providers,
      pendingApprovals: this.pendingApprovals,
      pendingInputs: this.pendingInputs,
      hooks: this.hooks,
      streams: this.streams,
      now: () => this.now(),
      transition: (active, status) => this.transition(active, status),
      settle: (active, status, cause, message) => this.settle(
        active,
        status,
        cause,
        message,
      ),
    });
    this.providerEvents = new TurnProviderEventProjector({
      store: this.store,
      hooks: this.hooks,
      agentPlans: this.agentPlans,
      streams: this.streams,
      activities: this.activities,
      interactions: this.interactions,
      now: () => this.now(),
      transition: (active, status, providerState) => this.transition(
        active,
        status,
        providerState,
      ),
      observeSubagent: (active, event) => this.observeSubagent(active, event),
    });
    this.nativeGoals = new TurnNativeGoalCoordinator({
      store: this.store,
      providers: this.providers,
      hooks: this.hooks,
      activeForConversation: (conversationId) =>
        this.activeByConversation.get(conversationId),
      activeForTurn: (turnId) => this.activeByTurn.get(turnId),
      queue: (request) => this.queue(request),
      start: (turnId) => this.start(turnId),
    });
  }

  isActive(conversationId: string): boolean {
    return this.activeByConversation.has(conversationId)
      || this.providers.isRunning(conversationId)
      || this.store.providerRunOwnership.forConversation(conversationId)
        .length > 0;
  }

  async withNativeGoalMutation<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    return await this.nativeGoalMutations.run(conversationId, operation);
  }

  async setNativeGoal(
    input: Parameters<TurnNativeGoalCoordinator["set"]>[0],
  ): ReturnType<TurnNativeGoalCoordinator["set"]> {
    return this.nativeGoals.set(input);
  }

  async clearNativeGoal(conversationId: string): Promise<boolean | "superseded" | null> {
    return await this.nativeGoals.clear(conversationId);
  }

  isClosing(): boolean {
    return this.closing;
  }

  hasActiveCheckout(checkoutPath: string): boolean {
    const tracked = [
      ...this.activeByConversation.keys(), ...this.providerRunOwnershipBarriers.keys(),
      ...this.store.providerRunOwnership.all().map(({ conversationId }) =>
        conversationId),
    ];
    return hasActiveTurnCheckout(this.store, this.providers, tracked, checkoutPath);
  }

  /**
   * Wait for exact conversations whose provider processes are still detaching.
   * Yield once before inspecting the barriers because a terminal hook runs
   * during settlement, immediately before that settlement registers its own
   * cleanup barrier.
   */
  async waitForProviderCleanup(
    conversationIds: readonly string[],
  ): Promise<void> {
    const expected = new Set(conversationIds);
    await Promise.resolve();
    while (true) {
      const barriers = [...this.providerRunOwnershipBarriers.entries()]
        .filter(([conversationId]) => expected.has(conversationId))
        .map(([, barrier]) => barrier);
      if (barriers.length === 0) return;
      await Promise.allSettled(barriers);
    }
  }

  async reconcileInactiveDuoTurn(
    launchId: string,
    conversationId: string,
    turnId: string,
    options: {
      providerRunOwnershipConfirmed?: boolean;
      allowProviderStop?: boolean;
      authorizedCheckoutReservationIds?: readonly string[];
    } = {},
  ): Promise<boolean> {
    const providerRunOwnershipConfirmed = options.providerRunOwnershipConfirmed ?? false;
    const allowProviderStop = options.allowProviderStop ?? true;
    let turn: AgentTurn;
    try {
      const owner = this.store.pairedLaunchForTurn(turnId);
      turn = this.store.agentTurn(turnId);
      if (
        owner?.launchId !== launchId
        || turn.conversationId !== conversationId
      ) return false;
      const request = this.store.message(turn.userMessageId);
      // Duo source and judge turns are deliberately attachment-free. Refuse
      // future or malformed launch-owned turns that would require a lost
      // ActiveTurn's private attachment-release state.
      if (request.turnId !== turnId || request.attachments.length > 0) {
        return false;
      }
    } catch {
      return false;
    }
    const exactActive = this.activeByConversation.get(conversationId);
    if (
      exactActive
      && (
        exactActive.turn.id !== turnId
        || exactActive.turn.runId !== turn.runId
      )
    ) return false;
    const ownedRuns = this.store.providerRunOwnership.forConversation(conversationId);
    if (
      ownedRuns.length > 0
      && !(
        ownedRuns.length === 1
        && exactActive
        && ownedRuns[0]?.turnId === turnId
        && ownedRuns[0]?.runId === turn.runId
        && ownedRuns[0]?.runtimeGenerationId === this.runtimeGenerationId
      )
    ) return false;
    if (
      allowProviderStop
      && this.providers.isRunning(conversationId)
    ) {
      if (!this.providers.ownsRun?.(conversationId, {
        runId: turn.runId,
        turnId,
      })) return false;
      this.store.providerRunOwnership.record(
        turn.id,
        turn.conversationId,
        turn.runId,
        this.runtimeGenerationId,
        this.systemBootId,
        this.now(),
      );
    }
    if (exactActive && !exactActive.providerRunStarted) {
      this.settle(exactActive, "cancelled", "user-cancelled", "Stopped");
    }
    if (exactActive?.providerRunStarted) {
      if (this.transition(exactActive, "cancelling", "duo-quarantine")) {
        broadcastTurnConversationShell(this.hooks, exactActive);
      }
      quarantineActiveDuoTurn(exactActive, {
        scheduler: this.scheduler,
        pendingApprovals: this.pendingApprovals,
        pendingInputs: this.pendingInputs,
        hooks: this.hooks,
      });
    }
    if (this.providerRunOwnershipBarriers.has(conversationId) && !exactActive) {
      await this.waitForProviderCleanup([conversationId]);
    }
    const cleanup = await confirmDuoProviderCleanup(
      this.providers,
      conversationId,
      { runId: turn.runId, turnId },
      {
        cleanupAlreadyConfirmed: providerRunOwnershipConfirmed,
        allowStop: allowProviderStop,
      },
    );
    if (cleanup !== "confirmed") return false;
    if (exactActive && !exactActive.runState.isTerminal()) {
      this.settle(exactActive, "cancelled", "user-cancelled", "Stopped");
    }
    if (exactActive) await this.releaseTurnAttachmentsWithRetry(exactActive);
    this.store.providerRunOwnership.clear(turn.id, turn.runId);
    await this.waitForProviderCleanup([conversationId]);

    return settleInactiveDuoTurn(this.store, {
      launchId,
      conversationId,
      turnId,
      providerRunOwnershipConfirmed,
      authorizedCheckoutReservationIds:
        options.authorizedCheckoutReservationIds ?? [],
      hasEphemeralOwner: () =>
        this.hasEphemeralTurnOwner(conversationId, turnId),
      now: () => this.now(),
      pendingApprovals: this.pendingApprovals,
      pendingInputs: this.pendingInputs,
      hooks: this.hooks,
    });
  }

  private hasEphemeralTurnOwner(
    conversationId: string,
    turnId: string,
  ): boolean {
    return this.activeByConversation.has(conversationId)
      || this.activeByTurn.has(turnId)
      || this.providerRunOwnershipBarriers.has(conversationId)
      || this.providers.isRunning(conversationId)
      || this.store.providerRunOwnership.forConversation(conversationId)
        .length > 0;
  }

  activeConversationIds(): string[] {
    return [...new Set([
      ...this.activeByConversation.keys(), ...providerConversationIds(this.store, this.providers),
      ...this.store.providerRunOwnership.all().map(({ conversationId }) =>
        conversationId),
    ])];
  }

  /**
   * Recovery must not open its isolated write transaction until downstream
   * terminal work has stopped using the authoritative store. The admission
   * fence prevents new turns while this drains the already tracked snapshot.
   */
  async drainSettlementTasks(signal?: AbortSignal): Promise<void> {
    while (this.settlementTasks.size > 0) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("The database recovery import was cancelled.");
      }
      const pending = Promise.allSettled(this.settlementTasks)
        .then(() => undefined);
      if (!signal) {
        await pending;
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          reject(signal.reason instanceof Error
            ? signal.reason
            : new Error("The database recovery import was cancelled."));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void pending.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
        if (signal.aborted) onAbort();
      });
    }
  }

  /**
   * A fresh renderer cannot replay transient projection events. Persist the
   * bounded live suffix and drain its projected delta before hydration so the
   * new renderer receives each character exactly once through its snapshot.
   */
  flushActiveStreamsForHydration(): void {
    for (const active of this.activeByConversation.values()) {
      if (active.runState.isTerminal()) continue;
      try {
        // A pending high surrogate is an incomplete provider delta, not text
        // that can be projected. Keep that single code unit across renderer
        // hydration so the next delta can complete its astral character.
        active.assistantStream.flush();
        active.reasoningStream.flush();
      } catch (error) {
        this.providers.cancel(active.conversation.id);
        this.settle(
          active,
          "failed",
          "stream-persistence-failed",
          publicTurnError(error),
        );
      }
    }
  }

  /** Synchronous ownership handoff runs after commit and before live adoption. */
  queue(request: QueueTurnRequest, onPersisted?: () => void): QueuedTurn {
    if (this.closing) throw new Error("The local runtime is shutting down.");
    if (
      !request.goalStart
      && this.nativeGoalMutations.blocksTurnAdmission(request.conversationId)
    ) {
      throw new Error("A Codex goal update is in progress for this conversation.");
    }
    this.store.assertDuoComparisonTurnAllowed(
      request.conversationId,
      request.authorizedDuoComparisonLaunchId,
    );
    if (this.isActive(request.conversationId)) {
      throw new Error("This conversation already has an active turn.");
    }

    const prepared = prepareTurnRequest({
      store: this.store,
      providers: this.providers,
      hooks: this.hooks,
      id: this.id,
      now: () => this.now(),
      clock: this.clock,
    }, request, onPersisted);
    return this.adoptPreparedTurn(prepared);
  }

  queuePair(
    launchId: string,
    requests: readonly [QueueTurnRequest, QueueTurnRequest],
  ): [QueuedTurn, QueuedTurn] {
    if (this.closing) throw new Error("The local runtime is shutting down.");
    for (const request of requests) {
      this.store.assertDuoComparisonTurnAllowed(request.conversationId);
      if (this.nativeGoalMutations.blocksTurnAdmission(request.conversationId)) {
        throw new Error("A Codex goal update is in progress for this conversation.");
      }
      if (this.isActive(request.conversationId)) {
        throw new Error("A Duo conversation already has an active turn.");
      }
    }
    if (requests[0].conversationId === requests[1].conversationId) {
      throw new Error("A Duo requires two distinct conversations.");
    }
    const dependencies = {
      store: this.store,
      providers: this.providers,
      hooks: this.hooks,
      id: this.id,
      now: () => this.now(),
      clock: this.clock,
    };
    const resolved = requests.map((request) =>
      resolveTurnRequest(dependencies, request)) as [
        ReturnType<typeof resolveTurnRequest>,
        ReturnType<typeof resolveTurnRequest>,
      ];
    const durable = this.store.beginPairedAgentTurns(
      launchId,
      [resolved[0].input, resolved[1].input],
      this.now(),
    );
    const prepared: [PreparedTurnRequest, PreparedTurnRequest] = [
      resolved[0].adopt(durable[0]),
      resolved[1].adopt(durable[1]),
    ];
    return [
      this.adoptPreparedTurn(prepared[0]),
      this.adoptPreparedTurn(prepared[1]),
    ];
  }

  private adoptPreparedTurn(prepared: PreparedTurnRequest): QueuedTurn {
    const { queued } = prepared;
    let active: ActiveTurn;
    const assistantStream = this.streams.create(
      () => active,
      "assistant",
    );
    const reasoningStream = this.streams.create(
      () => active,
      "reasoning",
    );
    active = {
      ...prepared.active,
      assistantStream,
      reasoningStream,
    };
    this.activeByConversation.set(active.conversation.id, active);
    this.activeByTurn.set(queued.turn.id, active);
    this.agentPlans.delete(active.conversation.id);

    try {
      if (active.checkpointId) {
        this.store.associateCheckpointWithTurn(
          active.checkpointId,
          active.conversation.id,
          active.turn.runId,
          active.turn.id,
        );
      }
    } catch (error) {
      this.settle(active, "failed", "checkpoint-association-failed", publicTurnError(error));
      throw error;
    }

    if (active.structuredContext !== undefined) {
      this.track(this.hooks.onStructuredContextCaptured?.({
        turn: queued.turn,
        context: active.structuredContext,
      }));
    }
    return queued;
  }

  async startPair(turnIds: readonly [string, string]): Promise<[boolean, boolean]> {
    const active = turnIds.map((turnId) => this.activeByTurn.get(turnId)) as [
      ActiveTurn | undefined,
      ActiveTurn | undefined,
    ];
    if (
      this.closing
      || !active[0]
      || !active[1]
      || active[0].runState.isTerminal()
      || active[1].runState.isTerminal()
    ) return [false, false];
    const firstActive = active[0];
    const secondActive = active[1];

    this.beginStart(firstActive);
    this.beginStart(secondActive);
    const ready = await Promise.all([
      this.awaitProviderStartReady(firstActive),
      this.awaitProviderStartReady(secondActive),
    ]);
    if (!ready[0] || !ready[1]) {
      for (const sibling of [firstActive, secondActive]) {
        if (!sibling.runState.isTerminal()) {
          this.settle(
            sibling,
            "cancelled",
            "turn-start-failed",
            "The paired provider did not become ready to start.",
          );
        }
      }
      return [false, false];
    }

    const first = this.startProvider(firstActive);
    if (!first.accepted) {
      if (!secondActive.runState.isTerminal()) {
        this.settle(
          secondActive,
          "failed",
          "turn-start-failed",
          "The paired provider did not start.",
        );
      }
      return [false, false];
    }
    const second = this.startProvider(secondActive);
    if (!second.accepted) {
      if (!firstActive.runState.isTerminal()) {
        this.providers.cancel(firstActive.conversation.id);
        this.settle(
          firstActive,
          "cancelled",
          "turn-start-failed",
          "The paired provider did not start.",
        );
      }
    }
    const started = await Promise.all([first.started, second.started]);
    if (!started.every(Boolean)) {
      [firstActive, secondActive].forEach((sibling, ordinal) => {
        if (sibling.runState.isTerminal()) return;
        if (started[ordinal]) this.providers.cancel(sibling.conversation.id);
        this.settle(
          sibling,
          "cancelled",
          "turn-start-failed",
          "The paired provider start was not acknowledged on both sides.",
        );
      });
    }
    return started;
  }

  start(turnId: string): boolean {
    const active = this.activeByTurn.get(turnId);
    if (!active || active.runState.isTerminal() || this.closing) return false;
    this.beginStart(active);

    const priorProviderCleanup = this.providerRunOwnershipBarriers.get(
      active.conversation.id,
    );
    if (priorProviderCleanup) {
      this.track(priorProviderCleanup
        .catch(() => undefined)
        .then(() => {
          this.captureBeforeAndStartProvider(active);
        }));
      return true;
    }
    return this.captureBeforeAndStartProvider(active);
  }

  private beginStart(active: ActiveTurn): void {
    this.transition(active, "starting");
    this.store.createWorkspaceRun({
      id: active.turn.runId,
      kind: "agent",
      projectId: active.conversation.projectId,
      conversationId: active.conversation.id,
      label: active.conversation.model
        ? `${providerLabel(active.turn.providerId)} · ${active.conversation.model}`
        : providerLabel(active.turn.providerId),
      detail: active.conversation.title,
      status: "running",
      port: null,
    });
    active.workspaceRunCreated = true;
    this.interactions.projectConversation(active, "running");
    this.hooks.broadcast({
      type: "agent.started",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
    });
    broadcastTurnConversationShell(this.hooks, active);
    this.timeouts.start(active);
  }

  private async awaitProviderStartReady(active: ActiveTurn): Promise<boolean> {
    const priorProviderCleanup = this.providerRunOwnershipBarriers.get(
      active.conversation.id,
    );
    if (priorProviderCleanup) await priorProviderCleanup.catch(() => undefined);
    if (active.runState.isTerminal() || this.closing) return false;
    const preCapture = this.artifacts.captureBefore(active);
    if (preCapture) {
      active.gitBeforeCapture = preCapture;
      await preCapture;
    }
    return !active.runState.isTerminal() && !this.closing;
  }

  private captureBeforeAndStartProvider(active: ActiveTurn): boolean {
    if (active.runState.isTerminal() || this.closing) return false;
    const preCapture = this.artifacts.captureBefore(active);
    if (preCapture) {
      active.gitBeforeCapture = preCapture;
      this.track(active.gitBeforeCapture
        .then(() => {
          this.startProvider(active);
        }));
      return true;
    }
    return this.startProvider(active).accepted;
  }

  private startProvider(active: ActiveTurn): ProviderStartAttempt {
    if (active.runState.isTerminal() || this.closing) {
      return { accepted: false, started: Promise.resolve(false) };
    }
    let startSettled = false;
    let resolveStarted!: (started: boolean) => void;
    const started = new Promise<boolean>((resolve) => {
      resolveStarted = resolve;
    });
    const acknowledge = (value: boolean): void => {
      if (startSettled) return;
      startSettled = true;
      if (active.providerStartAcknowledgement === acknowledge) {
        active.providerStartAcknowledgement = null;
      }
      resolveStarted(value);
    };
    active.providerStartAcknowledgement = acknowledge;
    try {
      // Persist exact process ownership before run()/harness.start() can create
      // a child or synchronously invoke a callback. Abrupt worker exits therefore
      // leave a generation-bound deletion/recovery fence behind.
      this.store.providerRunOwnership.record(
        active.turn.id,
        active.conversation.id,
        active.turn.runId,
        this.runtimeGenerationId,
        this.systemBootId,
        this.now(),
      );
      active.providerRunStarted = true;
      const result = this.providers.run(active.providerInput, {
        hostTools: this.hooks.hostToolsForTurn?.({
          conversation: active.conversation,
          turn: active.turn,
        }),
        onStarted: () => {
          if (active.runState.isTerminal() || this.closing) {
            this.providers.cancel(active.conversation.id);
            acknowledge(false);
            return;
          }
          this.timeouts.activity(active);
          acknowledge(true);
          // App Server harness acceptance happens before initialize/thread open
          // and, for ordinary turns, before turn/start is acknowledged. Keep
          // Codex truthfully `starting` until its protocol emits `running`.
          if (
            active.turn.harnessId !== "codex-app-server"
            && active.turn.harnessId !== "claude-agent-sdk"
            && this.store.agentTurn(active.turn.id).status === "starting"
          ) {
            if (this.transition(active, "running")) {
              broadcastTurnConversationShell(this.hooks, active);
            }
          }
        },
        onEvent: (event) => { this.handleProviderEvent(event); },
      });
      void result.then(
        (providerResult) => {
          acknowledge(false);
          this.handleProviderResult(active, providerResult);
        },
        (error: unknown) => {
          acknowledge(false);
          const failure = providerPromiseFailure(active, error);
          this.settle(
            active,
            "failed",
            "provider-process-crash",
            failure.message,
            failure,
          );
        },
      ).finally(() => {
        const cleanupConfirmed = !this.providers.isRunning(
          active.conversation.id,
        );
        if (cleanupConfirmed) {
          this.store.providerRunOwnership.clear(
            active.turn.id,
            active.turn.runId,
          );
        }
        // Cancellation owns an exact stop barrier which releases attachments
        // only after the provider process has detached. The provider promise
        // may settle before stopOwned(), so it must not race that barrier.
        if (
          cleanupConfirmed
          && !this.providerRunOwnershipBarriers.has(active.conversation.id)
        ) {
          this.track(this.releaseTurnAttachmentsWithRetry(active));
        }
      })
        .catch(() => undefined);
    } catch (error) {
      acknowledge(false);
      if (this.providers.isRunning(active.conversation.id)) {
        this.providers.cancel(active.conversation.id);
      } else {
        this.store.providerRunOwnership.clear(active.turn.id, active.turn.runId);
        active.providerRunStarted = false;
      }
      this.settle(active, "failed", "turn-start-failed", publicTurnError(error));
      return { accepted: false, started };
    }
    return { accepted: true, started };
  }

  cancel(conversationId: string, cause: TurnTerminalCause = "user-cancelled"): boolean {
    const active = this.activeByConversation.get(conversationId);
    if (!active || active.runState.isTerminal()) return false;
    this.providers.cancel(conversationId);
    return this.settle(active, "cancelled", cause, "Stopped");
  }

  failBeforeStart(conversationId: string, message: string): boolean {
    const active = this.activeByConversation.get(conversationId);
    if (!active || active.runState.isTerminal()) return false;
    this.providers.cancel(conversationId);
    return this.settle(active, "failed", "turn-start-failed", message);
  }

  acquireFollowUpAdmission(conversationId: string): FollowUpAdmissionLease | null {
    return this.followUps.acquire(this.activeByConversation.get(conversationId));
  }
  async steer(
    lease: FollowUpAdmissionLease,
    input: ProviderSteerInput,
    attachments: readonly ChatAttachment[] = [],
    onProviderAcknowledged?: () => void,
    signal?: AbortSignal,
  ): Promise<ChatMessage | null> {
    return this.followUps.steer(
      lease,
      input,
      attachments,
      onProviderAcknowledged,
      signal,
    );
  }

  async stopSubagent(
    conversationId: string,
    traceId: string,
  ): Promise<boolean> {
    const active = this.activeByConversation.get(conversationId);
    if (
      !active
      || !active.runState.acceptsProviderEvents()
      || !this.providers.stopSubagent
    ) return false;
    let trace: SubagentTrace;
    try {
      trace = this.store.subagentTrace(traceId);
    } catch {
      return false;
    }
    if (
      trace.conversationId !== conversationId
      || trace.runId !== active.turn.runId
      || trace.turnId !== active.turn.id
      || trace.providerId !== "claude"
      || !trace.providerTaskId
      || !trace.isLive
    ) return false;
    let accepted = false;
    try {
      accepted = await this.providers.stopSubagent(
        conversationId,
        trace.providerTaskId,
        { runId: active.turn.runId, turnId: active.turn.id },
      );
    } catch {
      // The provider event stream may still have proved the exact stop.
    }
    let currentTrace: SubagentTrace;
    try {
      currentTrace = this.store.subagentTrace(traceId);
    } catch {
      return false;
    }
    if (
      currentTrace.conversationId !== trace.conversationId
      || currentTrace.runId !== trace.runId
      || currentTrace.turnId !== trace.turnId
      || currentTrace.providerId !== trace.providerId
      || currentTrace.providerTaskId !== trace.providerTaskId
    ) return false;
    if (!currentTrace.isLive) return currentTrace.status === "cancelled";
    if (!accepted) return false;
    const currentActive = this.activeByConversation.get(conversationId);
    if (
      currentActive !== active
      || !currentActive.runState.acceptsProviderEvents()
      || currentActive.turn.runId !== trace.runId
      || currentActive.turn.id !== trace.turnId
    ) return false;
    const stopped = this.store.acknowledgeSubagentStop(traceId, this.now());
    if (!stopped) return false;
    if (stopped?.changed) {
      this.hooks.broadcast({
        type: "agent.subagent.updated",
        trace: stopped.trace,
      });
    }
    return true;
  }

  respondToApproval(
    conversationId: string,
    requestId: string,
    decision: AgentApprovalDecision,
  ): boolean {
    const active = this.activeByConversation.get(conversationId);
    return this.interactions.respondToApproval(
      active,
      conversationId,
      requestId,
      decision,
    );
  }

  respondToInput(
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): boolean {
    const active = this.activeByConversation.get(conversationId);
    return this.interactions.respondToInput(
      active,
      conversationId,
      requestId,
      answers,
    );
  }

  rendererDisconnected(ownerId: string): number {
    let settled = 0;
    for (const active of this.activeByConversation.values()) {
      if (active.rendererOwnerId !== ownerId) continue;
      this.providers.cancel(active.conversation.id);
      if (this.settle(
        active,
        "cancelled",
        "renderer-disconnected",
        "The renderer that owned this isolated turn disconnected.",
      )) settled += 1;
    }
    return settled;
  }

  unsupportedInteraction(conversationId: string, message: string): boolean {
    const active = this.activeByConversation.get(conversationId);
    if (!active || active.runState.isTerminal()) return false;
    this.providers.cancel(conversationId);
    return this.settle(active, "failed", "unsupported-interaction", message);
  }

  /** Runtime shutdown and owned process-crash paths use the same settlement. */
  async dispose(cause: "runtime-shutdown" | "runtime-crash" = "runtime-shutdown"): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const active of this.activeByConversation.values()) {
      this.providers.cancel(active.conversation.id);
      this.settle(
        active,
        "interrupted",
        cause,
        cause === "runtime-shutdown"
          ? "The local runtime shut down before this turn completed."
          : "The local runtime crashed before this turn completed.",
      );
    }
    try {
      await this.providers.disposeAll();
    } finally {
      await this.drainSettlementTasks();
    }
  }

  /**
   * Public for focused transport and stale-callback tests. Production provider
   * events enter through the callback installed by start().
   */
  handleProviderEvent(event: ProviderEvent): boolean {
    const active = this.activeByConversation.get(event.conversationId);
    if (!active || !this.accepts(active, event)) return false;
    try {
      this.timeouts.activity(active);
      const currentRunState = active.runState.snapshot().state;
      if (
        (currentRunState === "retrying" || currentRunState === "delegated")
        && (
          event.type === "text"
          || event.type === "text-snapshot"
          || event.type === "reasoning-summary"
          || (event.type === "activity" && event.phase === "started")
          || event.type === "plan"
        )
      ) {
        this.transition(active, "running");
      }
      if (event.type === "text") {
        this.hooks.testOnlyStreamingTrace?.mark("provider-delta-received");
      }
      this.providerEvents.project(active, event);
      this.nativeGoals.handleEvent(active, event);
      return true;
    } catch (error) {
      this.providers.cancel(active.conversation.id);
      this.settle(active, "failed", "stream-persistence-failed", publicTurnError(error));
      return false;
    }
  }

  private accepts(
    active: ActiveTurn,
    event: Pick<ProviderEvent, "providerId" | "conversationId" | "runId" | "turnId">,
  ): boolean {
    if (
      !active.runState.acceptsProviderEvents()
      || event.providerId !== active.turn.providerId
      || event.conversationId !== active.conversation.id
      || event.runId !== active.turn.runId
      || event.turnId !== active.turn.id
    ) return false;
    try {
      const authoritative = this.store.assertAgentTurnIdentity(
        active.conversation.id,
        active.turn.runId,
        active.turn.id,
      );
      return !isAgentTurnTerminalStatus(authoritative.status);
    } catch {
      return false;
    }
  }

  private handleProviderResult(active: ActiveTurn, result: ProviderRunResult): void {
    if (active.runState.isTerminal()) return;
    if (result.cleanupConfirmed) {
      // A result carrying cleanup confirmation is the provider manager's
      // exact-process exit receipt. It is stronger than a potentially stale
      // lookup projection and permits immediate root settlement.
      active.providerRunStarted = false;
      this.store.providerRunOwnership.clear(active.turn.id, active.turn.runId);
    }
    if (result.status === "completed") {
      this.hooks.testOnlyStreamingTrace?.mark("provider-completion-received");
    }
    const outcomeAlreadyRequested = active.deferredSettlement !== null;
    if (!outcomeAlreadyRequested && result.sessionId) {
      updateActiveTurnProviderSession(active, result.sessionId);
      this.store.updateConversation(active.conversation.id, {
        providerSessionId: result.sessionId,
        continuationIdentity: active.turn.continuationIdentity,
      });
    }
    if (!outcomeAlreadyRequested) this.streams.reconcileAssistant(active, result);
    if (result.status === "completed") {
      this.settle(active, "completed", "provider-completed");
    } else if (result.status === "cancelled") {
      this.settle(active, "cancelled", "user-cancelled", "Stopped");
    } else {
      const failure = normalizedProviderRunFailure(active, result);
      this.settle(active, "failed", providerFailureCause(result), failure.message, failure);
    }
  }

  private transition(
    active: ActiveTurn,
    state: Exclude<AgentRunState, AgentTurnTerminalStatus>,
    providerState?: string | null,
  ): boolean {
    return this.runStates.transition(active, state, providerState);
  }

  private observeSubagent(
    active: ActiveTurn,
    event: Extract<ProviderEvent, { type: "subagent" }>,
  ): boolean {
    return this.runStates.observeSubagent(active, event);
  }

  private settle(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    cause: TurnTerminalCause,
    message?: string,
    failure?: ProviderRunFailure,
  ): boolean {
    return this.runStates.settle(active, status, cause, message, failure);
  }

  private async releaseTurnAttachments(active: ActiveTurn): Promise<void> {
    await this.followUps.drain(active);
    if (
      active.attachmentsReleased
      || (
        active.attachmentIds.length === 0
        && active.generatedAttachmentPaths.length === 0
      )
    ) return;
    if (active.attachmentRelease) return await active.attachmentRelease;
    const release = Promise.all([
      active.attachmentIds.length > 0
        ? Promise.resolve(this.hooks.releaseTurnAttachments?.({
            turn: active.turn,
            attachmentIds: active.attachmentIds,
          }))
        : Promise.resolve(),
      active.generatedAttachmentPaths.length > 0
        ? Promise.resolve(
            this.hooks.releaseGeneratedAttachments?.(
              active.generatedAttachmentPaths,
            ) ?? Promise.reject(
              new Error("Generated attachment cleanup is unavailable."),
            ),
          )
        : Promise.resolve(),
    ]).then(() => {
      active.attachmentsReleased = true;
    });
    active.attachmentRelease = release;
    try {
      await release;
    } finally {
      if (active.attachmentRelease === release) {
        active.attachmentRelease = null;
      }
    }
  }

  private async releaseTurnAttachmentsWithRetry(active: ActiveTurn): Promise<void> {
    try {
      await this.releaseTurnAttachments(active);
    } catch {
      // Release hooks are required to be idempotent. One whole-set retry
      // closes partial multi-path failures without releasing before provider
      // detachment or silently dropping the failed lease.
      await this.releaseTurnAttachments(active);
    }
  }

  private cleanup(active: ActiveTurn): void {
    this.nativeGoals.cleanup(active);
    active.assistantStream.dispose();
    active.reasoningStream.dispose();
    for (const requestId of active.approvalIds) this.pendingApprovals.delete(requestId);
    for (const requestId of active.inputIds) this.pendingInputs.delete(requestId);
    active.approvalIds.clear();
    active.inputIds.clear();
    this.activeByConversation.delete(active.conversation.id);
    this.activeByTurn.delete(active.turn.id);
  }

  private track(value: void | Promise<void> | undefined): void {
    if (!value) return;
    const task = Promise.resolve(value)
      .catch(() => undefined)
      .finally(() => {
        this.settlementTasks.delete(task);
        this.hooks.broadcastSnapshot();
      });
    this.settlementTasks.add(task);
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
