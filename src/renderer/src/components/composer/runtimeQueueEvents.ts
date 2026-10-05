import { useCallback, useSyncExternalStore } from "react";

export const RUNTIME_QUEUE_CHANGED = "inertia:runtime-queue-changed";
const RUNTIME_QUEUE_LENGTH_CHANGED = "inertia:runtime-queue-length-changed";
const queueLengths = new Map<string, number>();

export function setRuntimeQueueLength(conversationId: string, length: number): void {
  if ((queueLengths.get(conversationId) ?? 0) === length) return;
  if (length === 0) queueLengths.delete(conversationId);
  else queueLengths.set(conversationId, length);
  window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_LENGTH_CHANGED, { detail: conversationId }));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(RUNTIME_QUEUE_LENGTH_CHANGED, onChange);
  return () => window.removeEventListener(RUNTIME_QUEUE_LENGTH_CHANGED, onChange);
}

export function useRuntimeQueueLength(conversationId: string): number {
  return useSyncExternalStore(subscribe, useCallback(() => queueLengths.get(conversationId) ?? 0, [conversationId]));
}
