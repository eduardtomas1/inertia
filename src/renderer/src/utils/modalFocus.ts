const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), iframe, [href], [tabindex]:not([tabindex="-1"])';

export function captureModalFocus(preventScroll = true): () => void {
  const previous = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  return () => {
    if (!previous?.isConnected) return;
    previous.focus(preventScroll ? { preventScroll: true } : undefined);
  };
}

export function focusOnAnimationFrame(focus: () => void): () => void {
  const frame = window.requestAnimationFrame(focus);
  return () => window.cancelAnimationFrame(frame);
}

export function trapModalFocus(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  root: HTMLElement,
  visibleOnly = false,
): void {
  if (event.key !== "Tab") return;
  const elements = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((element) => !element.hidden
      && (!visibleOnly || element.getClientRects().length > 0));
  const first = elements[0];
  const last = elements.at(-1);
  if (!first || !last) {
    event.preventDefault();
    root.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
