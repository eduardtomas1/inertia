import { createSurfaceLoader } from "../utils/surfaceLoader";

export const loadProjectCustomizePanel = createSurfaceLoader(async () => ({
  default: (await import("./ProjectCustomizePanel")).ProjectCustomizePanel,
}));
