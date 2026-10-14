import { createSurfaceLoader } from "../utils/surfaceLoader";

export const loadModelSourceRail = createSurfaceLoader(() => import("./ModelSourceRail"));
export const loadResponseTimeline = createSurfaceLoader(async () => ({
  default: (await import("./ResponseTimeline")).ResponseTimeline,
}));
