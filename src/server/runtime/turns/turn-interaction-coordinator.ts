import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurnStatus,
  Conversation,
} from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { ProviderEvent } from "../../provider/contracts";
import type { TurnStreamProjection } from "./turn-stream-projection";
import {
  deletePendingInteraction,
  pendingInteractionForOwner,
  registerPendingInteraction,
  type PendingInteractionOwner,
} from "../pending-interaction-registry";
import type {
  ActiveTurn,
  ReadOnlyWatcherViolationKind,
  TurnControllerHooks,
  TurnProviderRuntime,
  TurnTerminalCause,
} from "./turn-controller-types";
import { requestProviderCancellation } from "./turn-provider-cancellation";
import { broadcastTurnSnapshot } from "./turn-controller-support";
import {
  READ_ONLY_WATCHER_MAX_DENIALS,
  READ_ONLY_WATCHER_STOP_MESSAGE,
  readOnlyApprovalViolationKind,
  readOnlyViolationDetail,
} from "./turn-read-only-watcher";

function interactionOwner(active: ActiveTurn): PendingInteractionOwner {
  return {
    providerId: active.turn.providerId,
    conversationId: active.conversation.id,
    runId: active.turn.runId,
    turnId: active.turn.id,
  };
}

export interface TurnInteractionCoordinatorOptions {
  store: RuntimeStore;
  providers: TurnProviderRuntime;
  pendingApprovals: Map<string, AgentApprovalRequest>;
  pendingInputs: Map<string, AgentInputRequest>;
  hooks: TurnControllerHooks;
  streams: TurnStreamProjection;
  now(): string;
  transition(
    active: ActiveTurn,
    status: Exclude<AgentTurnStatus, "completed" | "failed" | "cancelled" | "interrupted">,
  ): boolean;
  settle(
    active: ActiveTurn,
    status: "failed" | "cancelled",
    cause: TurnTerminalCause,
    message: string,
  ): boolean;
}

/**
 * Owns provider approval/question projections while retaining the shared maps
 * used by snapshots and reconnect hydration.
 */
export class TurnInteractionCoordinator {
  private readonly acceptedResponses = new WeakMap<ActiveTurn, {
    approvals: Set<string>;
    inputs: Set<string>;
  }>();
  /** Watcher approvals answered with a denial; never in the shared pending maps. */
  private readonly deniedReadOnlyApprovals = new WeakMap<ActiveTurn, Set<string>>();

  constructor(private readonly options: TurnInteractionCoordinatorOptions) {}

  private responses(active: ActiveTurn): {
    approvals: Set<string>;
    inputs: Set<string>;
  } {
    const current = this.acceptedResponses.get(active);
    if (current) return current;
    const created = { approvals: new Set<string>(), inputs: new Set<string>() };
    this.acceptedResponses.set(active, created);
    return created;
  }

  private broadcastConversationShell(active: ActiveTurn): void {
    if (this.options.hooks.broadcastConversationShell) {
      this.options.hooks.broadcastConversationShell(active.conversation.id);
      return;
    }
    broadcastTurnSnapshot(this.options.hooks);
  }

  respondToApproval(
    active: ActiveTurn | undefined,
    conversationId: string,
    requestId: string,
    decision: AgentApprovalDecision,
  ): boolean {
    const pending = active
      ? pendingInteractionForOwner(
          this.options.pendingApprovals,
          interactionOwner(active),
          requestId,
        )
      : undefined;
    if (
      !pending
      || !active
      || !active.runState.acceptsProviderEvents()
      || pending.conversationId !== conversationId
      || pending.runId !== active.turn.runId
      || pending.turnId !== active.turn.id
      || !pending.availableDecisions.includes(decision)
    ) return false;
    const accepted = this.responses(active).approvals;
    if (accepted.has(requestId)) return false;
    accepted.add(requestId);
    const responded = this.options.providers.respondToApproval(
      conversationId,
      requestId,
      decision,
      { runId: active.turn.runId, turnId: active.turn.id },
    );
    if (!responded) {
      accepted.delete(requestId);
      this.options.settle(
        active,
        "failed",
        "unsupported-interaction",
        "The selected provider cannot answer this approval request.",
      );
    } else if (decision === "cancel") {
      accepted.delete(requestId);
      requestProviderCancellation(this.options.providers, conversationId);
      this.options.settle(
        active,
        "cancelled",
        "approval-cancelled",
        "The approval was cancelled.",
      );
    }
    return responded;
  }

