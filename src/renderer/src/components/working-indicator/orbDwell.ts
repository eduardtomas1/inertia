import type { OrbDesign } from "@shared/working-indicator";

export const ORB_MIN_DWELL_MS = 520;
export const ORB_SETTLE_MS = 140;
export const ORB_CROSSFADE_MS = 160;

export interface OrbDwellState {
  shown: OrbDesign;
  previous: OrbDesign | null;
  switchedAt: number;
  target: OrbDesign;
  targetSince: number;
}

export function createOrbDwell(design: OrbDesign, now: number): OrbDwellState {
  return { shown: design, previous: null, switchedAt: now, target: design, targetSince: now };
}

export function requestOrbDesign(
  state: OrbDwellState,
  design: OrbDesign,
  now: number,
): OrbDwellState {
  if (design === state.target) return state;
  return { ...state, target: design, targetSince: now };
}

export function orbDwellDeadline(state: OrbDwellState): number | null {
  if (state.target === state.shown) return null;
  return Math.max(state.targetSince + ORB_SETTLE_MS, state.switchedAt + ORB_MIN_DWELL_MS);
}

export function advanceOrbDwell(state: OrbDwellState, now: number): OrbDwellState {
  const deadline = orbDwellDeadline(state);
  if (deadline === null || now < deadline) return state;
  return {
    shown: state.target,
    previous: state.shown,
    switchedAt: now,
    target: state.target,
    targetSince: state.targetSince,
  };
}

export function orbCrossfade(
  state: OrbDwellState,
  now: number,
  reducedMotion: boolean,
): { previous: OrbDesign | null; progress: number } {
  if (reducedMotion || state.previous === null || state.previous === state.shown) {
    return { previous: null, progress: 1 };
  }
  const progress = (now - state.switchedAt) / ORB_CROSSFADE_MS;
  return progress >= 1 ? { previous: null, progress: 1 } : { previous: state.previous, progress: Math.max(0, progress) };
}
