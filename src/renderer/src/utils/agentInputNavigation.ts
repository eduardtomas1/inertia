import { secretRequestElementId } from "./response-timeline/secretRequests";

export const REVEAL_PENDING_REQUEST_MAX_FRAMES = 12;

export function revealAgentInputRequest(requestId: string): boolean {
  const request = document.getElementById(`agent-input-request-${requestId}`);
  if (!request) return false;
  request.scrollIntoView({ block: "nearest", behavior: "smooth" });
  request.querySelector<HTMLElement>(
    "input, button, select, textarea",
  )?.focus();
  return true;
}

export function revealSecretRequest(requestId: string): boolean {
  const card = document.getElementById(secretRequestElementId(requestId));
  if (!card) return false;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const control = card.querySelector<HTMLElement>("input, button");
  if (control) {
    control.focus();
  } else {
    if (!card.hasAttribute("tabindex")) card.tabIndex = -1;
    card.focus();
  }
  return true;
}

export function createPendingRequestRevealer(): {
  reveal: (
    attempt: () => boolean,
    options: {
      onScrollToLatest: () => void;
      onRevealed: () => void;
      maxFrames?: number;
    },
  ) => void;
  cancel: () => void;
} {
  let frame: number | null = null;
  const cancel = (): void => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
  };
  return {
    cancel,
    reveal(attempt, { onScrollToLatest, onRevealed, maxFrames = REVEAL_PENDING_REQUEST_MAX_FRAMES }) {
      cancel();
      if (attempt()) {
        onRevealed();
        return;
      }
      onScrollToLatest();
      let remaining = maxFrames;
      const retry = (): void => {
        frame = null;
        if (attempt()) {
          onRevealed();
          return;
        }
        remaining -= 1;
        if (remaining > 0) frame = window.requestAnimationFrame(retry);
      };
      if (remaining > 0) frame = window.requestAnimationFrame(retry);
    },
  };
}
