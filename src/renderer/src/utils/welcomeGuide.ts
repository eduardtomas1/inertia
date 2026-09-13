export const WELCOME_GUIDE_STORAGE_KEY = "inertia:welcome-guide:v1";

export type WelcomeGuideGate = "open" | "mark-seen" | "wait";

export interface WelcomeShortcut {
  keys: string;
  label: string;
}

export function readWelcomeGuideSeen(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(WELCOME_GUIDE_STORAGE_KEY) !== null;
  } catch {
    return true;
  }
}

export function markWelcomeGuideSeen(storage: Pick<Storage, "setItem">): void {
  try {
    storage.setItem(WELCOME_GUIDE_STORAGE_KEY, new Date().toISOString());
  } catch {
    return;
  }
}

export function welcomeGuideGate({
  seen,
  projectCount,
  blocked,
  existingProfile,
}: {
  seen: boolean;
  projectCount: number | null;
  blocked: boolean;
  existingProfile: boolean;
}): WelcomeGuideGate {
  if (seen || projectCount === null) return "wait";
  if (projectCount > 0 || existingProfile) return "mark-seen";
  return blocked ? "wait" : "open";
}

const listeners = new Set<() => void>();
let open = false;

function publish(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function subscribeWelcomeGuide(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function welcomeGuideIsOpen(): boolean {
  return open;
}

export function openWelcomeGuide(): void {
  publish(true);
}

export function closeWelcomeGuide(): void {
  publish(false);
}