  respondToInput(
    active: ActiveTurn | undefined,
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): boolean {
    const pending = active
      ? pendingInteractionForOwner(
          this.options.pendingInputs,
          interactionOwner(active),
          requestId,
        )
      : undefined;
    if (
      !pending
      || !active
      || !active.runState.acceptsProviderEvents()
      || pending.conversationId !== conversationId
      || pending.runId !== active.turn.runId
      || pending.turnId !== active.turn.id
    ) return false;
    const accepted = this.responses(active).inputs;
    if (accepted.has(requestId)) return false;
    accepted.add(requestId);
    const responded = this.options.providers.respondToInput(
      conversationId,
      requestId,
      answers,
      { runId: active.turn.runId, turnId: active.turn.id },
    );
    if (!responded) {
      accepted.delete(requestId);
      this.options.settle(
        active,
        "failed",
        "unsupported-interaction",
        "The selected provider cannot answer this input request.",
      );
    }
    return responded;
  }

  openApproval(
    active: ActiveTurn,
    request: Extract<ProviderEvent, { type: "approval" }>["request"],
  ): void {
    this.options.streams.closeAssistantSegment(active);
    this.options.streams.flush(active, "reasoning");
    const pending: AgentApprovalRequest = {
      id: request.requestId,
      providerId: active.turn.providerId,
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      kind: request.kind,
      title: request.title,
      detail: request.detail ?? null,
      command: request.command ?? null,
      cwd: request.cwd ?? null,
      reason: request.reason ?? null,
      networkScope: request.networkScope ?? null,
      permissionRoots: request.permissionRoots,
      availableDecisions: request.availableDecisions,
    };
    if (!registerPendingInteraction(this.options.pendingApprovals, pending)) {
      throw new Error(
        "The provider reused an outstanding approval request identity.",
      );
    }
    active.approvalIds.add(pending.id);
    this.options.transition(active, "waiting-for-approval");
    this.projectWaiting(active, "approval", pending.title);
    this.options.hooks.broadcast({
      type: "agent.approval.requested",
      request: pending,
    });
    this.broadcastConversationShell(active);
  }

  /**
   * Answers a watcher's approval request with a denial and no approval card.
   * The request is tracked privately so its resolution matches, while the
   * shared pending map and the chat's attention state stay untouched. A second
   * request in one turn, or one that cannot be denied, stops the turn.
   */
  denyForReadOnly(
    active: ActiveTurn,
    request: Extract<ProviderEvent, { type: "approval" }>["request"],
  ): void {
    const watcher = active.readOnlyWatcher;
    if (!watcher) throw new Error("Only watcher turns decline approvals automatically.");
    this.options.streams.closeAssistantSegment(active);
    this.options.streams.flush(active, "reasoning");
    const denied = this.deniedReadOnlyApprovals.get(active) ?? new Set<string>();
    this.deniedReadOnlyApprovals.set(active, denied);
    if (denied.has(request.requestId)) {
      throw new Error("The provider reused an outstanding approval request identity.");
    }
    denied.add(request.requestId);
    const detail = readOnlyViolationDetail(request.title);
    const kind = readOnlyApprovalViolationKind(request);
    const responded = request.availableDecisions.includes("deny")
      && this.options.providers.respondToApproval(
        active.conversation.id,
        request.requestId,
        "deny",
        { runId: active.turn.runId, turnId: active.turn.id },
      );
    watcher.deniedApprovals += 1;
    const activity = this.options.store.addActivity({
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      kind: "status",
      title: `Needed permission: ${detail} — declined (watchers are read-only)`,
      detail: null,
      status: "completed",
    });
    this.options.hooks.broadcast({ type: "agent.activity", activity });
    if (!responded || watcher.deniedApprovals >= READ_ONLY_WATCHER_MAX_DENIALS) {
      this.stopForReadOnly(active, responded ? "approval-limit" : kind, detail);
      return;
    }
    this.reportReadOnlyViolation(active, kind, detail, false);
  }

  /** Stops a watcher turn that tried something a read-only check never does. */
  stopForReadOnly(active: ActiveTurn, kind: ReadOnlyWatcherViolationKind, detail: string): void {
    if (!active.readOnlyWatcher || !active.runState.acceptsProviderEvents()) return;
    requestProviderCancellation(this.options.providers, active.conversation.id);
    this.reportReadOnlyViolation(active, kind, readOnlyViolationDetail(detail), true);
    this.options.settle(active, "failed", "unsupported-interaction", READ_ONLY_WATCHER_STOP_MESSAGE);
  }

  private reportReadOnlyViolation(
    active: ActiveTurn,
    kind: ReadOnlyWatcherViolationKind,
    detail: string,
    stopped: boolean,
  ): void {
    const watcher = active.readOnlyWatcher;
    if (!watcher) return;
    try {
      this.options.hooks.onReadOnlyViolation?.(active.turn, {
        linkId: watcher.linkId,
        wakeId: watcher.wakeId,
        kind,
        detail,
        stopped,
      });
    } catch {
      // The watcher owner's bookkeeping never changes how the turn stops.
    }
  }

