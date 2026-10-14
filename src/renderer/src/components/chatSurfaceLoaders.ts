import { createSurfaceLoader } from "../utils/surfaceLoader";

export const loadModelSourceRail = createSurfaceLoader(() => import("./ModelSourceRail"));
