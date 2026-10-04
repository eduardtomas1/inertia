import type { AppSettings, AppSettingsUpdate } from "@shared/contracts";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import { CompletionSoundSettings } from "../../notifications/CompletionSoundSettings";
import { loadMascotSettings } from "../../settingsSectionLoaders";
import { BackgroundNotificationSetting, QuotaWarningSettings } from "../NotificationPreferenceRows";
import { SettingSwitch } from "../SettingControls";
import { SettingsGroup } from "../SettingsLayout";
import { useSettingAction } from "../useSettingAction";

export function NotificationsSettings({
  settings,
  disabled,
  onUpdate,
}: {
  settings: AppSettings;
  disabled: boolean;
  onUpdate: (settings: AppSettingsUpdate) => Promise<void>;
}): React.JSX.Element {
  const MascotSettings = useLoadedSurface(loadMascotSettings, true);
  const showMascotAction = useSettingAction();
  const mascotMotionAction = useSettingAction();
  return (
    <>
      <SettingsGroup title="Alerts" headingId="notifications-heading">
        <div className="settings-rows">
          <SettingSwitch id="desktop-notifications" title="Desktop notifications" description="Completion and attention alerts, without prompt or response text." checked={settings.desktopNotifications} disabled={disabled} onChange={(desktopNotifications) => onUpdate({ desktopNotifications })} />
          <BackgroundNotificationSetting settings={settings} disabled={disabled} onUpdate={onUpdate} />
          <QuotaWarningSettings warnings={settings.quotaWarnings} disabled={disabled} onUpdate={onUpdate} />
        </div>
      </SettingsGroup>
      <SettingsGroup title="Sound" headingId="completion-sound-heading">
        <CompletionSoundSettings settings={settings.completionSound} disabled={disabled} onUpdate={onUpdate} />
      </SettingsGroup>
      <SettingsGroup title="Desktop mascot" headingId="desktop-mascot-heading">
        {MascotSettings && <MascotSettings showAction={showMascotAction} motionAction={mascotMotionAction} />}
      </SettingsGroup>
    </>
  );
}
