export const CHECKOUT_BRANCH_MENU_EVENT = "inertia:checkout-branch-menu";
/** Opens the header branch chooser, the same flow as Git actions → Switch branch. */
export const HEADER_BRANCH_MENU_EVENT = "inertia:header-branch-menu";

function requestMenu(type: string, target: EventTarget): boolean {
  const event = new Event(type, { cancelable: true });
  return !target.dispatchEvent(event);
}

function onMenuRequest(
  type: string,
  listener: () => boolean,
  target: EventTarget,
): () => void {
  const handle = (event: Event): void => {
    if (event.defaultPrevented) return;
    if (listener()) event.preventDefault();
  };
  target.addEventListener(type, handle);
  return () => target.removeEventListener(type, handle);
}

export function requestCheckoutBranchMenu(target: EventTarget = window): boolean {
  return requestMenu(CHECKOUT_BRANCH_MENU_EVENT, target);
}

export function onCheckoutBranchMenuRequest(
  listener: () => boolean,
  target: EventTarget = window,
): () => void {
  return onMenuRequest(CHECKOUT_BRANCH_MENU_EVENT, listener, target);
}

export function requestHeaderBranchMenu(target: EventTarget = window): boolean {
  return requestMenu(HEADER_BRANCH_MENU_EVENT, target);
}

export function onHeaderBranchMenuRequest(
  listener: () => boolean,
  target: EventTarget = window,
): () => void {
  return onMenuRequest(HEADER_BRANCH_MENU_EVENT, listener, target);
}
