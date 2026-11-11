import { createSurfaceLoader } from "../utils/surfaceLoader";
import { loadUsageLimitsPanel, loadUsageOverview } from "./usage/usageTabLoaders";

export { loadUsageLimitsPanel, loadUsageOverview };
export const loadUsagePopup = createSurfaceLoader(async () => ({
  default: (await import("./usage/UsagePopup")).UsagePopup,
}));

export function preloadUsagePopup(): void {
  void loadUsagePopup();
  void loadUsageLimitsPanel();
  void loadUsageOverview();
}
