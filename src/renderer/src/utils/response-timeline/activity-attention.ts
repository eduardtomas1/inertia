import type { AgentActivity } from "@shared/contracts";

export type ActivityAttentionSeverity = "warning" | "failure";

export function isInterruptedActivity(
  activity: Pick<AgentActivity, "title" | "detail" | "status">,
): boolean {
  return activity.status === "failed"
    && /\binterrupted\b/iu.test(`${activity.title} ${activity.detail ?? ""}`);
}

export function activityAttentionSeverity(
  activity: AgentActivity,
): ActivityAttentionSeverity | null {
  if (isInterruptedActivity(activity)) return "warning";
  if (activity.status === "failed" || activity.kind === "error") return "failure";
  return /\b(?:blocked|canceled|cancelled|incomplete|partial(?:ly)?|skipped|unsupported|warned|warning)\b/iu
    .test(`${activity.title} ${activity.detail ?? ""}`)
    ? "warning"
    : null;
}

export function activityNeedsAttention(activity: AgentActivity): boolean {
  return activityAttentionSeverity(activity) !== null;
}
