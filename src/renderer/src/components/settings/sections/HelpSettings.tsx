import { Compass } from "lucide-react";

import type {
  Conversation,
  ModelBackendProfileView,
  Project,
  ProviderInfo,
  RuntimeLifecycleDiagnosticSnapshot,
} from "@shared/contracts";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import type { DiagnosticSelection, SettingsSection } from "../../../lib/settingsTarget";
import { openWelcomeGuide } from "../../../utils/welcomeGuide";
import type { IssueReportSettingsProps } from "../../IssueReportSettings";
import {
  loadDiagnosticsSettings,
  loadIssueReportSettings,
  loadLifecycleIntegritySettings,
} from "../../settingsSectionLoaders";
import { AppUpdateSettings, type AppUpdateSettingsProps } from "../AppUpdateSettings";
import { SettingActionRow, SettingsGroup } from "../SettingsLayout";
import { SettingsSectionFallback } from "../SettingsSectionFallback";

export const loadHelpSections = (): Promise<unknown> => Promise.all([
  loadIssueReportSettings(),
  loadDiagnosticsSettings(),
  loadLifecycleIntegritySettings(),
]);

export interface HelpSettingsProps extends AppUpdateSettingsProps {
  disabled: boolean;
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  projects: Project[];
  regularProjects: Project[];
  conversations: Conversation[];
  selection?: DiagnosticSelection;
  lifecycleDiagnostics?: RuntimeLifecycleDiagnosticSnapshot;
  onReportCommand?: IssueReportSettingsProps["request"];
  onNavigate: (section: SettingsSection) => void;
  onRevealRuntimeLogs: () => Promise<string>;
  onCopyRuntimeDiagnosticReport: () => Promise<{ copied: boolean; eventCount: number }>;
}

export function HelpSettings({
  disabled,
  providers,
  backendProfiles,
  projects,
  regularProjects,
  conversations,
  selection,
  lifecycleDiagnostics,
  onReportCommand,
  onNavigate,
  onRevealRuntimeLogs,
  onCopyRuntimeDiagnosticReport,
  ...appUpdate
}: HelpSettingsProps): React.JSX.Element {
  const IssueReportSettings = useLoadedSurface(loadIssueReportSettings, true);
  const DiagnosticsSettings = useLoadedSurface(loadDiagnosticsSettings, true);
  const LifecycleIntegritySettings = useLoadedSurface(loadLifecycleIntegritySettings, true);
  if (!IssueReportSettings || !DiagnosticsSettings || !LifecycleIntegritySettings) return <SettingsSectionFallback />;
  return (
    <>
      {onReportCommand && (
        <IssueReportSettings
          providers={providers}
          backendProfiles={backendProfiles}
          projects={regularProjects}
          disabled={disabled}
          request={onReportCommand}
          onProviderSetup={() => onNavigate("agents")}
        />
      )}
      <DiagnosticsSettings projects={projects} conversations={conversations} providers={providers} selection={selection} />
      <SettingsGroup title="Support" headingId="support-heading">
        <LifecycleIntegritySettings
          surface="runtime-diagnostics"
          diagnostics={lifecycleDiagnostics}
          appUpdateStatus={appUpdate.appUpdateStatus}
          onRevealRuntimeLogs={onRevealRuntimeLogs}
          onCopyRuntimeDiagnosticReport={onCopyRuntimeDiagnosticReport}
        />
        <SettingActionRow
          id="welcome-guide"
          className="runtime-log-setting"
          title="Welcome guide"
          description="A quick tour of split view, the Work tab, Duo, review and limits."
          actions={<button type="button" className="secondary-button" onClick={openWelcomeGuide}><Compass size={14} aria-hidden="true" />Show welcome guide</button>}
        />
      </SettingsGroup>
      <AppUpdateSettings {...appUpdate} />
    </>
  );
}
