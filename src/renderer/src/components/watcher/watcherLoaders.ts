import { createSurfaceLoader } from "../../utils/surfaceLoader";

// Each loader names its chunk after the module it imports: "WatcherDock-*"
// and "WatcherAttachDialog-*" stay out of the first-load routes.
export const loadWatcherDock = createSurfaceLoader(async () => ({
  default: (await import("./WatcherDock")).WatcherDock,
}));

export const loadWatcherAttachDialog = createSurfaceLoader(async () => ({
  default: (await import("./WatcherAttachDialog")).WatcherAttachPresence,
}));

export function prefetchWatcherAttachDialog(): void {
  void loadWatcherAttachDialog();
}
