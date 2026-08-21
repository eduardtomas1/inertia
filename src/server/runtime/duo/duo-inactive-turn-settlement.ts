import {
  isAgentTurnTerminalStatus,
  type AgentApprovalRequest,
  type AgentInputRequest,
} from "../../../shared/contracts";
import { RecordNotFoundError, type RuntimeStore } from "../../database";
import type { TurnControllerHooks } from "../turns/turn-controller-types";
import { resolvePersistedDuoInteractions } from "./duo-active-turn-quarantine";

export function settleInactiveDuoTurn(
  store: RuntimeStore,
  input: {
    launchId: string;
    conversationId: string;
    turnId: string;
    providerRunOwnershipConfirmed: boolean;
    authorizedCheckoutReservationIds: readonly string[];
    hasEphemeralOwner: () => boolean;
    now: () => string;
    pendingApprovals: Map<string, AgentApprovalRequest>;
    pendingInputs: Map<string, AgentInputRequest>;
    hooks: TurnControllerHooks;
  },
): boolean {
  try {
    const owner = store.pairedLaunchForTurn(input.turnId);
    let turn = store.agentTurn(input.turnId);
    if (
      owner?.launchId !== input.launchId
      || turn.conversationId !== input.conversationId
      || input.hasEphemeralOwner()
      || (
        store.conversationWork.hasConversation(input.conversationId)
        && !input.authorizedCheckoutReservationIds.some((reservationId) =>
          store.conversationWork.isSoleProviderReservationAtConversationCheckout(
            reservationId,
            input.conversationId,
          ))
      )
    ) return false;
    if (
      input.providerRunOwnershipConfirmed
      && !isAgentTurnTerminalStatus(turn.status)
    ) return false;
    if (store.agentTurnsForConversation(input.conversationId).some((candidate) => (
      candidate.id !== input.turnId
      && !isAgentTurnTerminalStatus(candidate.status)
    ))) return false;

    const activeRuns = store.workspaceRunsForConversation(input.conversationId)
      .filter(({ status }) => status === "running" || status === "waiting");
    if (activeRuns.some(({ id }) => id !== turn.runId)) return false;
    let exactRun = null;
    try {
      exactRun = store.workspaceRun(turn.runId);
    } catch (error) {
      if (!(error instanceof RecordNotFoundError)) throw error;
    }
    const turnRun = exactRun && (
      exactRun.status === "running" || exactRun.status === "waiting"
    ) ? exactRun : null;
    const conversation = store.conversation(input.conversationId);
    if (turnRun && (
      turnRun.kind !== "agent"
      || turnRun.conversationId !== input.conversationId
      || turnRun.projectId !== conversation.projectId
    )) return false;
    if (input.hasEphemeralOwner()) return false;

    const completedAt = input.now();
    const settlement = isAgentTurnTerminalStatus(turn.status)
      ? { settled: false, turn }
      : store.settleAgentTurn(input.turnId, {
          status: "cancelled",
          terminalAssistantMessageId: null,
          providerSessionAfter: turn.providerSessionBefore,
          terminalReason: "duo-inactive-reconciliation",
          checkpointId: null,
          usageAtCompletion: null,
          startedAt: turn.startedAt ?? completedAt,
          completedAt,
          updatedAt: completedAt,
        });
    turn = settlement.turn;
    const detail = store.conversationDetail(input.conversationId);
    if (!detail) return false;
    const completed = turn.status === "completed";
    const interruptedDetail = turn.status === "cancelled"
      ? "the Duo turn was stopped."
      : "the Duo turn did not complete.";
    for (const activity of detail.activities) {
      if (activity.turnId === input.turnId && activity.status === "running") {
        store.updateActivity(activity.id, {
          status: completed ? "completed" : "failed",
          ...(!completed
            ? {
                title: `Interrupted · ${activity.title}`,
                detail: activity.detail
                  ? `${activity.detail}\nInterrupted: ${interruptedDetail}`
                  : `Interrupted: ${interruptedDetail}`,
              }
            : {}),
        });
      }
    }
    for (const reasoning of detail.reasonings) {
      if (reasoning.turnId === input.turnId && reasoning.status === "running") {
        store.updateReasoning(reasoning.id, {
          status: completed ? "completed" : "failed",
        });
      }
    }
    store.settleLiveSubagents(
      input.turnId,
      turn.status === "cancelled" ? "cancelled" : "lost",
      completedAt,
    );
    if (turnRun) {
      store.updateWorkspaceRun(turn.runId, {
        status: turn.status === "completed"
          ? "succeeded"
          : turn.status === "cancelled" ? "cancelled" : "failed",
      });
    }
    const latest = store.latestAgentTurnForConversation(input.conversationId);
    if (latest?.id === input.turnId) {
      store.updateConversation(input.conversationId, {
        status: turn.status === "completed"
          ? "completed"
          : turn.status === "cancelled" ? "idle" : "failed",
        attentionKind: null,
      });
    }
    resolvePersistedDuoInteractions(turn, input);
    if (settlement.settled) {
      input.hooks.broadcast({
        type: "agent.completed",
        conversationId: input.conversationId,
        runId: turn.runId,
        turnId: input.turnId,
        status: "cancelled",
        terminalReason: "duo-inactive-reconciliation",
      });
    }
    input.hooks.broadcast({
      type: "conversation.detail.invalidated",
      conversationId: input.conversationId,
    });
    input.hooks.broadcastSnapshot();
    return true;
  } catch {
    return false;
  }
}
