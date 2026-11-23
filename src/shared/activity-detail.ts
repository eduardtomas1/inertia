export const MAX_ACTIVITY_DETAIL_READ_CHARS = 64 * 1024;

export interface ActivityDetailPatch {
  base: number;
  offset: number;
}

export function applyActivityDetailPatch(
  current: string | null | undefined,
  patch: ActivityDetailPatch,
  text: string | null,
): string | null {
  if (current === undefined || current === null || text === null) return null;
  if (current.length !== patch.base || patch.offset > patch.base) return null;
  return current.slice(0, patch.offset) + text;
}

export interface ActivityDetailReadResult {
  kind: "activity.detail";
  conversationId: string;
  activityId: string;
  turnId: string | null;
  detail: string | null;
}
