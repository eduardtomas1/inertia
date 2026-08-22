import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurn,
} from "../../../shared/contracts";
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
  active.runState.quarantine("duo-quarantine");
  active.providerStartAcknowledgement?.(false);
  if (active.timeoutTimer !== null) {
    dependencies.scheduler.clearTimeout(active.timeoutTimer);
    active.timeoutTimer = null;
  }
  if (active.lifetimeTimer !== null) {
    dependencies.scheduler.clearTimeout(active.lifetimeTimer);
    active.lifetimeTimer = null;
  }
  for (const requestId of active.approvalIds) {
    if (!dependencies.pendingApprovals.delete(requestId)) continue;
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
    if (!dependencies.pendingInputs.delete(requestId)) continue;
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
  for (const [requestId, request] of dependencies.pendingApprovals) {
    if (request.turnId !== turn.id) continue;
    dependencies.pendingApprovals.delete(requestId);
    dependencies.hooks.broadcast({
      type: "agent.approval.resolved",
      conversationId: turn.conversationId,
      runId: turn.runId,
      turnId: turn.id,
      requestId,
      decision: "cancelled",
    });
  }
  for (const [requestId, request] of dependencies.pendingInputs) {
    if (request.turnId !== turn.id) continue;
    dependencies.pendingInputs.delete(requestId);
    dependencies.hooks.broadcast({
      type: "agent.input.resolved",
      conversationId: turn.conversationId,
      runId: turn.runId,
      turnId: turn.id,
      requestId,
    });
  }
}
