import { createSurfaceLoader } from "../../utils/surfaceLoader";

export const loadWatcherDock = createSurfaceLoader(async () => ({
  default: (await import("./WatcherDock")).WatcherDock,
}));

export const loadWatcherAttachDialog = createSurfaceLoader(async () => ({
  default: (await import("./WatcherAttachDialog")).WatcherAttachPresence,
}));

export function prefetchWatcherAttachDialog(): void {
  void loadWatcherAttachDialog();
}
