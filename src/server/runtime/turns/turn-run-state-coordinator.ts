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
import type { TurnSettlementCoordinator } from "./turn-settlement-coordinator";
import { broadcastTurnConversationShell } from "./turn-controller-support";
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

/** Durable reducer/projection boundary for one exact active root run. */
export class TurnRunStateCoordinator {
  constructor(private readonly options: TurnRunStateCoordinatorOptions) {}

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
    const identity = trace.providerTaskId
      ?? trace.providerAgentId;
    if (!identity) return false;
    if (!active.runState.observeDescendant(
      identity,
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
    const requiresOwnedStop = active.providerRunStarted
      && this.options.providers.isRunning(active.conversation.id)
      && (this.options.providers.ownsRun?.(active.conversation.id, {
        runId: active.turn.runId,
        turnId: active.turn.id,
      }) ?? true);
    if (requiresOwnedStop) {
      active.runState.requestTerminal(active.deferredSettlement.status);
      this.suspendForProviderStop(active);
      this.persist(active);
      this.stopOwnedProviderAndRelease(active);
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

  private finalizeDeferredSettlement(active: ActiveTurn): boolean {
    const pending = active.deferredSettlement;
    if (!pending || active.runState.isTerminal()) return false;
    const settled = this.options.settlement.settle(
      active,
      pending.status,
      pending.cause,
      pending.message,
      pending.failure,
    );
    if (settled) active.deferredSettlement = null;
    if (!active.providerRunStarted
      || !this.options.providers.isRunning(active.conversation.id)) {
      this.options.track(this.options.release(active));
    }
    return settled;
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
    for (const requestId of active.approvalIds) {
      if (!this.options.pendingApprovals.delete(requestId)) continue;
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
      if (!this.options.pendingInputs.delete(requestId)) continue;
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
    const task = (async () => {
      let cleanupConfirmed = false;
      try {
        const result = await this.options.providers.stopOwned(conversationId, {
          runId: active.turn.runId,
          turnId: active.turn.id,
        });
        cleanupConfirmed = result === "settled"
          || (result === "missing"
            && !this.options.providers.isRunning(conversationId));
      } catch {
        // The durable pre-stop marker intentionally remains fail-closed.
      }
      if (cleanupConfirmed) {
        this.options.store.providerRunOwnership.clear(active.turn.id, active.turn.runId);
        this.finalizeDeferredSettlement(active);
        await this.options.release(active);
      }
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
