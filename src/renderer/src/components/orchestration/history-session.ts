import { useSyncExternalStore } from "react";

export interface StartRollbackRequest {
  readonly conversationId: string;
  readonly sequence: number;
  readonly returnFocus: HTMLElement | null;
}

const listeners = new Set<() => void>();
const offers = new Map<string, number>();
const forks = new Set<string>();
const restoredFiles = new Map<string, string>();
let request: StartRollbackRequest | null = null;
let sequence = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function offerStartRollback(conversationId: string): () => void {
  offers.set(conversationId, (offers.get(conversationId) ?? 0) + 1);
  emit();
  return () => {
    const remaining = (offers.get(conversationId) ?? 1) - 1;
    if (remaining > 0) offers.set(conversationId, remaining);
    else offers.delete(conversationId);
    if (remaining <= 0 && request?.conversationId === conversationId) request = null;
    emit();
  };
}

export function requestStartRollback(conversationId: string, returnFocus: HTMLElement | null): void {
  if (!offers.has(conversationId)) return;
  request = { conversationId, sequence: ++sequence, returnFocus };
  emit();
}

export function closeStartRollback(closed: StartRollbackRequest): void {
  if (request !== closed) return;
  request = null;
  emit();
}

export function noteForkLineage(conversationId: string, fork: boolean): void {
  if (forks.has(conversationId) === fork) return;
  if (fork) forks.add(conversationId);
  else forks.delete(conversationId);
  emit();
}

export function noteRollbackFiles(conversationId: string, restoredTurnId: string | null): void {
  if ((restoredFiles.get(conversationId) ?? null) === restoredTurnId) return;
  if (restoredTurnId) restoredFiles.set(conversationId, restoredTurnId);
  else restoredFiles.delete(conversationId);
  emit();
}

export function useStartRollbackOffered(conversationId: string): boolean {
  return useSyncExternalStore(subscribe, () => offers.has(conversationId));
}

export function useStartRollbackRequest(conversationId: string): StartRollbackRequest | null {
  return useSyncExternalStore(subscribe, () => request?.conversationId === conversationId ? request : null);
}

export function useForkLineage(conversationId: string): boolean {
  return useSyncExternalStore(subscribe, () => forks.has(conversationId));
}

export function useFilesRestored(conversationId: string, turnId: string): boolean {
  return useSyncExternalStore(subscribe, () => restoredFiles.get(conversationId) === turnId);
}
