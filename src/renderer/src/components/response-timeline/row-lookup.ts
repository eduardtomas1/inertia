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

export function captureTranscriptPosition(root: HTMLElement, scroll: HTMLElement, following?: boolean): TranscriptPosition {
  const wasFollowing = following !== false && shouldFollowTimeline(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight);
  const top = scroll.getBoundingClientRect().top;
  const row = wasFollowing ? undefined : firstVisibleResponseRow(root, top);
  return {
    rowId: row?.dataset.responseRowId ?? null,
    viewportOffset: row ? row.getBoundingClientRect().top - top : 0,
    scrollTop: scroll.scrollTop,
    wasFollowing,
  };
}

export interface VirtualizedRowSlice {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export function captureVirtualizedTranscriptPosition(
  root: HTMLElement,
  scroll: HTMLElement,
  virtualItems: readonly VirtualizedRowSlice[],
  timelineItems: readonly { id: string }[],
  following?: boolean,
): TranscriptPosition {
  const wasFollowing = following !== false
    && shouldFollowTimeline(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight);
  if (wasFollowing) {
    return { rowId: null, viewportOffset: 0, scrollTop: scroll.scrollTop, wasFollowing: true };
  }
  if (virtualItems.length === 0) {
    return captureTranscriptPosition(root, scroll, following);
  }
  const scrollTopRect = scroll.getBoundingClientRect().top;
  const virtualWindow = root.querySelector<HTMLElement>(".response-virtual-window");
  const windowOrigin = virtualWindow
    ? virtualWindow.getBoundingClientRect().top - scrollTopRect + scroll.scrollTop
    : 0;
  const threshold = scroll.scrollTop - windowOrigin + 8;
  const startIndex = virtualItems.findIndex((item) => item.end > threshold);
  if (startIndex === -1) return captureTranscriptPosition(root, scroll, following);
  const visibilityCutoff = scrollTopRect + 8;
  for (let i = startIndex; i < virtualItems.length; i += 1) {
    const candidate = virtualItems[i]!;
    const rowId = timelineItems[candidate.index]?.id ?? null;
    const rowElement = root.querySelector<HTMLElement>(
      `[data-index="${candidate.index}"] [data-response-row-id]`,
    );
    if (rowElement) {
      const rect = rowElement.getBoundingClientRect();
      // `.response-virtual-item` includes bottom turn-gap padding; skip an item
      // whose padding crosses the threshold while its row is already above it.
      if (rect.bottom <= visibilityCutoff) continue;
      return {
        rowId,
        viewportOffset: rect.top - scrollTopRect,
        scrollTop: scroll.scrollTop,
        wasFollowing: false,
      };
    }
    return {
      rowId,
      viewportOffset: windowOrigin + candidate.start - scroll.scrollTop,
      scrollTop: scroll.scrollTop,
      wasFollowing: false,
    };
  }
  return captureTranscriptPosition(root, scroll, following);
}

export function createCoalescedScrollRemember(
  onCapture: () => void,
): { schedule: () => void; flush: () => void; dispose: () => void } {
  let frame: number | null = null;
  let dirty = false;
  const run = (): void => {
    frame = null;
    if (!dirty) return;
    dirty = false;
    onCapture();
  };
  return {
    schedule: () => {
      dirty = true;
      if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
        run();
        return;
      }
      if (frame === null) frame = window.requestAnimationFrame(run);
    },
    flush: () => {
      if (frame !== null && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      dirty = false;
      onCapture();
    },
    dispose: () => {
      if (frame !== null && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      if (dirty) {
        dirty = false;
        onCapture();
      }
    },
  };
}
