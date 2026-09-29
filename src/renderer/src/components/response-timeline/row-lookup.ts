import type { TranscriptPosition } from "../../utils/transcriptPosition";
import { shouldFollowTimeline } from "../../utils/responseTimeline";

export function responseRows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-response-row-id]")];
}

export function findResponseRow(root: HTMLElement, rowId: string): HTMLElement | null {
  return responseRows(root).find((element) => element.dataset.responseRowId === rowId) ?? null;
}

export function firstVisibleResponseRow(root: HTMLElement, viewportTop: number): HTMLElement | undefined {
  return responseRows(root).find((element) => element.getBoundingClientRect().bottom > viewportTop + 8);
}

export function findTurnElement(
  root: HTMLElement | null | undefined,
  turnId: string,
): HTMLElement | null {
  if (!root) return null;
  return [...root.querySelectorAll<HTMLElement>("[data-turn-id]")]
    .find((element) => element.dataset.turnId === turnId) ?? null;
}

export function captureTranscriptPosition(root: HTMLElement, scroll: HTMLElement): TranscriptPosition {
  const wasFollowing = shouldFollowTimeline(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight);
  const top = scroll.getBoundingClientRect().top;
  const row = wasFollowing ? undefined : firstVisibleResponseRow(root, top);
  return {
    rowId: row?.dataset.responseRowId ?? null,
    viewportOffset: row ? row.getBoundingClientRect().top - top : 0,
    scrollTop: scroll.scrollTop,
    wasFollowing,
  };
}
