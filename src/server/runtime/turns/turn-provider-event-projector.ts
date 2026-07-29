import type {
  AgentPlan,
  AgentTurnStatus,
  AgentTurnTerminalStatus,
} from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { ProviderEvent } from "../../provider/contracts";
import {
  agentActivityKind,
  agentActivityStatus,
} from "../../runtime-snapshots";
import type { TurnActivityProjection } from "./turn-activity-projection";
import { boundaryUsage } from "./turn-controller-support";
import type {
  ActiveTurn,
  TurnControllerHooks,
} from "./turn-controller-types";
import type { TurnInteractionCoordinator } from "./turn-interaction-coordinator";
import type { TurnStreamProjection } from "./turn-stream-projection";

export interface TurnProviderEventProjectorOptions {
  store: RuntimeStore;
  hooks: TurnControllerHooks;
  agentPlans: Map<string, AgentPlan>;
  streams: TurnStreamProjection;
  activities: TurnActivityProjection;
  interactions: TurnInteractionCoordinator;
  now(): string;
  transition(
    active: ActiveTurn,
    status: Exclude<AgentTurnStatus, AgentTurnTerminalStatus>,
  ): boolean;
}

function projectedNativeGoalMatches(
  goal: ReturnType<RuntimeStore["mergeNativeAgentGoal"]>["goal"],
  eventGoal: Extract<ProviderEvent, { type: "goal-updated" }>["goal"],
): boolean {
  return goal?.objective === eventGoal.objective
    && goal.status === eventGoal.status
    && goal.tokenBudget === eventGoal.tokenBudget
    && goal.tokensUsed === eventGoal.tokensUsed
    && goal.timeUsedSeconds === eventGoal.timeUsedSeconds
    && goal.createdAt === eventGoal.createdAt
    && goal.updatedAt === eventGoal.updatedAt;
}

/**
 * Projects an already identity-validated normalized provider event. Transport
 * acceptance and failure settlement remain controller responsibilities.
 */
export class TurnProviderEventProjector {
  constructor(private readonly options: TurnProviderEventProjectorOptions) {}

