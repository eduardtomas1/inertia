import { USAGE_RANGE_DAYS, type UsageRangeDays } from "@shared/contracts/usage-dashboard";

import type { UsagePopupTab } from "../usage-limits-state";

export const USAGE_POPUP_PREFERENCES_KEY = "inertia:usage-popup-preferences:v1";
const USAGE_POPUP_TABS: readonly UsagePopupTab[] = ["cost", "tokens", "limits"];

export interface UsagePopupPreferences {
  tab: UsagePopupTab;
  days: UsageRangeDays;
  hiddenProviders: string[];
}

export const DEFAULT_USAGE_POPUP_PREFERENCES: UsagePopupPreferences = {
  tab: "limits",
  days: 30,
  hiddenProviders: [],
};

export function readUsagePopupPreferences(): UsagePopupPreferences {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(USAGE_POPUP_PREFERENCES_KEY) ?? "null");
    if (!stored || typeof stored !== "object") return DEFAULT_USAGE_POPUP_PREFERENCES;
    const { tab, days, hiddenProviders } = stored as Record<string, unknown>;
    return {
      tab: USAGE_POPUP_TABS.find((candidate) => candidate === tab) ?? DEFAULT_USAGE_POPUP_PREFERENCES.tab,
      days: USAGE_RANGE_DAYS.find((candidate) => candidate === days) ?? DEFAULT_USAGE_POPUP_PREFERENCES.days,
      hiddenProviders: Array.isArray(hiddenProviders)
        ? hiddenProviders.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200).slice(0, 64)
        : [],
    };
  } catch {
    return DEFAULT_USAGE_POPUP_PREFERENCES;
  }
}

export function writeUsagePopupPreferences(preferences: UsagePopupPreferences): void {
  try {
    window.localStorage.setItem(USAGE_POPUP_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    return;
  }
}
