import {
  agentTurnStatusForRunState,
  isAgentTurnTerminalStatus,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentRunState,
  type AgentTurnTerminalStatus,
  type SubagentTrace,
} from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { ProviderRunFailure } from "../../provider/contracts";
import { ownedProviderStopBudgetMs } from "../../provider/run-cleanup-settlement";
import type { OwnedProviderStopResult } from "../../provider/run-coordinator";
import { deletePendingInteraction } from "../pending-interaction-registry";
import {
  PROVIDER_STOP_UNCONFIRMED_NOTE,
  type TurnSettlementCoordinator,
} from "./turn-settlement-coordinator";
import {
  broadcastConversationShellFor,
  broadcastTurnConversationShell,
} from "./turn-controller-support";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnProviderRuntime,
  TurnTerminalCause,
  TurnTimerScheduler,
} from "./turn-controller-types";

interface TurnRunStateCoordinatorOptions {
  store: RuntimeStore;
  providers: TurnProviderRuntime;
  hooks: TurnControllerHooks;
  scheduler: TurnTimerScheduler;
  pendingApprovals: Map<string, AgentApprovalRequest>;
  pendingInputs: Map<string, AgentInputRequest>;
  settlement: TurnSettlementCoordinator;
  providerRunOwnershipBarriers: Map<string, Promise<void>>;
  now(): string;
  activity(active: ActiveTurn): void;
  release(active: ActiveTurn): Promise<void>;
  track(value: void | Promise<void> | undefined): void;
}

interface ProviderRunOwner {
  conversationId: string;
  runId: string;
  turnId: string;
}

const PROVIDER_STOP_LAST_RESORT_EXTRA_MS = 5_000;

/** Durable reducer/projection boundary for one exact active root run. */
export class TurnRunStateCoordinator {
  private readonly unconfirmedProviderStops = new WeakSet<ActiveTurn>();
  private readonly providerStopNotes = new WeakSet<ActiveTurn>();

  constructor(private readonly options: TurnRunStateCoordinatorOptions) {}

  providerCleanupUnconfirmed(active: ActiveTurn): boolean {
    return this.unconfirmedProviderStops.has(active);
  }

  providerCleanupConfirmedLate(identity: ProviderRunOwner): void {
    const barrier = this.options.providerRunOwnershipBarriers.get(identity.conversationId);
    if (barrier) {
      const retry = (): void => this.providerCleanupConfirmedLate(identity);
      this.options.track(barrier.then(retry, retry));
      return;
    }
    const { store } = this.options;
    const owned = store.providerRunOwnership.forConversation(identity.conversationId)
      .some((row) => row.runId === identity.runId && row.turnId === identity.turnId);
    if (!owned || !isAgentTurnTerminalStatus(store.agentTurn(identity.turnId).status)) return;
    store.providerRunOwnership.clear(identity.turnId, identity.runId);
    broadcastConversationShellFor(this.options.hooks, identity.conversationId);
  }

  transition(
    active: ActiveTurn,
    state: Exclude<AgentRunState, AgentTurnTerminalStatus>,
    providerState?: string | null,
  ): boolean {
    if (active.runState.isTerminal()) return false;
    const current = this.options.store.agentTurn(active.turn.id);
    if (isAgentTurnTerminalStatus(current.status)) return false;
    if (state === "starting" && current.status !== "queued") return false;
    let changed = false;
    if (state === "cancelling") {
      changed = active.runState.requestCancellation(null, providerState);
    } else if (state === "waiting-for-approval" || state === "waiting-for-input") {
      // A provider-authored interaction proves live execution even when its
      // transport omitted a separate running signal.
      changed = active.runState.setTransport("running", providerState);
    } else if (
      state === "queued" || state === "starting" || state === "running"
      || state === "delegated" || state === "retrying"
    ) {
      const currentState = active.runState.snapshot().state;
      const resolvingInteraction = state === "running"
        && (currentState === "waiting-for-approval"
          || currentState === "waiting-for-input");
      if (!resolvingInteraction) {
        changed = active.runState.setTransport(state, providerState);
      }
    }
    changed = active.runState.synchronizeInteractions(
      active.approvalIds.size,
      active.inputIds.size,
      providerState,
      state === "waiting-for-approval"
        ? "approval"
        : state === "waiting-for-input" ? "input" : undefined,
    ) || changed;
    if (!changed) return false;
    this.persist(active);
    this.options.activity(active);
    return true;
  }