  resolveApproval(
    active: ActiveTurn,
    requestId: string,
    decision: AgentApprovalDecision | "cancelled",
  ): void {
    if (this.deniedReadOnlyApprovals.get(active)?.delete(requestId)) return;
    this.responses(active).approvals.delete(requestId);
    const owner = interactionOwner(active);
    const pending = pendingInteractionForOwner(
      this.options.pendingApprovals,
      owner,
      requestId,
    );
    if (
      !pending
      || pending.turnId !== active.turn.id
      || pending.runId !== active.turn.runId
    ) return;
    deletePendingInteraction(this.options.pendingApprovals, owner, requestId);
    active.approvalIds.delete(requestId);
    this.options.hooks.broadcast({
      type: "agent.approval.resolved",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      requestId,
      decision,
    });
    if (decision === "cancel" || decision === "cancelled") {
      requestProviderCancellation(this.options.providers, active.conversation.id);
      this.options.settle(
        active,
        "cancelled",
        "approval-cancelled",
        "The approval was cancelled.",
      );
      return;
    }
    this.refreshWaitingState(active);
  }

  openInput(
    active: ActiveTurn,
    request: Extract<ProviderEvent, { type: "input" }>["request"],
  ): void {
    this.options.streams.closeAssistantSegment(active);
    this.options.streams.flush(active, "reasoning");
    const pending: AgentInputRequest = {
      id: request.requestId,
      providerId: active.turn.providerId,
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      questions: request.questions,
      autoResolutionMs: request.autoResolutionMs,
    };
    if (!registerPendingInteraction(this.options.pendingInputs, pending)) {
      throw new Error(
        "The provider reused an outstanding input request identity.",
      );
    }
    active.inputIds.add(pending.id);
    this.options.transition(active, "waiting-for-input");
    this.projectWaiting(
      active,
      "input",
      pending.questions[0]?.question ?? "Waiting for an answer",
    );
    this.options.hooks.broadcast({
      type: "agent.input.requested",
      request: pending,
    });
    this.broadcastConversationShell(active);
  }

  resolveInput(active: ActiveTurn, requestId: string): void {
    this.responses(active).inputs.delete(requestId);
    const owner = interactionOwner(active);
    const pending = pendingInteractionForOwner(
      this.options.pendingInputs,
      owner,
      requestId,
    );
    if (
      !pending
      || pending.turnId !== active.turn.id
      || pending.runId !== active.turn.runId
    ) return;
    deletePendingInteraction(this.options.pendingInputs, owner, requestId);
    active.inputIds.delete(requestId);
    this.options.hooks.broadcast({
      type: "agent.input.resolved",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      requestId,
    });
    this.refreshWaitingState(active);
  }

  projectConversation(
    active: ActiveTurn,
    status: Conversation["status"],
  ): void {
    this.options.store.updateConversation(active.conversation.id, {
      status,
      attentionKind: null,
    });
    if (
      active.workspaceRunCreated
      && (status === "running" || status === "idle")
    ) {
      this.options.store.updateWorkspaceRun(active.turn.runId, {
        status: status === "running" ? "running" : "cancelled",
        detail: active.conversation.title,
      });
    }
  }

  private refreshWaitingState(active: ActiveTurn): void {
    if (!active.runState.acceptsProviderEvents()) return;
    const owner = interactionOwner(active);
    const approval = [...active.approvalIds]
      .map((id) => pendingInteractionForOwner(
        this.options.pendingApprovals,
        owner,
        id,
      ))
      .find(Boolean);
    if (approval) {
      this.options.transition(active, "waiting-for-approval");
      this.projectWaiting(active, "approval", approval.title);
    } else {
      const input = [...active.inputIds]
        .map((id) => pendingInteractionForOwner(
          this.options.pendingInputs,
          owner,
          id,
        ))
        .find(Boolean);
      if (input) {
        this.options.transition(active, "waiting-for-input");
        this.projectWaiting(
          active,
          "input",
          input.questions[0]?.question ?? "Waiting for an answer",
        );
      } else {
        this.options.transition(active, "running");
        this.projectConversation(active, "running");
      }
    }
    this.broadcastConversationShell(active);
  }

  private projectWaiting(
    active: ActiveTurn,
    attentionKind: "approval" | "input",
    detail: string,
  ): void {
    this.options.store.updateConversation(active.conversation.id, {
      status: "needs-input",
      attentionKind,
    });
    if (active.workspaceRunCreated) {
      this.options.store.updateWorkspaceRun(active.turn.runId, {
        status: "waiting",
        detail,
      });
    }
  }
}
