import { Compass, Database } from "lucide-react";

import type { ModelBackendProfileView, Project, ProviderInfo } from "@shared/contracts";
import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import type { SettingsSection } from "../../lib/settingsTarget";
import { openWelcomeGuide } from "../../utils/welcomeGuide";
import type { IssueReportSettingsProps } from "../IssueReportSettings";
import { loadIssueReportSettings } from "../settingsSectionLoaders";
import { SettingsGroup } from "./SettingsLayout";

export interface SupportSettingsProps {
  disabled: boolean;
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  projects: Project[];
  onReportCommand?: IssueReportSettingsProps["request"];
  onNavigate: (section: SettingsSection) => void;
}

export function SupportSettings({
  disabled,
  providers,
  backendProfiles,
  projects,
  onReportCommand,
  onNavigate,
}: SupportSettingsProps): React.JSX.Element {
  const IssueReportSettings = useLoadedSurface(loadIssueReportSettings, true);
  return (
    <>
      <SettingsGroup title="Storage & backups" headingId="storage-support-heading" description="Check local usage, retention and the last validated backup." icon={Database}>
        <div className="settings-toolbar">
          <button type="button" className="secondary-button" onClick={() => onNavigate("archive")}><Database size={14} />View storage & backups</button>
        </div>
      </SettingsGroup>
      <SettingsGroup title="Welcome guide" headingId="welcome-guide-heading" description="Replay the quick tour of split view, the Work tab, Duo, review and limits." icon={Compass}>
        <div className="settings-toolbar" data-setting-id="welcome-guide">
          <button type="button" className="secondary-button" onClick={openWelcomeGuide}><Compass size={14} />Show welcome guide</button>
        </div>
      </SettingsGroup>
      {onReportCommand && IssueReportSettings && (
        <IssueReportSettings
          providers={providers}
          backendProfiles={backendProfiles}
          projects={projects}
          disabled={disabled}
          request={onReportCommand}
          onProviderSetup={() => onNavigate("providers")}
        />
      )}
    </>
  );
}
