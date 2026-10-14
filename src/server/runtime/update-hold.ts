export const UPDATE_HOLD_MESSAGE = "Inertia is updating.";
export const UPDATE_HOLD_SAFETY_RELEASE_MS = 10 * 60_000;

let held = false;
let generation = 0;
let safetyRelease: ReturnType<typeof setTimeout> | null = null;
let onRelease: (() => void) | null = null;

export function hold(released?: () => void): number {
  if (safetyRelease) clearTimeout(safetyRelease);
  safetyRelease = null;
  held = true;
  onRelease = released ?? null;
  generation += 1;
  return generation;
}

export function scheduleSafetyRelease(): void {
  if (!held) return;
  if (safetyRelease) clearTimeout(safetyRelease);
  safetyRelease = setTimeout(release, UPDATE_HOLD_SAFETY_RELEASE_MS);
  safetyRelease.unref?.();
}

export function release(owner?: number): void {
  if (!held || (owner !== undefined && owner !== generation)) return;
  if (safetyRelease) clearTimeout(safetyRelease);
  safetyRelease = null;
  held = false;
  const released = onRelease;
  onRelease = null;
  released?.();
}

export function isHeld(): boolean {
  return held;
}

export function isAwaitingFinish(): boolean {
  return held && safetyRelease !== null;
}
