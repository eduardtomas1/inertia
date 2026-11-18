import type { DelegatedTaskStatus } from "./orchestration-delegation";

/**
 * The verbs a delegated-result wake uses for task outcomes. The server writes the wake's summary line with them and
 * the renderer builds the card's headline with them, so both read the same words.
 */
export const DELEGATED_SINGLE_VERBS: Readonly<Record<DelegatedTaskStatus, string>> = {
  running: "is still running",
  completed: "finished",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "was interrupted",
};

export const DELEGATED_BATCH_VERBS: Readonly<Record<DelegatedTaskStatus, string>> = {
  running: "are still running",
  completed: "finished",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "were interrupted",
};

/** The verb for tasks whose outcome is not known; it claims no outcome. */
export const DELEGATED_UNKNOWN_OUTCOME_VERB = "returned";

/** Worst outcome first. */
export const DELEGATED_OUTCOME_PRECEDENCE: readonly DelegatedTaskStatus[] = ["failed", "cancelled", "interrupted", "running",
  "completed"];

/** The worst outcome among the statuses, "completed" when there is none. */
export function delegatedWorstOutcome(statuses: readonly DelegatedTaskStatus[]): DelegatedTaskStatus {
  return DELEGATED_OUTCOME_PRECEDENCE.find((status) => statuses.includes(status)) ?? "completed";
}

/** Each outcome among the statuses with its count, worst first: ["1 failed", "2 finished"]. */
export function delegatedOutcomeCounts(statuses: readonly DelegatedTaskStatus[]): string[] {
  return DELEGATED_OUTCOME_PRECEDENCE.flatMap((status) => {
    const count = statuses.filter((candidate) => candidate === status).length;
    return count ? [`${count} ${(count === 1 ? DELEGATED_SINGLE_VERBS : DELEGATED_BATCH_VERBS)[status]}`] : [];
  });
}

/**
 * The outcome of a batch, grouped by status so one failure does not read as every task failing (T3 f0495f741):
 * one verb when all tasks share an outcome ("finished"), otherwise "(1 failed, 2 finished)", worst outcome first.
 */
export function delegatedOutcomeGroups(statuses: readonly DelegatedTaskStatus[]): string {
  const counts = delegatedOutcomeCounts(statuses);
  return counts.length <= 1 ? DELEGATED_BATCH_VERBS[delegatedWorstOutcome(statuses)] : `(${counts.join(", ")})`;
}
