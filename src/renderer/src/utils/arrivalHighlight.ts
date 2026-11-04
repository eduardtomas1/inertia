const ARRIVAL_ATTRIBUTE = "data-arrival";
const ARRIVAL_DURATION_MS = 1_800;
const ARRIVAL_WAIT_MS = 6_000;

let cancelPending: (() => void) | null = null;

function identifies(element: HTMLElement, messageId: string): boolean {
  const { terminalAnswerId, messageSearchId, followUpMessageId } = element.dataset;
  return terminalAnswerId === messageId || messageSearchId === messageId || followUpMessageId === messageId;
}

export function showArrival(element: HTMLElement): void {
  element.removeAttribute(ARRIVAL_ATTRIBUTE);
  void element.offsetWidth;
  element.setAttribute(ARRIVAL_ATTRIBUTE, "");
  window.setTimeout(() => element.removeAttribute(ARRIVAL_ATTRIBUTE), ARRIVAL_DURATION_MS);
}

export function highlightArrivalOnFocus(messageId: string): void {
  cancelPending?.();
  const finish = (): void => {
    document.removeEventListener("focusin", arrive);
    window.clearTimeout(timer);
    if (cancelPending === finish) cancelPending = null;
  };
  function arrive(event: FocusEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !identifies(target, messageId)) return;
    finish();
    showArrival(target);
  }
  const timer = window.setTimeout(finish, ARRIVAL_WAIT_MS);
  document.addEventListener("focusin", arrive);
  cancelPending = finish;
}