  observeSubagent(
    active: ActiveTurn,
    trace: SubagentTrace,
  ): boolean {
    if (!active.runState.observeDescendant(
      trace.id,
      trace.isLive,
      trace.providerStatus,
    )) return false;
    this.persist(active);
    broadcastTurnConversationShell(this.options.hooks, active);
    return true;
  }

  settle(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    cause: TurnTerminalCause,
    message?: string,
    failure?: ProviderRunFailure,
  ): boolean {
    if (active.runState.isTerminal()) return false;
    active.providerStartAcknowledgement?.(false);
    const firstRequest = active.deferredSettlement === null;
    active.deferredSettlement ??= {
      status, cause,
      ...(message === undefined ? {} : { message }),
      ...(failure === undefined ? {} : { failure }),
    };
    if (active.providerRunStarted) {
      active.runState.requestTerminal(active.deferredSettlement.status);
      try {
        this.suspendForProviderStop(active);
        this.persist(active);
      } finally {
        // A failed cancellation write cannot strand the already durable run
        // owner after watchdogs stop. Exact cleanup still owns its release.
        this.stopOwnedProviderAndRelease(active);
      }
      broadcastTurnConversationShell(this.options.hooks, active);
      return firstRequest;
    }
    const settled = this.finalizeDeferredSettlement(active);
    return firstRequest && settled;
  }

  private persist(active: ActiveTurn): void {
    const runState = active.runState.snapshot();
    active.turn = this.options.store.updateAgentTurnLifecycle(active.turn.id, {
      status: agentTurnStatusForRunState(runState.state),
      runState,
      updatedAt: this.options.now(),
    });
    this.projectLive(active, runState.state);
  }

  escalateStop(active: ActiveTurn): boolean {
    if (!active.providerRunStarted || active.runState.isTerminal()) return false;
    if (!active.providerStopStarted) {
      this.stopOwnedProviderAndRelease(active);
      return true;
    }
    void this.options.providers.stopOwned(
      active.conversation.id,
      { runId: active.turn.runId, turnId: active.turn.id },
      0,
    ).catch(() => undefined);
    return true;
  }

  retryTerminalPersistence(active: ActiveTurn): boolean {
    if (!active.runState.isTerminal() || active.providerRunStarted) return false;
    const stopUnconfirmed = this.providerStopNotes.has(active);
    const settled = this.options.settlement.retryTerminalPersistence(active, stopUnconfirmed);
    if (settled && stopUnconfirmed && active.turn.status === "completed") this.noteUnconfirmedStop(active);
    return settled;
  }

  private projectLive(active: ActiveTurn, state: AgentRunState): void {
    if (
      state === "queued" || state === "waiting-for-approval"
      || state === "waiting-for-input" || state === "completed"
      || state === "failed" || state === "cancelled" || state === "interrupted"
    ) return;
    this.options.store.updateConversation(active.conversation.id, {
      status: "running",
      attentionKind: null,
    });
    if (!active.workspaceRunCreated) return;
    const detail = state === "cancelling"
      ? `Stopping · ${active.conversation.title}`
      : state === "retrying"
        ? `Retrying · ${active.conversation.title}`
        : state === "delegated"
          ? `Delegated work · ${active.conversation.title}`
          : active.conversation.title;
    this.options.store.updateWorkspaceRun(active.turn.runId, {
      status: "running",
      detail,
    });
  }

