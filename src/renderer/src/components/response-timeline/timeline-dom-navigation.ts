import type { ResponseTimelineItem } from "../../utils/responseTimeline";

export function findTurnElement(
  root: HTMLElement | null | undefined,
  turnId: string,
): HTMLElement | null {
  if (!root) return null;
  return [...root.querySelectorAll<HTMLElement>("[data-turn-id]")]
    .find((element) => element.dataset.turnId === turnId) ?? null;
}

export function currentPlainTimelineIndex(
  root: HTMLElement | null | undefined,
  scrollElement: HTMLElement | null | undefined,
  timeline: ResponseTimelineItem[],
): number {
  if (!root || !scrollElement || timeline.length === 0) return 0;
  const scrollTop = scrollElement.getBoundingClientRect().top;
  const visible = [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")]
    .find((element) => element.getBoundingClientRect().bottom > scrollTop + 8);
  const index = visible
    ? timeline.findIndex(({ id }) => id === visible.dataset.responseRowId)
    : -1;
  return index >= 0 ? index : Math.max(0, timeline.length - 1);
}
