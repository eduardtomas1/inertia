const REVEAL_EVENT = "inertia:background-task-reveal";
const REVEAL_TTL_MS = 10_000;

export interface BackgroundTaskReveal {
  conversationId: string;
  turnId: string;
}

let pending: { reveal: BackgroundTaskReveal; expires: number } | null = null;

export function requestBackgroundTaskReveal(reveal: BackgroundTaskReveal): void {
  pending = { reveal, expires: Date.now() + REVEAL_TTL_MS };
  window.dispatchEvent(new Event(REVEAL_EVENT));
}

export function takeBackgroundTaskReveal(conversationId: string): string | null {
  if (pending && pending.expires < Date.now()) pending = null;
  if (pending?.reveal.conversationId !== conversationId) return null;
  const { turnId } = pending.reveal;
  pending = null;
  return turnId;
}

export function subscribeBackgroundTaskReveal(listener: () => void): () => void {
  window.addEventListener(REVEAL_EVENT, listener);
  return () => window.removeEventListener(REVEAL_EVENT, listener);
}
