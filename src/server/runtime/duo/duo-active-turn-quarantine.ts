import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurn,
} from "../../../shared/contracts";
import { deletePendingInteraction } from "../pending-interaction-registry";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnTimerScheduler,
} from "../turns/turn-controller-types";

export function quarantineActiveDuoTurn(
  active: ActiveTurn,
  dependencies: {
    scheduler: TurnTimerScheduler;
    pendingApprovals: Map<string, AgentApprovalRequest>;
    pendingInputs: Map<string, AgentInputRequest>;
    hooks: TurnControllerHooks;
  },
): void {
  active.providerStartAcknowledgement?.(false);
  if (active.timeoutTimer !== null) {
    dependencies.scheduler.clearTimeout(active.timeoutTimer);
    active.timeoutTimer = null;
  }
  if (active.lifetimeTimer !== null) {
    dependencies.scheduler.clearTimeout(active.lifetimeTimer);
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
      dependencies.pendingApprovals,
      interactionOwner,
      requestId,
    )) continue;
    dependencies.hooks.broadcast({
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
      dependencies.pendingInputs,
      interactionOwner,
      requestId,
    )) continue;
    dependencies.hooks.broadcast({
      type: "agent.input.resolved",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      requestId,
    });
  }
  active.inputIds.clear();
}

export function resolvePersistedDuoInteractions(
  turn: AgentTurn,
  dependencies: {
    pendingApprovals: Map<string, AgentApprovalRequest>;
    pendingInputs: Map<string, AgentInputRequest>;
    hooks: TurnControllerHooks;
  },
): void {
  for (const request of dependencies.pendingApprovals.values()) {
    if (
      request.providerId !== turn.providerId
      || request.conversationId !== turn.conversationId
      || request.runId !== turn.runId
      || request.turnId !== turn.id
    ) continue;
    if (!deletePendingInteraction(
      dependencies.pendingApprovals,
      request,
      request.id,
    )) continue;
    dependencies.hooks.broadcast({
      type: "agent.approval.resolved",
      conversationId: turn.conversationId,
      runId: turn.runId,
      turnId: turn.id,
      requestId: request.id,
      decision: "cancelled",
    });
  }
  for (const request of dependencies.pendingInputs.values()) {
    if (
      request.providerId !== turn.providerId
      || request.conversationId !== turn.conversationId
      || request.runId !== turn.runId
      || request.turnId !== turn.id
    ) continue;
    if (!deletePendingInteraction(
      dependencies.pendingInputs,
      request,
      request.id,
    )) continue;
    dependencies.hooks.broadcast({
      type: "agent.input.resolved",
      conversationId: turn.conversationId,
      runId: turn.runId,
      turnId: turn.id,
      requestId: request.id,
    });
  }
}
