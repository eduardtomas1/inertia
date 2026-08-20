const FOCUSABLE = ':is(button,input,textarea,select):not(:disabled),iframe,[href],[tabindex]:not([tabindex="-1"])';

export function captureModalFocus(preventScroll = true): () => void {
  const previous = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  return () => {
    if (!previous?.isConnected) return;
    previous.focus(preventScroll ? { preventScroll: true } : undefined);
  };
}

export function focusModalOnAnimationFrame(
  focus: () => void,
  preventScroll = true,
): () => void {
  const restoreFocus = captureModalFocus(preventScroll);
  const frame = window.requestAnimationFrame(focus);
  return () => {
    window.cancelAnimationFrame(frame);
    restoreFocus();
  };
}

export function trapModalFocus(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  root: HTMLElement,
): void {
  if (event.key !== "Tab") return;
  const elements = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
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
