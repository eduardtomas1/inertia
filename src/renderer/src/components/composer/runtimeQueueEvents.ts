import { useCallback, useSyncExternalStore } from "react";

export const RUNTIME_QUEUE_CHANGED = "inertia:runtime-queue-changed";

export function announceRuntimeQueueChanged(conversationId: string): void {
  window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: conversationId }));
}
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

const RUNTIME_QUEUED_FOLLOW_UPS_CHANGED = "inertia:runtime-queued-follow-ups-changed";
const EMPTY_IDS: readonly string[] = [];
const queuedFollowUps = new Map<string, readonly string[]>();

/**
 * Messages that queue rows name: follow-ups the agent accepted but never read. They wait in the queue to be sent
 * as their own turns, so the timeline hides them until then (T3 `9fb449232`).
 */
export function setRuntimeQueuedFollowUps(conversationId: string, messageIds: readonly string[]): void {
  const prior = queuedFollowUps.get(conversationId) ?? EMPTY_IDS;
  if (prior.length === messageIds.length && prior.every((id, index) => id === messageIds[index])) return;
  if (messageIds.length === 0) queuedFollowUps.delete(conversationId);
  else queuedFollowUps.set(conversationId, [...messageIds]);
  window.dispatchEvent(new CustomEvent(RUNTIME_QUEUED_FOLLOW_UPS_CHANGED, { detail: conversationId }));
}

function subscribeQueuedFollowUps(onChange: () => void): () => void {
  window.addEventListener(RUNTIME_QUEUED_FOLLOW_UPS_CHANGED, onChange);
  return () => window.removeEventListener(RUNTIME_QUEUED_FOLLOW_UPS_CHANGED, onChange);
}

export function useRuntimeQueuedFollowUps(conversationId: string | null): readonly string[] {
  return useSyncExternalStore(subscribeQueuedFollowUps, useCallback(
    () => (conversationId ? queuedFollowUps.get(conversationId) : undefined) ?? EMPTY_IDS, [conversationId]));
}
