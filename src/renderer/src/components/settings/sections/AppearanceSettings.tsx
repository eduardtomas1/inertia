import type { AppSettings } from "@shared/contracts";
import { ThemeLibrary } from "../../ThemeLibrary";
import { WorkingIndicatorSettings } from "../../working-indicator/WorkingIndicatorSettings";
import { SettingRadioGroup, SettingSwitch, type SettingOption } from "../SettingControls";
import { SettingsGroup } from "../SettingsLayout";
import { useSettingAction } from "../useSettingAction";

const INTERFACE_SCALES: readonly SettingOption<AppSettings["interfaceScale"]>[] = [
  { value: "compact", label: "Compact" },
  { value: "default", label: "Default" },
  { value: "comfortable", label: "Comfortable" },
  { value: "large", label: "Large" },
];
const RESPONSE_DENSITIES: readonly SettingOption<AppSettings["responseDensity"]>[] = [
  { value: "compact", label: "Compact" },
  { value: "default", label: "Default" },
  { value: "comfortable", label: "Comfortable" },
];

export function AppearanceSettings({
  settings,
  disabled,
  onUpdate,
}: {
  settings: AppSettings;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  const themeAction = useSettingAction();
  const updateTheme = (update: Partial<AppSettings>): void => {
    void themeAction.run(() => onUpdate(update));
  };
  return (
    <>
      <SettingsGroup title="Theme" titleHidden headingId="appearance-heading" notice={themeAction.notice}>
        <ThemeLibrary settings={settings} disabled={disabled} onUpdate={updateTheme} />
        <SettingSwitch
          id="muted-custom-colours"
          title="Muted colours"
          description="Softens custom colours for a quieter workbench."
          checked={Boolean(settings.mutedCustomColors)}
          disabled={disabled}
          inactive={!settings.lightCustomColor && !settings.darkCustomColor}
          onChange={(mutedCustomColors) => onUpdate({ mutedCustomColors })}
        />
      </SettingsGroup>
      <SettingsGroup title="Scale and density" headingId="interface-scale-heading">
        <SettingRadioGroup
          id="interface-scale"
          title="Interface scale"
          description="Scales navigation, messages, controls, files and diffs. Terminal text stays independent."
          value={settings.interfaceScale}
          options={INTERFACE_SCALES}
          disabled={disabled}
          onChange={(interfaceScale) => onUpdate({ interfaceScale })}
        />
        <SettingRadioGroup
          id="response-density"
          title="Text density"
          description="Spacing and type size of agent responses."
          value={settings.responseDensity}
          options={RESPONSE_DENSITIES}
          disabled={disabled}
          onChange={(responseDensity) => onUpdate({ responseDensity })}
        />
      </SettingsGroup>
      <WorkingIndicatorSettings settings={settings.workingIndicator} disabled={disabled} onUpdate={onUpdate} />
    </>
  );
}
