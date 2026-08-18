import { isTranscriptReaderNavigationKey } from "../../utils/transcriptNavigation";
import { shouldFollowTimeline } from "../../utils/responseTimeline";
import type { FinalAnswerAutoScrollEvent } from "./types";

interface FinalAnswerAnchorOwner {
  current: string | null;
}

interface StartFinalAnswerAnchorInput {
  conversationId: string;
  answerId: string;
  scrollElement: HTMLElement;
  root: HTMLElement;
  virtualized: boolean;
  getAnswerIndex: () => number;
  scrollToIndex: (index: number) => void;
  activeOwner: FinalAnswerAnchorOwner;
  cancelLayoutAnchorRestoration: () => void;
  onEvent?: (event: FinalAnswerAutoScrollEvent) => void;
}

export function startFinalAnswerAnchor({
  conversationId,
  answerId,
  scrollElement,
  root,
  virtualized,
  getAnswerIndex,
  scrollToIndex,
  activeOwner,
  cancelLayoutAnchorRestoration,
  onEvent,
}: StartFinalAnswerAnchorInput): () => void {
  const owner = `${conversationId}\u0000${answerId}`;
  let finished = false;
  let frame = 0;
  let attempts = 0;
  let stableFrames = 0;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  const maximumSettleFrames = 30;
  const settleUntil = performance.now() + 600;
  activeOwner.current = owner;
  cancelLayoutAnchorRestoration();
  onEvent?.({ status: "started", conversationId, answerId });

  const removeIntentListeners = (): void => {
    scrollElement.removeEventListener("wheel", cancelForUserIntent);
    scrollElement.removeEventListener("touchstart", cancelForUserIntent);
    scrollElement.removeEventListener("pointerdown", cancelForUserIntent);
    scrollElement.removeEventListener("keydown", cancelForUserIntent);
  };
  const finish = (
    result: { status: "positioned"; followsLatest: boolean }
      | { status: "cancelled" },
  ): void => {
    if (finished) return;
    finished = true;
    window.cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    removeIntentListeners();
    if (activeOwner.current === owner) activeOwner.current = null;
    onEvent?.({ ...result, conversationId, answerId });
  };
  const scheduleSettle = (): void => {
    if (finished || frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      settle();
    });
  };
  const settle = (): void => {
    if (finished) return;
    const exhausted = attempts >= maximumSettleFrames
      || performance.now() >= settleUntil;
    const answer = [...root.querySelectorAll<HTMLElement>(
      "[data-terminal-answer-id]",
    )].find((element) =>
      element.dataset.terminalAnswerId === answerId) ?? null;
    if (!answer) {
      if (exhausted) {
        finish({ status: "cancelled" });
        return;
      }
      if (virtualized && attempts % 4 === 0) scrollToIndex(getAnswerIndex());
      attempts += 1;
      scheduleSettle();
      return;
    }

    const viewportBounds = scrollElement.getBoundingClientRect();
    const delta = answer.getBoundingClientRect().top - viewportBounds.top - 8;
    if (Math.abs(delta) >= 0.5) scrollElement.scrollTop += delta;
    const answerBounds = answer.getBoundingClientRect();
    const settledOffset = answerBounds.top - viewportBounds.top;
    const followsLatest = shouldFollowTimeline(
      scrollElement.scrollTop,
      scrollElement.clientHeight,
      scrollElement.scrollHeight,
    );
    const fullyVisibleAtClampedBottom = followsLatest
      && answerBounds.top >= viewportBounds.top - 0.5
      && answerBounds.bottom <= viewportBounds.bottom + 0.5;
    stableFrames = (
      Math.abs(settledOffset - 8) < 0.5
      || fullyVisibleAtClampedBottom
    ) ? stableFrames + 1 : 0;
    attempts += 1;
    if (stableFrames < 2 && !exhausted) {
      scheduleSettle();
      return;
    }
    finish({
      status: "positioned",
      // An exhausted provisional measurement remains positioned in reading
      // mode. Bottom-following is safe only after the complete answer is both
      // stable and visible at the clamped bottom.
      followsLatest: stableFrames > 1
        && fullyVisibleAtClampedBottom,
    });
  };
  function cancelForUserIntent(event: Event): void {
    if (
      event instanceof KeyboardEvent
      && !isTranscriptReaderNavigationKey(event.key)
    ) return;
    if (event instanceof PointerEvent && event.target !== scrollElement) return;
    finish({ status: "cancelled" });
  }

  scrollElement.addEventListener("wheel", cancelForUserIntent, { passive: true });
  scrollElement.addEventListener("touchstart", cancelForUserIntent, { passive: true });
  scrollElement.addEventListener("pointerdown", cancelForUserIntent);
  scrollElement.addEventListener("keydown", cancelForUserIntent);
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(scheduleSettle);
    resizeObserver.observe(root);
  }
  if (typeof MutationObserver !== "undefined") {
    mutationObserver = new MutationObserver(scheduleSettle);
    mutationObserver.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
  if (virtualized) scrollToIndex(getAnswerIndex());
  scheduleSettle();
  return () => finish({ status: "cancelled" });
}
