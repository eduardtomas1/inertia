import type { MessageSearchTarget } from "@shared/message-search";

export const MESSAGE_SEARCH_FOCUS_EVENT = "inertia:message-search-focus";
let pending: { target: MessageSearchTarget; expires: number; isCurrent: () => boolean } | null = null;

/** Retain navigation while the owning conversation detail/virtual row mounts. */
export function requestMessageSearchFocus(target: MessageSearchTarget, isCurrent = (): boolean => true): void {
  pending = { target, expires: Date.now() + 10_000, isCurrent };
  window.dispatchEvent(new Event(MESSAGE_SEARCH_FOCUS_EVENT));
}

export function pendingMessageSearchFocus(conversationId: string): MessageSearchTarget | null {
  if (pending && (pending.expires < Date.now() || !pending.isCurrent())) pending = null;
  return pending?.target.conversationId === conversationId ? pending.target : null;
}

export function clearMessageSearchFocus(): void {
  pending = null;
}
