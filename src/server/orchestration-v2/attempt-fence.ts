import type { AgentTurnStatus } from "../../shared/turn-lifecycle";
import { orchestrationAttemptSchema, type OrchestrationRun } from "../../shared/orchestration-v2";
import type { OrchestrationEventStore } from "./event-store";

export interface AttemptObserver {
  readonly attemptId: string;
  readonly expectedStatus?: AgentTurnStatus;
}

export interface StaleAttemptObservation {
  readonly reason: "attempt-superseded" | "attempt-not-current" | "run-status-changed";
  readonly runId: string;
  readonly observedAttemptId: string;
  readonly currentAttemptId: string;
}

export function staleAttemptObservation(events: OrchestrationEventStore, run: OrchestrationRun,
  observer: AttemptObserver | undefined): StaleAttemptObservation | null {
  if (!observer) return null;
  const identity = { runId: run.id, observedAttemptId: observer.attemptId, currentAttemptId: run.attemptId };
  if (observer.attemptId === run.attemptId) {
    return observer.expectedStatus === undefined || observer.expectedStatus === run.status
      ? null : { reason: "run-status-changed", ...identity };
  }
  const row = events.projection("attempt", observer.attemptId);
  const observed = row?.threadId === run.threadId ? orchestrationAttemptSchema.safeParse(row.value) : null;
  const superseded = observed?.success === true && observed.data.runId === run.id && observed.data.status === "superseded";
  return { reason: superseded ? "attempt-superseded" : "attempt-not-current", ...identity };
}
