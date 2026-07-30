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
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnProviderRuntime,
  TurnTerminalCause,
} from "./turn-controller-types";

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
  constructor(private readonly options: TurnInteractionCoordinatorOptions) {}

  private broadcastConversationShell(active: ActiveTurn): void {
    if (this.options.hooks.broadcastConversationShell) {
      this.options.hooks.broadcastConversationShell(active.conversation.id);
      return;
    }
    this.options.hooks.broadcastSnapshot();
  }

  respondToApproval(
    active: ActiveTurn | undefined,
    conversationId: string,
    requestId: string,
    decision: AgentApprovalDecision,
  ): boolean {
    const pending = this.options.pendingApprovals.get(requestId);
    if (
      !pending
      || !active
      || active.settled
      || pending.conversationId !== conversationId
      || pending.runId !== active.turn.runId
      || pending.turnId !== active.turn.id
      || !pending.availableDecisions.includes(decision)
    ) return false;
    const responded = this.options.providers.respondToApproval(
      conversationId,
      requestId,
      decision,
      { runId: active.turn.runId, turnId: active.turn.id },
    );
    if (!responded) {
      this.options.settle(
        active,
        "failed",
        "unsupported-interaction",
        "The selected provider cannot answer this approval request.",
      );
    } else if (decision === "cancel") {
      this.options.providers.cancel(conversationId);
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
    const pending = this.options.pendingInputs.get(requestId);
    if (
      !pending
      || !active
      || active.settled
      || pending.conversationId !== conversationId
      || pending.runId !== active.turn.runId
      || pending.turnId !== active.turn.id
    ) return false;
    const responded = this.options.providers.respondToInput(
      conversationId,
      requestId,
      answers,
      { runId: active.turn.runId, turnId: active.turn.id },
    );
    if (!responded) {
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
    active.reasoningStream.flush();
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
    active.approvalIds.add(pending.id);
    this.options.pendingApprovals.set(pending.id, pending);
    this.options.transition(active, "waiting-for-approval");
    this.projectWaiting(active, "approval", pending.title);
    this.options.hooks.broadcast({
      type: "agent.approval.requested",
      request: pending,
    });
    this.broadcastConversationShell(active);
  }

  resolveApproval(
    active: ActiveTurn,
    requestId: string,
    decision: AgentApprovalDecision | "cancelled",
  ): void {
    const pending = this.options.pendingApprovals.get(requestId);
    if (
      !pending
      || pending.turnId !== active.turn.id
      || pending.runId !== active.turn.runId
    ) return;
    this.options.pendingApprovals.delete(requestId);
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
      this.options.providers.cancel(active.conversation.id);
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
    active.reasoningStream.flush();
    const pending: AgentInputRequest = {
      id: request.requestId,
      providerId: active.turn.providerId,
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      questions: request.questions,
      autoResolutionMs: request.autoResolutionMs,
    };
    active.inputIds.add(pending.id);
    this.options.pendingInputs.set(pending.id, pending);
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
    const pending = this.options.pendingInputs.get(requestId);
    if (
      !pending
      || pending.turnId !== active.turn.id
      || pending.runId !== active.turn.runId
    ) return;
    this.options.pendingInputs.delete(requestId);
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
    if (active.settled) return;
    const approval = [...active.approvalIds]
      .map((id) => this.options.pendingApprovals.get(id))
      .find(Boolean);
    if (approval) {
      this.options.transition(active, "waiting-for-approval");
      this.projectWaiting(active, "approval", approval.title);
    } else {
      const input = [...active.inputIds]
        .map((id) => this.options.pendingInputs.get(id))
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
