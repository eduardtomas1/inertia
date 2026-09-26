import type { ActiveTurn } from "./turn-controller-types";

export interface TurnOwnerIdentity {
  turnId: string;
  runId: string;
}

export function activeTurnIdentity(active: ActiveTurn | undefined): TurnOwnerIdentity | null {
  return active && !active.runState.isTerminal()
    ? { turnId: active.turn.id, runId: active.turn.runId }
    : null;
}

export function sameTurnOwner(current: TurnOwnerIdentity | null, expected: TurnOwnerIdentity): boolean {
  return current?.turnId === expected.turnId && current.runId === expected.runId;
}
