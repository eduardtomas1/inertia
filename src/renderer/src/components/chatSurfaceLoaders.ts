import { createSurfaceLoader } from "../utils/surfaceLoader";

/** Only the new-chat composer offers an initiative, so detached chats never load it. */
export const loadInitiativePicker = createSurfaceLoader(async () => ({
  default: (await import("./composer/InitiativePicker")).InitiativePicker,
}));
export const loadModelSourceRail = createSurfaceLoader(() => import("./ModelSourceRail"));
export const loadResponseTimeline = createSurfaceLoader(async () => ({
  default: (await import("./ResponseTimeline")).ResponseTimeline,
}));
