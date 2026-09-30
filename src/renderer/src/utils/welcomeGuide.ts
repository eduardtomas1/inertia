import { createDialogSwitch } from "./dialogSwitch";

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

const welcomeGuide = createDialogSwitch();

export const subscribeWelcomeGuide = welcomeGuide.subscribe;
export const welcomeGuideIsOpen = welcomeGuide.isOpen;
export const openWelcomeGuide = welcomeGuide.open;
export const closeWelcomeGuide = welcomeGuide.close;
