import { GitCompareArrows } from "lucide-react";

import type { AppSettings } from "@shared/contracts";
import { SettingSwitch } from "./SettingControls";
import { SettingsGroup } from "./SettingsLayout";

export function SourceControlSettings({
  wrapDiffs,
  ignoreWhitespace,
  disabled,
  onUpdate,
}: {
  wrapDiffs: boolean;
  ignoreWhitespace: boolean;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  return (
    <SettingsGroup title="Changes" description="Keep diffs easy to review." icon={GitCompareArrows}>
      <div className="settings-rows">
        <SettingSwitch
          id="wrap-diffs"
          title="Wrap long diff lines"
          description="Read wide changes without horizontal scrolling."
          checked={wrapDiffs}
          disabled={disabled}
          onChange={(next) => onUpdate({ wrapDiffs: next })}
        />
        <SettingSwitch
          id="ignore-whitespace"
          title="Ignore whitespace"
          description="Hide whitespace-only changes when supported."
          checked={ignoreWhitespace}
          disabled={disabled}
          onChange={(next) => onUpdate({ ignoreWhitespace: next })}
        />
      </div>
      <p className="settings-card-note">Git actions always use the current project repository.</p>
    </SettingsGroup>
  );
}
