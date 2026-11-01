const REVEAL_EVENT = "inertia:background-task-reveal";
const REVEAL_TTL_MS = 10_000;

export const BACKGROUND_TASK_ORIGIN_ATTRIBUTE = "data-background-task-origin";

export interface BackgroundTaskReveal {
  conversationId: string;
  turnId: string;
  traceId?: string;
}

let pending: { reveal: BackgroundTaskReveal; expires: number } | null = null;

export function requestBackgroundTaskReveal(reveal: BackgroundTaskReveal): void {
  pending = { reveal, expires: Date.now() + REVEAL_TTL_MS };
  window.dispatchEvent(new Event(REVEAL_EVENT));
}

export function takeBackgroundTaskReveal(conversationId: string): BackgroundTaskReveal | null {
  if (pending && pending.expires < Date.now()) pending = null;
  if (pending?.reveal.conversationId !== conversationId) return null;
  const { reveal } = pending;
  pending = null;
  return reveal;
}

export function subscribeBackgroundTaskReveal(listener: () => void): () => void {
  window.addEventListener(REVEAL_EVENT, listener);
  return () => window.removeEventListener(REVEAL_EVENT, listener);
}

export function focusMayMoveToRevealedTask(active: Element | null): boolean {
  return !active || active === document.body || active.closest(`[${BACKGROUND_TASK_ORIGIN_ATTRIBUTE}]`) !== null;
}
