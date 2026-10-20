import { useSyncExternalStore } from "react";

/**
 * One app-wide "New initiative" request. Menus, the composer picker, the
 * palette and the Initiative page all ask the main window to name a new
 * initiative; the dialog itself lives once in the layout.
 */
export interface NewInitiativeRequest {
  /** A chat to move into the new initiative in the same runtime transaction. */
  conversationId?: string;
  /** Runs after the authoritative snapshot already contains the initiative. */
  onCreated?: (initiativeId: string) => void;
  /**
   * Where focus returns when the dialog closes. Captured when the request is
   * made: the dialog loads lazily, and by the time it mounts a menu that asked
   * for it has closed and focus has fallen to the document body.
   */
  returnFocus?: HTMLElement | null;
}

let current: NewInitiativeRequest | null = null;
const listeners = new Set<() => void>();

function publish(next: NewInitiativeRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The control that asked for a new initiative. A menu item disappears with its
 * menu, so a request from inside a menu returns focus to the control that
 * opened the outermost menu (the one whose `aria-controls` names it).
 */
function requestingControl(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  let menu = active.closest<HTMLElement>('[role="menu"]');
  if (!menu) return active;
  for (
    let outer = menu.parentElement?.closest<HTMLElement>('[role="menu"]');
    outer;
    outer = outer.parentElement?.closest<HTMLElement>('[role="menu"]')
  ) menu = outer;
  const menuId = menu.id;
  if (!menuId) return null;
  return [...document.querySelectorAll<HTMLElement>("[aria-controls]")]
    .find((control) => control.getAttribute("aria-controls") === menuId) ?? null;
}

export function requestNewInitiative(request: NewInitiativeRequest = {}): void {
  publish({
    ...request,
    returnFocus: request.returnFocus === undefined ? requestingControl() : request.returnFocus,
  });
}

export function closeNewInitiativeRequest(): void {
  publish(null);
}

export function useNewInitiativeRequest(): NewInitiativeRequest | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
