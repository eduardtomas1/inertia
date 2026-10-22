import type {
  DuoComparisonState,
  DuoStatusResult,
} from "@shared/contracts";

export type ComparisonMutationIntent = {
  launchId: string;
  kind: "retry" | "cancel";
  baselineAttempt: number;
  baselineState: DuoComparisonState;
};

export type DuoMutationIntent = ComparisonMutationIntent | {
  launchId: string;
  kind: "acknowledge";
};

export const INVALID_DUO_RESPONSE = "Invalid Duo response.";

export function duoSideLetter(ordinal: number): "A" | "B" {
  return ordinal === 0 ? "A" : "B";
}

export function launchStatusMessage(status: DuoStatusResult): string | null {
  const comparison = status.comparison;
  if (comparison?.state === "failed") {
    return comparison.error
      ?? "The judge failed. Source chats stay locked; retry or cancel it.";
  }
  if (comparison?.state === "interrupted") {
    return comparison.error
      ?? "The judge was interrupted without retry. Source chats stay locked.";
  }
  if (comparison?.state === "waiting" && comparison.error) {
    return comparison.error;
  }
  if (status.state === "running" && status.cancelRequested) {
    return "Duo cancellation is still waiting for provider cleanup. Both chats remain locked until it finishes.";
  }
  if (status.state === "running") return null;
  const started = status.sides.find(({ dispatchState }) => dispatchState === "started");
  const failed = status.sides.find(({ dispatchState }) => dispatchState === "failed");
  if (started && failed) {
    return `Chat ${duoSideLetter(started.ordinal)} started but chat ${duoSideLetter(failed.ordinal)} didn't. Check both chats before trying again.`;
  }
  if (status.error) return status.error;
  if (status.state === "cancelled") {
    return "The duo was cancelled before both chats started.";
  }
  if (status.state === "interrupted" || status.state === "recovery-required") {
    return status.state === "interrupted"
      ? "Duo dispatch is uncertain and provider effects are not atomic. Inspect both chats; no automatic retry."
      : "Manual Git recovery is required. Inspect the retained worktree or branch, recover it safely, then re-check.";
  }
  if (status.state === "failed") {
    return "Neither side will retry automatically. Inspect both saved chats.";
  }
  if (status.state === "prepared") {
    return "Both chats are saved and idle; inspect them before starting again.";
  }
  return `Duo is ${status.state}. Refresh before another launch.`;
}

export function retainedLaunchBlockingMessage(
  status: DuoStatusResult,
): string | null {
  const comparison = status.comparison;
  if (comparison?.state === "waiting" && comparison.error) {
    return "The judge is waiting for its folder. Wait or cancel it to release the chat locks before another Duo.";
  }
  if (
    comparison?.state === "waiting"
    || comparison?.state === "dispatching"
    || comparison?.state === "running"
  ) return `The judge is still ${comparison.state === "running" ? "comparing" : comparison.state}. Wait or cancel it to release the chat locks before another Duo.`;
  return launchStatusMessage(status);
}

export function comparisonNeedsMonitoring(status: DuoStatusResult): boolean {
  const state = status.comparison?.state;
  return state === "waiting"
    || state === "dispatching"
    || state === "running"
    || (status.state === "running" && status.cancelRequested === true);
}

export function comparisonNeedsAttention(status: DuoStatusResult): boolean {
  const state = status.comparison?.state;
  return state === "failed" || state === "interrupted";
}

export function comparisonMutationConfirmed(
  intent: DuoMutationIntent,
  status: DuoStatusResult,
): boolean {
  if (intent.kind === "acknowledge") return status.state !== "interrupted";
  const comparison = status.comparison;
  if (!comparison) return false;
  if (intent.kind === "cancel") {
    return comparison.state === "cancelled" || comparison.state === "completed";
  }
  return comparison.attempt > intent.baselineAttempt
    || (comparison.state !== "failed" && comparison.state !== "interrupted");
}

export function launchRetainsRecoveryIdentity(status: DuoStatusResult): boolean {
  const comparisonState = status.comparison?.state;
  return status.state === "preparing"
    || status.state === "prepared"
    || status.state === "dispatching"
    || status.state === "recovery-required"
    || status.state === "interrupted"
    || (status.state === "running" && status.cancelRequested === true)
    || comparisonState === "waiting"
    || comparisonState === "dispatching"
    || comparisonState === "running"
    || comparisonState === "failed"
    || comparisonState === "interrupted";
}
