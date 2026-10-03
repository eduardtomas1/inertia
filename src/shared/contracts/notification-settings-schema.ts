import { isQuotaWarningSettings } from "../quota-warnings";

export function validNotificationSettings(value: Record<string, unknown>): boolean {
  return (value.notifyOnlyInBackground === undefined || typeof value.notifyOnlyInBackground === "boolean")
    && (value.quotaWarnings === undefined || isQuotaWarningSettings(value.quotaWarnings));
}
