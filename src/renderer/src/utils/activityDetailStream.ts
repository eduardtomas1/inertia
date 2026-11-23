import type { AgentActivity } from "@shared/contracts";
import { applyActivityDetailPatch, type ActivityDetailPatch } from "@shared/activity-detail";

export interface MaterializedActivity {
  activity: AgentActivity;
  resync: boolean;
}

function withoutPreviewFields(activity: AgentActivity): AgentActivity {
  if (activity.detailTruncated === undefined && activity.detailBytes === undefined) return activity;
  const { detailBytes: _bytes, detailTruncated: _truncated, ...full } = activity;
  return full;
}

export function materializeActivityEvent(
  event: { activity: AgentActivity; detailPatch?: ActivityDetailPatch },
  baseline: AgentActivity | undefined,
): MaterializedActivity {
  if (!event.detailPatch) return { activity: event.activity, resync: false };
  const applied = baseline && !baseline.detailTruncated
    ? applyActivityDetailPatch(baseline.detail, event.detailPatch, event.activity.detail)
    : null;
  if (applied !== null) {
    return { activity: { ...withoutPreviewFields(event.activity), detail: applied }, resync: false };
  }
  return {
    activity: {
      ...withoutPreviewFields(event.activity),
      detail: baseline?.detail ?? event.activity.detail,
      detailTruncated: true,
    },
    resync: true,
  };
}

export function withFullActivityDetail(activity: AgentActivity, detail: string | null): AgentActivity {
  return { ...withoutPreviewFields(activity), detail };
}
