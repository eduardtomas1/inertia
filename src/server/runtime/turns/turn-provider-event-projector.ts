import { MAX_AGENT_PLAN_STEPS } from "../../../shared/agent-plan";
import type {
  AgentPlan,
  AgentRunState,
  AgentTurnTerminalStatus,
  SubagentTrace,
} from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type {
  ProviderEvent,
  ProviderSubagentEvent,
} from "../../provider/contracts";
import {
  agentActivityKind,
  agentActivityStatus,
} from "../../runtime-snapshots";
import type { TurnActivityProjection } from "./turn-activity-projection";
import {
  boundaryUsage,
  broadcastTurnSnapshot,
  updateActiveTurnProviderSession,
} from "./turn-controller-support";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnTimerScheduler,
} from "./turn-controller-types";
import type { TurnInteractionCoordinator } from "./turn-interaction-coordinator";
import type { TurnStreamProjection } from "./turn-stream-projection";
import { TurnSubagentTelemetry } from "./turn-subagent-telemetry";
import { isReadOnlyWriteActivity } from "./turn-read-only-watcher";

export interface TurnProviderEventProjectorOptions {
  store: RuntimeStore;
  hooks: TurnControllerHooks;
  agentPlans: Map<string, AgentPlan>;
  streams: TurnStreamProjection;
  activities: TurnActivityProjection;
  interactions: TurnInteractionCoordinator;
  scheduler: TurnTimerScheduler;
  now(): string;
  transition(
    active: ActiveTurn,
    status: Exclude<AgentRunState, AgentTurnTerminalStatus>,
    providerState?: string | null,
  ): boolean;
  observeSubagent(
    active: ActiveTurn,
    trace: SubagentTrace,
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

  private broadcastConversationShell(active: ActiveTurn): void {
    if (this.options.hooks.broadcastConversationShell) {
      this.options.hooks.broadcastConversationShell(active.conversation.id);
      return;
    }
    broadcastTurnSnapshot(this.options.hooks);
  }

  project(active: ActiveTurn, event: ProviderEvent): void {
    if (event.type === "text" || event.type === "text-snapshot" || event.type === "approval"
      || event.type === "input" || event.type === "plan") {
      this.options.store.orchestration.backings.acknowledge(active.turn.runId);
    }
    switch (event.type) {
      case "text":
        this.options.streams.appendAssistant(active, event.text);
        break;
      case "text-snapshot": {
        const message = this.options.streams.replaceAssistantSnapshot(
          active,
          event.text,
        );
        this.options.hooks.broadcast({
          type: "agent.text.replaced",
          conversationId: active.conversation.id,
          runId: active.turn.runId,
          turnId: active.turn.id,
          message,
          ...(active.followUpBoundary ? { after: active.followUpBoundary.at } : {}),
        });
        this.options.hooks.broadcast({
          type: "conversation.detail.invalidated",
          conversationId: active.conversation.id,
        });
        broadcastTurnSnapshot(this.options.hooks);
        break;
      }
      case "text-boundary":
        this.options.streams.closeAssistantSegment(active);
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
        active.lastUsage = boundaryUsage(
          usage,
          this.options.now(),
          active.sessionAfter !== null,
        );
        this.options.hooks.broadcast({ type: "agent.usage", usage });
        break;
      }
      case "session":
        updateActiveTurnProviderSession(active, event.sessionId);
        this.options.store.orchestration.backings.observeSession(active.turn, event.sessionId);
        this.options.store.updateConversation(active.conversation.id, {
          providerSessionId: event.sessionId,
          continuationIdentity: active.turn.continuationIdentity,
        });
        break;
      case "session-title":
        active.providerSessionTitle = event.title;
        break;
      case "activity": {
        this.options.streams.closeAssistantSegment(active);
        if (event.kind !== "reasoning" || event.phase !== "started") {
          this.options.streams.flush(active, "reasoning");
        }
        const recorded = this.options.activities.record(
          active,
          event,
          agentActivityKind(event),
          agentActivityStatus(event),
        );
        if (recorded) {
          this.options.hooks.broadcast({
            type: "agent.activity",
            activity: recorded.activity,
          });
          if (recorded.runsChanged) this.broadcastConversationShell(active);
        }
        if (active.readOnlyWatcher && isReadOnlyWriteActivity(event, active.readOnlyWatcher.editsGatedBeforeStart)) {
          this.options.interactions.stopForReadOnly(active, "write-attempt", event.label);
        }
        break;
      }
      case "status":
        if (
          (event.status === "starting"
            && this.options.transition(active, "starting", event.providerState))
          || ((event.status === "running"
            || event.status === "delegated"
            || event.status === "retrying"
            || event.status === "cancelling")
            && this.options.transition(
              active,
              event.status,
              event.providerState,
            ))
        ) {
          this.broadcastConversationShell(active);
        }
        break;
      case "approval":
        this.options.activities.flushPending(active);
        if (active.readOnlyWatcher) this.options.interactions.denyForReadOnly(active, event.request);
        else this.options.interactions.openApproval(active, event.request);
        break;
      case "approval-resolved":
        this.options.interactions.resolveApproval(
          active,
          event.requestId,
          event.decision,
        );
        break;
      case "input":
        this.options.activities.flushPending(active);
        if (active.readOnlyWatcher) {
          this.options.interactions.stopForReadOnly(active, "input", event.request.questions[0]?.question ?? "A question");
        } else this.options.interactions.openInput(active, event.request);
        break;
      case "input-resolved":
        this.options.interactions.resolveInput(active, event.requestId);
        break;
      case "plan": {
        this.options.streams.closeAssistantSegment(active);
        this.options.streams.flush(active, "reasoning");
        this.options.activities.flushPending(active);
        const previous = this.options.agentPlans.get(active.conversation.id);
        const stored = previous?.runId === active.turn.runId
          && previous.turnId === active.turn.id
          ? previous
          : null;
        const explanation = event.explanation?.trim() ? event.explanation : null;
        const plan: AgentPlan = {
          conversationId: active.conversation.id,
          runId: active.turn.runId,
          turnId: active.turn.id,
          explanation: event.explanation === null
            ? stored?.explanation ?? null
            : explanation,
          steps: event.steps.length > 0 || !explanation || !stored
            ? event.steps.slice(0, MAX_AGENT_PLAN_STEPS)
            : stored.steps,
        };
        this.options.agentPlans.set(active.conversation.id, plan);
        this.options.store.upsertAgentPlan(plan);
        this.options.hooks.broadcast({
          type: "agent.plan.updated",
          plan,
        });
        if (event.handoff === true) {
          const handoff = event.explanation?.trim() || event.steps.map(({ step }) => `- ${step}`).join("\n").trim();
          if (handoff) {
            try {
              this.options.hooks.onPlanHandoff?.(active.turn, handoff);
            } catch {
            }
          }
        }
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
        broadcastTurnSnapshot(this.options.hooks);
        break;
      case "subagent":
        active.subagentTelemetry ??= new TurnSubagentTelemetry({
          scheduler: this.options.scheduler,
          nowMs: () => Date.parse(this.options.now()),
          write: (subagent, updatedAt) =>
            this.persistSubagent(active, subagent, updatedAt),
        });
        active.subagentTelemetry.project(event, this.options.now());
        break;
    }
  }

  private persistSubagent(
    active: ActiveTurn,
    event: ProviderSubagentEvent,
    updatedAt: string,
  ): ReturnType<RuntimeStore["upsertSubagentTrace"]> {
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
      providerStatus: event.providerStatus ?? null,
      status: event.status,
      isLive: event.isLive,
      revived: event.revived === true,
      description: event.description,
      progress: event.progress,
      result: event.result,
      model: event.model ?? null,
      activity: event.activity ?? null,
      usage: event.usage ?? null,
      toolUseCount: event.toolUseCount ?? null,
      durationMs: event.durationMs ?? null,
      sequence: event.sequence,
      updatedAt,
    });
    if (persisted?.changed) {
      this.options.hooks.broadcast({
        type: "agent.subagent.updated",
        trace: persisted.trace,
      });
      this.options.observeSubagent(active, persisted.trace);
    }
    return persisted;
  }
}