  private finalizeDeferredSettlement(
    active: ActiveTurn,
    releaseMode: "tracked" | "joined" = "tracked",
    stopUnconfirmed = false,
  ): boolean {
    const pending = active.deferredSettlement;
    if (
      !pending
      || active.runState.isTerminal()
      || active.providerRunStarted
    ) return false;
    const settled = this.options.settlement.settle(
      active,
      pending.status,
      pending.cause,
      pending.message,
      pending.failure,
      stopUnconfirmed,
    );
    if (stopUnconfirmed) this.providerStopNotes.add(active);
    if (settled && stopUnconfirmed && pending.status === "completed") this.noteUnconfirmedStop(active);
    if (settled) active.deferredSettlement = null;
    if (releaseMode === "tracked") {
      this.options.track(this.options.release(active));
    }
    return settled;
  }

  private noteUnconfirmedStop(active: ActiveTurn): void {
    try {
      const activity = this.options.store.addActivity({
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        kind: "status",
        title: PROVIDER_STOP_UNCONFIRMED_NOTE,
        detail: null,
        status: "completed",
      });
      this.options.hooks.broadcast({ type: "agent.activity", activity });
    } catch {
      return;
    }
  }

  private suspendForProviderStop(active: ActiveTurn): void {
    if (active.timeoutTimer !== null) {
      this.options.scheduler.clearTimeout(active.timeoutTimer);
      active.timeoutTimer = null;
    }
    if (active.lifetimeTimer !== null) {
      this.options.scheduler.clearTimeout(active.lifetimeTimer);
      active.lifetimeTimer = null;
    }
    const interactionOwner = {
      providerId: active.turn.providerId,
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
    };
    for (const requestId of active.approvalIds) {
      if (!deletePendingInteraction(
        this.options.pendingApprovals,
        interactionOwner,
        requestId,
      )) continue;
      this.options.hooks.broadcast({
        type: "agent.approval.resolved",
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        requestId,
        decision: "cancelled",
      });
    }
    active.approvalIds.clear();
    for (const requestId of active.inputIds) {
      if (!deletePendingInteraction(
        this.options.pendingInputs,
        interactionOwner,
        requestId,
      )) continue;
      this.options.hooks.broadcast({
        type: "agent.input.resolved",
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        requestId,
      });
    }
    active.inputIds.clear();
  }

  private stopOwnedProviderAndRelease(active: ActiveTurn): void {
    if (active.providerStopStarted) return;
    active.providerStopStarted = true;
    const conversationId = active.conversation.id;
    let expire!: () => void;
    const expired = new Promise<"expired">((resolve) => {
      expire = () => resolve("expired");
    });
    const lastResort = this.options.scheduler.setTimeout(
      expire,
      ownedProviderStopBudgetMs() + PROVIDER_STOP_LAST_RESORT_EXTRA_MS,
    );
    const task = (async () => {
      let outcome: OwnedProviderStopResult | "expired" | "failed" = "failed";
      try {
        outcome = await Promise.race([
          this.options.providers.stopOwned(conversationId, {
            runId: active.turn.runId,
            turnId: active.turn.id,
          }),
          expired,
        ]);
      } catch {
        // The durable pre-stop marker intentionally remains fail-closed.
      }
      this.options.scheduler.clearTimeout(lastResort);
      active.providerRunStarted = false;
      if (outcome === "settled") {
        this.options.store.providerRunOwnership.clear(active.turn.id, active.turn.runId);
      } else {
        this.unconfirmedProviderStops.add(active);
      }
      this.finalizeDeferredSettlement(
        active,
        "joined",
        outcome === "force-detached" || outcome === "failed" || outcome === "expired",
      );
      await this.options.release(active);
    })();
    const barrier = task.finally(() => {
      if (this.options.providerRunOwnershipBarriers.get(conversationId) === barrier) {
        this.options.providerRunOwnershipBarriers.delete(conversationId);
      }
      active.providerStopStarted = false;
    });
    this.options.providerRunOwnershipBarriers.set(conversationId, barrier);
    this.options.track(barrier);
  }
}
