export const QUOTA_WARNING_THRESHOLDS = [25, 15, 5] as const;

export type QuotaWarningThreshold = (typeof QUOTA_WARNING_THRESHOLDS)[number];

export interface QuotaWarningSettings {
  enabled: boolean;
  firstThreshold: QuotaWarningThreshold;
}

export const DEFAULT_QUOTA_WARNINGS: Readonly<QuotaWarningSettings> = Object.freeze({ enabled: true, firstThreshold: 25 });

export function isQuotaWarningThreshold(value: unknown): value is QuotaWarningThreshold {
  return QUOTA_WARNING_THRESHOLDS.some((threshold) => threshold === value);
}

export function isQuotaWarningSettings(value: unknown): value is QuotaWarningSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 2
    && typeof candidate.enabled === "boolean"
    && isQuotaWarningThreshold(candidate.firstThreshold);
}

export function activeQuotaWarningThresholds(settings: QuotaWarningSettings): readonly QuotaWarningThreshold[] {
  return settings.enabled ? QUOTA_WARNING_THRESHOLDS.filter((threshold) => threshold <= settings.firstThreshold) : [];
}
