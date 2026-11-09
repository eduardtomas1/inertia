import { useCallback, useSyncExternalStore } from "react";

const MAX_TURN_CHOICES = 2_000;

interface TurnChoiceStore {
  subscribe: (listener: () => void) => () => void;
  read: (turnId: string, fallback: boolean) => boolean;
  set: (turnId: string, open: boolean) => void;
  clear: () => void;
}

function createTurnChoiceStore(): TurnChoiceStore {
  const choices = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((listener) => listener());
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const read = (turnId: string, fallback: boolean): boolean => choices.get(turnId) ?? fallback;
  return {
    subscribe,
    read,
    set: (turnId, open) => {
      if (choices.get(turnId) === open) return;
      choices.delete(turnId);
      choices.set(turnId, open);
      if (choices.size > MAX_TURN_CHOICES) {
        const oldest = choices.keys().next().value;
        if (oldest !== undefined) choices.delete(oldest);
      }
      notify();
    },
    clear: () => {
      if (choices.size === 0) return;
      choices.clear();
      notify();
    },
  };
}

function useTurnChoice(store: TurnChoiceStore, turnId: string, fallback: boolean): boolean {
  const current = useCallback(() => store.read(turnId, fallback), [fallback, store, turnId]);
  return useSyncExternalStore(store.subscribe, current, current);
}

const folds = createTurnChoiceStore();
const subagentGroups = createTurnChoiceStore();

export function turnFoldOpen(turnId: string, fallback: boolean): boolean {
  return folds.read(turnId, fallback);
}

export function setTurnFoldOpen(turnId: string, open: boolean): void {
  folds.set(turnId, open);
}

export function clearTurnFoldChoices(): void {
  folds.clear();
  subagentGroups.clear();
}

export function useTurnFoldOpen(turnId: string, fallback: boolean): boolean {
  return useTurnChoice(folds, turnId, fallback);
}

export function setSubagentGroupOpen(turnId: string, open: boolean): void {
  subagentGroups.set(turnId, open);
}

export function useSubagentGroupOpen(turnId: string): boolean {
  return useTurnChoice(subagentGroups, turnId, false);
}
