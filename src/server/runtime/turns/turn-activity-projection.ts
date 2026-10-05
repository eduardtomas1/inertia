import type { AgentActivity } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import {
  mergeProviderActivityDetailWithinTurnBudget,
} from "../../provider/activity-detail";
import type { ProviderActivityEvent } from "../../provider/contracts";
import {
  broadcastTurnConversationShell,
  projectActionKind,
  providerLabel,
} from "./turn-controller-support";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnTimerScheduler,
} from "./turn-controller-types";
import { STREAM_PROJECTION_FLUSH_INTERVAL_MS } from "./turn-stream-channel";

export interface TurnActivityProjectionOptions {
  store: RuntimeStore;
  hooks: TurnControllerHooks;
  scheduler: TurnTimerScheduler;
  now(): string;
  onPersistenceFailure(active: ActiveTurn, error: unknown): void;
}

export interface RecordedTurnActivity {
  activity: AgentActivity;
  runsChanged: boolean;
}

/**
 * Correlates provider activity with durable transcript rows and the compact
 * workspace-run projection. It never owns turn lifecycle state.
 */
export class TurnActivityProjection {
  constructor(private readonly options: TurnActivityProjectionOptions) {}

  record(
    active: ActiveTurn,
    event: ProviderActivityEvent,
    kind: AgentActivity["kind"],
    status: AgentActivity["status"],
  ): RecordedTurnActivity | null {
    const candidates = active.runningActivities.get(event.kind) ?? [];
    const identified = event.activityId
      ? active.providerActivitiesById.get(event.activityId)
      : undefined;
    const pendingIndex = identified
      ? candidates.findIndex(({ id }) => id === identified.id)
      : -1;
    if (identified && event.phase === "started") {
      const activity: AgentActivity = {
        ...identified,
        title: event.label,
        detail: this.detail(active, identified.detail, event.detail ?? null),
        status,
      };
      active.providerActivitiesById.set(event.activityId!, activity);
      if (pendingIndex >= 0) candidates[pendingIndex] = activity;
      active.pendingActivityUpdates.set(activity.id, activity);
      this.scheduleFlush(active);
      return null;
    }
    this.flushPending(active);
    if (identified) {
      const activity = this.options.store.updateActivity(identified.id, {
        title: event.label,
        detail: this.detail(active, identified.detail, event.detail ?? null),
        status,
      });
      active.providerActivitiesById.delete(event.activityId!);
      if (pendingIndex >= 0) candidates.splice(pendingIndex, 1);
      if (candidates.length === 0) {
        active.runningActivities.delete(event.kind);
      }
      return {
        activity,
        runsChanged: this.syncCommandRun(active, activity, event.phase),
      };
    }
    if (event.phase !== "started" && event.phase !== "info") {
      const identifiedActivityIds = new Set(
        [...active.providerActivitiesById.values()].map(({ id }) => id),
      );
      const legacyCandidateIndexes = candidates.flatMap((candidate, index) =>
        identifiedActivityIds.has(candidate.id)
          ? []
          : [index]);
      if (legacyCandidateIndexes.length === 1) {
        const [match] = candidates.splice(legacyCandidateIndexes[0]!, 1);
        if (candidates.length === 0) {
          active.runningActivities.delete(event.kind);
        } else {
          active.runningActivities.set(event.kind, candidates);
        }
        const activity = this.options.store.updateActivity(match.id, {
          title: event.label,
          detail: this.detail(active, match.detail, event.detail ?? null),
          status,
        });
        return {
          activity,
          runsChanged: this.syncCommandRun(active, activity, event.phase),
        };
      }
    }
    const activity = this.options.store.addActivity({
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      kind,
      title: event.label,
      detail: this.detail(active, null, event.detail ?? null),
      status,
      createdAt: this.options.now(),
    });
    const runsChanged = this.syncCommandRun(active, activity, event.phase);
    if (event.phase === "started") {
      candidates.push(activity);
      active.runningActivities.set(event.kind, candidates);
    }
    if (event.activityId && event.phase === "started") {
      active.providerActivitiesById.set(event.activityId, activity);
    }
    return { activity, runsChanged };
  }

