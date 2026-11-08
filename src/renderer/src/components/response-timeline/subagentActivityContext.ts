import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { AgentActivity, SubagentTrace } from "@shared/contracts";
import { linkedSubagentTraces } from "../../utils/subagentTraceRows";

/**
 * A turn's delegated tasks keyed by the timeline row of the tool call that
 * started them. The store keeps one identity per turn, so a telemetry flush
 * re-renders only the rows whose own trace changed, never the whole turn.
 */
export interface SubagentActivityStore {
  get(activityId: string): SubagentTrace | undefined;
  subscribe(listener: () => void): () => void;
  publish(traces: readonly SubagentTrace[]): void;
}

function sameRevision(left: SubagentTrace, right: SubagentTrace): boolean {
  return left === right || (left.id === right.id
    && left.sequence === right.sequence
    && left.updatedAt === right.updatedAt);
}

export function createSubagentActivityStore(
  traces: readonly SubagentTrace[] = [],
): SubagentActivityStore {
  let linked = linkedSubagentTraces(traces);
  const listeners = new Set<() => void>();
  return {
    get: (activityId) => linked.get(activityId),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next) {
      const previous = linked;
      const published = new Map<string, SubagentTrace>();
      for (const [activityId, trace] of linkedSubagentTraces(next)) {
        const kept = previous.get(activityId);
        published.set(activityId, kept && sameRevision(kept, trace) ? kept : trace);
      }
      const changed = published.size !== previous.size
        || [...published].some(([activityId, trace]) => previous.get(activityId) !== trace);
      linked = published;
      if (changed) for (const listener of listeners) listener();
    },
  };
}

const NO_LINKED_TRACES = createSubagentActivityStore();

export const SubagentActivityContext = createContext<SubagentActivityStore>(NO_LINKED_TRACES);

/** The delegated task a tool row started, re-rendering only when that task changes. */
export function useLinkedSubagent(activityId: string): SubagentTrace | undefined {
  const store = useContext(SubagentActivityContext);
  const snapshot = (): SubagentTrace | undefined => store.get(activityId);
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

function rowStatus(trace: SubagentTrace): AgentActivity["status"] {
  if (trace.isLive) return "running";
  return trace.status === "failed" || trace.status === "interrupted" || trace.status === "lost"
    ? "failed"
    : "completed";
}

/**
 * A group's tool rows with each linked task's status in place of its tool
 * call's, so a live delegated task keeps its group open. The group itself
 * re-renders only when one of those statuses changes.
 */
export function useLinkedActivityStatuses(activities: AgentActivity[]): AgentActivity[] {
  const store = useContext(SubagentActivityContext);
  const snapshot = (): string => activities
    .map((activity) => {
      const trace = store.get(activity.id);
      return trace ? rowStatus(trace) : "";
    })
    .join("|");
  const statuses = useSyncExternalStore(store.subscribe, snapshot, snapshot);
  return useMemo(() => {
    const linkedStatuses = statuses.split("|");
    if (linkedStatuses.every((status) => status === "")) return activities;
    return activities.map((activity, index) => {
      const status = linkedStatuses[index] as AgentActivity["status"] | "";
      return status && status !== activity.status ? { ...activity, status } : activity;
    });
  }, [activities, statuses]);
}
