const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), iframe, [href], [tabindex]:not([tabindex="-1"])';

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
