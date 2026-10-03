import type { AppSettings } from "@shared/contracts";
import { QUOTA_WARNING_THRESHOLDS, type QuotaWarningThreshold } from "@shared/quota-warnings";
import { SettingSelect, SettingSwitch } from "./SettingControls";

type Update = (settings: Partial<AppSettings>) => Promise<void>;

const QUOTA_WARNING_OPTIONS = QUOTA_WARNING_THRESHOLDS.map((threshold) => ({
  value: String(threshold) as `${QuotaWarningThreshold}`,
  label: `${threshold}% remaining`,
}));

export function BackgroundNotificationSetting({
  settings,
  disabled,
  onUpdate,
}: {
  settings: Pick<AppSettings, "desktopNotifications" | "notifyOnlyInBackground">;
  disabled: boolean;
  onUpdate: Update;
}): React.JSX.Element {
  return (
    <SettingSwitch
      id="notify-only-in-background"
      title="Only when Inertia is in the background"
      checked={settings.notifyOnlyInBackground}
      disabled={disabled}
      inactive={!settings.desktopNotifications}
      onChange={(notifyOnlyInBackground) => onUpdate({ notifyOnlyInBackground })}
    />
  );
}

export function QuotaWarningSettings({
  warnings,
  disabled,
  onUpdate,
}: {
  warnings: AppSettings["quotaWarnings"];
  disabled: boolean;
  onUpdate: Update;
}): React.JSX.Element {
  return (
    <>
      <SettingSwitch
        id="quota-warnings"
        title="Quota warnings"
        checked={warnings.enabled}
        disabled={disabled}
        onChange={(enabled) => onUpdate({ quotaWarnings: { ...warnings, enabled } })}
      />
      <SettingSelect
        id="quota-warning-threshold"
        title="Warn when below"
        value={`${warnings.firstThreshold}`}
        options={QUOTA_WARNING_OPTIONS}
        disabled={disabled}
        inactive={!warnings.enabled}
        onChange={(value) => onUpdate({ quotaWarnings: { ...warnings, firstThreshold: Number(value) as QuotaWarningThreshold } })}
      />
    </>
  );
}
