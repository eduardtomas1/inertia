import type { AgentActivity } from "@shared/contracts";

export type ActivityAttentionSeverity = "warning" | "failure";
const ATTENTION_DETAIL_SCAN_CHARS = 4_096;
const attentionCache = new WeakMap<AgentActivity, ActivityAttentionSeverity | null>();
const INTERRUPTED_PATTERN = /\binterrupted\b/iu;
const WARNING_PATTERN = /\b(?:blocked|canceled|cancelled|incomplete|partial(?:ly)?|skipped|unsupported|warned|warning)\b/iu;

function titleOrBoundedDetailMatches(
  activity: Pick<AgentActivity, "title" | "detail">,
  pattern: RegExp,
): boolean {
  return pattern.test(activity.title)
    || (
      activity.detail !== null
      && pattern.test(activity.detail.slice(0, ATTENTION_DETAIL_SCAN_CHARS))
    );
}

export function isInterruptedActivity(
  activity: Pick<AgentActivity, "title" | "detail" | "status">,
): boolean {
  return activity.status === "failed"
    && titleOrBoundedDetailMatches(activity, INTERRUPTED_PATTERN);
}

export function activityAttentionSeverity(
  activity: AgentActivity,
): ActivityAttentionSeverity | null {
  const cached = attentionCache.get(activity);
  if (cached !== undefined || attentionCache.has(activity)) return cached ?? null;
  const severity = isInterruptedActivity(activity)
    ? "warning"
    : activity.status === "failed" || activity.kind === "error"
      ? "failure"
      : titleOrBoundedDetailMatches(activity, WARNING_PATTERN)
        ? "warning"
        : null;
  attentionCache.set(activity, severity);
  return severity;
}

export function activityNeedsAttention(activity: AgentActivity): boolean {
  return activityAttentionSeverity(activity) !== null;
}
