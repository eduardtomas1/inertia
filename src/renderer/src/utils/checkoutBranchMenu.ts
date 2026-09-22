export const CHECKOUT_BRANCH_MENU_EVENT = "inertia:checkout-branch-menu";

export function requestCheckoutBranchMenu(target: EventTarget = window): boolean {
  const event = new Event(CHECKOUT_BRANCH_MENU_EVENT, { cancelable: true });
  return !target.dispatchEvent(event);
}

export function onCheckoutBranchMenuRequest(
  listener: () => boolean,
  target: EventTarget = window,
): () => void {
  const handle = (event: Event): void => {
    if (event.defaultPrevented) return;
    if (listener()) event.preventDefault();
  };
  target.addEventListener(CHECKOUT_BRANCH_MENU_EVENT, handle);
  return () => target.removeEventListener(CHECKOUT_BRANCH_MENU_EVENT, handle);
}
