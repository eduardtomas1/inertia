import { createSurfaceLoader } from "../utils/surfaceLoader";

export const loadUsageLimitsPanel = createSurfaceLoader(async () => ({
  default: (await import("./UsageLimitsPanel")).UsageLimitsPanel,
}));
export const loadUsageLimitsDialog = createSurfaceLoader(async () => ({
  default: (await import("./UsageLimitsPanel")).UsageLimitsDialog,
}));
