import type { ActivityDetailPatch } from "../../../shared/activity-detail";

export function activityDetailPatch(
  previous: string | null | undefined,
  next: string | null,
  rewriteWindow: number,
): ActivityDetailPatch | null {
  if (previous === undefined || previous === null || next === null || next === previous) return null;
  const limit = Math.min(previous.length, next.length);
  let offset = 0;
  while (offset < limit && previous.charCodeAt(offset) === next.charCodeAt(offset)) offset += 1;
  if (offset > 0 && offset < next.length) {
    const code = next.charCodeAt(offset - 1);
    if (code >= 0xd800 && code <= 0xdbff) offset -= 1;
  }
  if (offset === 0 || offset < previous.length - rewriteWindow) return null;
  return { base: previous.length, offset };
}
