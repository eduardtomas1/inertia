import type { AgentActivity } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import {
  mergeProviderActivityDetailWithinTurnBudget,
} from "../../provider/activity-detail";
import type { ProviderActivityEvent } from "../../provider/contracts";
import {
  projectActionKind,
  providerLabel,
} from "./turn-controller-support";
import type {
  ActiveTurn,
  TurnControllerHooks,
} from "./turn-controller-types";

export interface TurnActivityProjectionOptions {
  store: RuntimeStore;
  hooks: TurnControllerHooks;
  now(): string;
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
  ): AgentActivity {
    const candidates = active.runningActivities.get(event.kind) ?? [];
    const identified = event.activityId
      ? active.providerActivitiesById.get(event.activityId)
      : undefined;
    if (identified) {
      const activity = this.options.store.updateActivity(identified.id, {
        title: event.label,
        detail: this.detail(active, identified.detail, event.detail ?? null),
        status,
      });
      active.providerActivitiesById.set(event.activityId!, activity);
      if (event.phase !== "started") {
        active.providerActivitiesById.delete(event.activityId!);
        const pendingIndex = candidates.findIndex(
          ({ id }) => id === identified.id,
        );
        if (pendingIndex >= 0) candidates.splice(pendingIndex, 1);
        if (candidates.length === 0) {
          active.runningActivities.delete(event.kind);
        }
      }
      this.syncCommandRun(active, activity, event.phase);
      return activity;
    }
    if (event.phase !== "started" && event.phase !== "info") {
      let matchIndex = candidates.findIndex(
        (activity) => activity.title === event.label,
      );
      if (
        matchIndex < 0
        && (candidates.length === 1 || event.label === "Tool")
      ) {
        matchIndex = 0;
      }
      if (matchIndex >= 0) {
        const [match] = candidates.splice(matchIndex, 1);
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
        this.syncCommandRun(active, activity, event.phase);
        return activity;
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
    this.syncCommandRun(active, activity, event.phase);
    if (event.phase === "started") {
      candidates.push(activity);
      active.runningActivities.set(event.kind, candidates);
    }
    if (event.activityId && event.phase === "started") {
      active.providerActivitiesById.set(event.activityId, activity);
    }
    return activity;
  }

  settleRunning(
    active: ActiveTurn,
    status: AgentActivity["status"],
    interruptedMessage?: string,
  ): void {
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
            : {}),
        });
        this.syncCommandRun(active, activity);
        this.options.hooks.broadcast({ type: "agent.activity", activity });
      }
    }
    active.runningActivities.clear();
    active.providerActivitiesById.clear();
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
  ): void {
    if (activity.kind !== "command" || phase === "info") return;
    const status = activity.status === "running"
      ? "running"
      : activity.status === "failed"
        ? "failed"
        : "succeeded";
    const label = activity.title === "Command"
      ? "Agent command"
      : activity.title;
    const existingId = active.providerCommandRuns.get(activity.id);
    if (existingId) {
      this.options.store.updateWorkspaceRun(existingId, { label, status });
      if (status !== "running") {
        active.providerCommandRuns.delete(activity.id);
      }
      return;
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
      active.providerCommandRuns.set(activity.id, workspaceRun.id);
    } else {
      this.options.store.updateWorkspaceRun(workspaceRun.id, { status });
    }
  }
}
