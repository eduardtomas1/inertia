// The virtualizer itself can keep correcting a scroll request for five seconds.
// Give that reconciliation its full lifetime after our initial exact request;
// elapsed time, rather than animation-frame count, is the only lifetime bound.
const TIMELINE_FOCUS_RESCROLL_INTERVAL = 4;
// Two frames are not a meaningful stability window for a virtual row: a
// follow-up React commit or a deferred virtualizer measurement can replace the
// destination immediately after that. Keep the request alive for a short,
// bounded window while direct user input can still cancel it immediately.
const TIMELINE_FOCUS_STABLE_SAMPLES = 8;
const TIMELINE_FOCUS_TIMEOUT_MS = 5_250;

export type TimelineItemFocusTarget = {
  row: HTMLElement;
  destination: HTMLElement;
};

function intersectsScrollViewport(
  row: HTMLElement,
  scrollElement: HTMLElement,
): boolean {
  const rowBounds = row.getBoundingClientRect();
  const scrollBounds = scrollElement.getBoundingClientRect();
  return Math.min(rowBounds.right, scrollBounds.right)
      > Math.max(rowBounds.left, scrollBounds.left)
    && Math.min(rowBounds.bottom, scrollBounds.bottom)
      > Math.max(rowBounds.top, scrollBounds.top);
}

export function startTimelineItemFocus(input: {
  root: HTMLElement | null;
  scrollElement: HTMLElement | null;
  index: number;
  align: "center" | "start";
  virtualized: boolean;
  resolveTarget: (root: HTMLElement) => TimelineItemFocusTarget | null;
  scrollToIndex: (index: number, align: "center" | "start") => void;
  onSettled?: (settled: boolean) => void;
}): () => void {
  const {
    root,
    scrollElement,
    index,
    align,
    virtualized,
    resolveTarget,
    scrollToIndex,
    onSettled,
  } = input;
  if (!root) {
    onSettled?.(false);
    return () => undefined;
  }
  if (virtualized && !scrollElement) {
    onSettled?.(false);
    return () => undefined;
  }

  let attempts = 0;
  let consecutiveStableSamples = 0;
  let finished = false;
  let frame = 0;
  let lastDestination: HTMLElement | null = null;
  let mutationObserver: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let timer = 0;

  const removeIntentListeners = (): void => {
    window.removeEventListener("wheel", cancelForUserIntent, true);
    window.removeEventListener("touchstart", cancelForUserIntent, true);
    window.removeEventListener("pointerdown", cancelForUserIntent, true);
    window.removeEventListener("keydown", cancelForUserIntent, true);
  };

  const schedule = (): void => {
    if (finished || frame !== 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      settle();
    });
  };
  const finish = (settled: boolean): void => {
    if (finished) return;
    finished = true;
    if (frame !== 0) window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    removeIntentListeners();
    onSettled?.(settled);
  };
  function cancelForUserIntent(): void {
    finish(false);
  }
  const settle = (): void => {
    if (finished) return;
    attempts += 1;
    const target = resolveTarget(root);
    if (target?.row.isConnected && target.destination.isConnected) {
      if (!virtualized) {
        target.row.scrollIntoView({ block: align, inline: "nearest" });
      } else if (
        scrollElement
        && !intersectsScrollViewport(target.row, scrollElement)
      ) {
        consecutiveStableSamples = 0;
        lastDestination = null;
        if (attempts % TIMELINE_FOCUS_RESCROLL_INTERVAL === 0) {
          scrollToIndex(index, align);
        }
        schedule();
        return;
      }
      const retainedFocus = document.activeElement === target.destination;
      const retainedDestination = retainedFocus
        && lastDestination === target.destination;
      if (!retainedFocus) {
        target.destination.focus({ preventScroll: true });
      }
      if (document.activeElement === target.destination) {
        consecutiveStableSamples = retainedDestination
          ? consecutiveStableSamples + 1
          : 1;
        lastDestination = target.destination;
        if (consecutiveStableSamples >= TIMELINE_FOCUS_STABLE_SAMPLES) {
          finish(true);
          return;
        }
      } else {
        consecutiveStableSamples = 0;
        lastDestination = null;
      }
    } else if (
      virtualized
      && attempts % TIMELINE_FOCUS_RESCROLL_INTERVAL === 0
    ) {
      consecutiveStableSamples = 0;
      lastDestination = null;
      scrollToIndex(index, align);
    } else {
      consecutiveStableSamples = 0;
      lastDestination = null;
    }
    schedule();
  };

  mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(root, { childList: true, subtree: true });
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(root);
  }
  window.addEventListener("wheel", cancelForUserIntent, {
    capture: true,
    passive: true,
  });
  window.addEventListener("touchstart", cancelForUserIntent, {
    capture: true,
    passive: true,
  });
  window.addEventListener("pointerdown", cancelForUserIntent, true);
  window.addEventListener("keydown", cancelForUserIntent, true);
  if (virtualized) scrollToIndex(index, align);
  timer = window.setTimeout(() => finish(false), TIMELINE_FOCUS_TIMEOUT_MS);
  schedule();

  return () => finish(false);
}