  project(active: ActiveTurn, event: ProviderEvent): void {
    switch (event.type) {
      case "text":
        this.options.streams.appendAssistant(active, event.text);
        break;
      case "reasoning-summary":
        this.options.streams.appendReasoning(active, event.text);
        break;
      case "usage": {
        const usage = this.options.store.upsertUsage({
          conversationId: active.conversation.id,
          turnId: active.turn.id,
          ...event.usage,
        });
        active.lastUsage = boundaryUsage(usage, this.options.now());
        this.options.hooks.broadcast({ type: "agent.usage", usage });
        break;
      }
      case "session":
        active.sessionAfter = event.sessionId;
        this.options.store.updateConversation(active.conversation.id, {
          providerSessionId: event.sessionId,
          continuationIdentity: active.turn.continuationIdentity,
        });
        break;
      case "activity": {
        this.options.streams.closeAssistantSegment(active);
        const activity = this.options.activities.record(
          active,
          event,
          agentActivityKind(event),
          agentActivityStatus(event),
        );
        this.options.hooks.broadcast({ type: "agent.activity", activity });
        this.options.hooks.broadcastSnapshot();
        break;
      }
      case "status":
        if (
          (event.status === "starting"
            && this.options.transition(active, "starting"))
          || (event.status === "running"
            && this.options.transition(active, "running"))
        ) {
          this.options.hooks.broadcastSnapshot();
        }
        break;
      case "approval":
        this.options.interactions.openApproval(active, event.request);
        break;
      case "approval-resolved":
        this.options.interactions.resolveApproval(
          active,
          event.requestId,
          event.decision,
        );
        break;
      case "input":
        this.options.interactions.openInput(active, event.request);
        break;
      case "input-resolved":
        this.options.interactions.resolveInput(active, event.requestId);
        break;
      case "plan": {
        if (this.options.streams.closeAssistantSegment(active)) {
          this.options.hooks.broadcastSnapshot();
        }
        const plan: AgentPlan = {
          conversationId: active.conversation.id,
          runId: active.turn.runId,
          turnId: active.turn.id,
          explanation: event.explanation,
          steps: event.steps,
        };
        this.options.agentPlans.set(active.conversation.id, plan);
        this.options.store.upsertAgentPlan(plan);
        this.options.hooks.broadcast({
          type: "agent.plan.updated",
          plan,
        });
        break;
      }
      case "goal-updated": {
        const expectedSessionId = active.sessionAfter
          ?? active.providerInput.sessionId
          ?? active.conversation.providerSessionId;
        if (
          event.providerId !== "codex"
          || active.turn.harnessId !== "codex-app-server"
          || !expectedSessionId
          || event.sessionId !== expectedSessionId
        ) break;
        const synchronizedAt = this.options.now();
        const persisted = this.options.store.mergeNativeAgentGoal({
          conversationId: active.conversation.id,
          source: "codex-native",
          providerSessionId: event.sessionId,
          ...event.goal,
          synchronizedAt,
        });
        const recovered = (
          persisted.goal?.providerSessionId === event.sessionId
          && projectedNativeGoalMatches(persisted.goal, event.goal)
        )
          ? this.options.hooks.onNativeGoalSynchronized?.({
            conversationId: active.conversation.id,
            providerSessionId: event.sessionId,
          }) ?? false
          : false;
        if ((!persisted.changed && !recovered) || !persisted.goal) break;
        this.options.hooks.broadcast({
          type: "agent.goal.updated",
          goal: persisted.goal,
        });
        break;
      }
      case "goal-cleared": {
        const expectedSessionId = active.sessionAfter
          ?? active.providerInput.sessionId
          ?? active.conversation.providerSessionId;
        if (
          event.providerId !== "codex"
          || active.turn.harnessId !== "codex-app-server"
          || !expectedSessionId
          || event.sessionId !== expectedSessionId
        ) break;
        const changed = this.options.store.clearAgentGoal(
          active.conversation.id,
          "codex-native",
          this.options.now(),
          event.sessionId,
        );
        const nativeGoalRemains = this.options.store
          .agentGoals(active.conversation.id)
          .some((goal) =>
            goal.source === "codex-native"
            && goal.providerSessionId === event.sessionId);
        const recovered = !nativeGoalRemains
          ? this.options.hooks.onNativeGoalSynchronized?.({
            conversationId: active.conversation.id,
            providerSessionId: event.sessionId,
          }) ?? false
          : false;
        if (!changed && !recovered) break;
        this.options.hooks.broadcast({
          type: "agent.goal.cleared",
          conversationId: active.conversation.id,
          source: "codex-native",
        });
        break;
      }
      case "metadata":
        try {
          this.options.hooks.applyProviderMetadata?.(event);
        } catch {
          // Metadata projection failures do not change the turn outcome.
        }
        this.options.hooks.broadcastSnapshot();
        break;
      case "subagent": {
        const persisted = this.options.store.upsertSubagentTrace({
          conversationId: active.conversation.id,
          runId: active.turn.runId,
          turnId: active.turn.id,
          providerId: active.turn.providerId,
          providerTaskId: event.providerTaskId,
          providerAgentId: event.providerAgentId,
          parentProviderAgentId: event.parentProviderAgentId,
          parentProviderToolUseId: event.parentProviderToolUseId,
          providerToolUseId: event.providerToolUseId,
          providerRole: event.providerRole,
          providerName: event.providerName,
          status: event.status,
          description: event.description,
          progress: event.progress,
          result: event.result,
          sequence: event.sequence,
          updatedAt: this.options.now(),
        });
        if (persisted?.changed) {
          this.options.hooks.broadcast({
            type: "agent.subagent.updated",
            trace: persisted.trace,
          });
        }
        break;
      }
    }
  }
}