  flushPending(active: ActiveTurn): void {
    this.cancelFlush(active);
    if (active.pendingActivityUpdates.size === 0) return;
    const pending = [...active.pendingActivityUpdates.values()];
    active.pendingActivityUpdates.clear();
    let runsChanged = false;
    for (const update of pending) {
      const activity = this.options.store.updateActivity(update.id, {
        title: update.title,
        detail: update.detail,
        status: update.status,
      });
      runsChanged = this.syncCommandRun(active, activity, "started")
        || runsChanged;
      this.options.hooks.broadcast({ type: "agent.activity", activity });
    }
    if (runsChanged) broadcastTurnConversationShell(this.options.hooks, active);
  }

  discardPending(active: ActiveTurn): void {
    this.cancelFlush(active);
    active.pendingActivityUpdates.clear();
  }

  settleRunning(
    active: ActiveTurn,
    status: AgentActivity["status"],
    interruptedMessage?: string,
    commandStatus?: "failed" | "cancelled",
  ): void {
    this.discardPending(active);
    for (const activities of active.runningActivities.values()) {
      for (const pending of activities) {
        const activity = this.options.store.updateActivity(pending.id, {
          status,
          ...(interruptedMessage
            ? {
                title: `Interrupted · ${pending.title}`,
                detail: this.detail(
                  active,
                  pending.detail,
                  `Interrupted: ${interruptedMessage}`,
                ),
              }
            : { title: pending.title, detail: pending.detail }),
        });
        this.syncCommandRun(active, activity, undefined, commandStatus);
        this.options.hooks.broadcast({ type: "agent.activity", activity });
      }
    }
    active.runningActivities.clear();
    active.providerActivitiesById.clear();
  }

  private scheduleFlush(active: ActiveTurn): void {
    if (active.activityFlushTimer !== null) return;
    active.activityFlushTimer = this.options.scheduler.setTimeout(() => {
      active.activityFlushTimer = null;
      if (active.runState.isTerminal()) {
        active.pendingActivityUpdates.clear();
        return;
      }
      try {
        this.flushPending(active);
      } catch (error) {
        try {
          this.options.onPersistenceFailure(active, error);
        } catch {
          active.pendingActivityUpdates.clear();
        }
      }
    }, STREAM_PROJECTION_FLUSH_INTERVAL_MS);
  }

  private cancelFlush(active: ActiveTurn): void {
    if (active.activityFlushTimer === null) return;
    this.options.scheduler.clearTimeout(active.activityFlushTimer);
    active.activityFlushTimer = null;
  }

  private detail(
    active: ActiveTurn,
    previous: string | null,
    next: string | null,
  ): string | null {
    const merged = mergeProviderActivityDetailWithinTurnBudget(
      previous,
      next,
      active.providerActivityDetailChars,
    );
    active.providerActivityDetailChars = merged.totalChars;
    return merged.detail;
  }

  private syncCommandRun(
    active: ActiveTurn,
    activity: AgentActivity,
    phase?: ProviderActivityEvent["phase"],
    terminalStatus?: "failed" | "cancelled",
  ): boolean {
    if (activity.kind !== "command" || phase === "info") return false;
    const status = terminalStatus ?? (activity.status === "running"
      ? "running"
      : activity.status === "failed"
        ? "failed"
        : "succeeded");
    const label = activity.title === "Command"
      ? "Agent command"
      : activity.title;
    const existing = active.providerCommandRuns.get(activity.id);
    if (existing) {
      if (status === "running" && existing.label === label) return false;
      this.options.store.updateWorkspaceRun(existing.id, { label, status });
      if (status === "running") {
        existing.label = label;
      } else {
        active.providerCommandRuns.delete(activity.id);
      }
      return true;
    }
    const workspaceRun = this.options.store.createWorkspaceRun({
      kind: projectActionKind(activity.title),
      projectId: active.conversation.projectId,
      conversationId: active.conversation.id,
      label,
      detail: `${providerLabel(active.turn.providerId)} · ${active.conversation.title}`,
      status: "running",
      port: null,
    });
    if (status === "running") {
      active.providerCommandRuns.set(activity.id, {
        id: workspaceRun.id,
        label,
      });
    } else {
      this.options.store.updateWorkspaceRun(workspaceRun.id, { status });
    }
    return true;
  }
}
