import { createSurfaceLoader } from "../../utils/surfaceLoader";

export const loadUsageLimitsPanel = createSurfaceLoader(async () => ({
  default: (await import("../UsageLimitsPanel")).UsageLimitsPanel,
}));
export const loadUsageOverview = createSurfaceLoader(async () => ({
  default: (await import("./UsageOverview")).UsageOverview,
}));
