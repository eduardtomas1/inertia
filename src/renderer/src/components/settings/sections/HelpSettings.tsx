
import type {
  Conversation,
  Project,
  ProviderInfo,
  RuntimeLifecycleDiagnosticSnapshot,
} from "@shared/contracts";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import type { DiagnosticSelection } from "../../../lib/settingsTarget";
import { openWelcomeGuide } from "../../../utils/welcomeGuide";
import type { IssueReportSettingsProps } from "../../IssueReportSettings";
import {
  loadDiagnosticsSettings,
  loadIssueReportSettings,
} from "../../settingsSectionLoaders";
import { AppUpdateSettings, type AppUpdateSettingsProps } from "../AppUpdateSettings";
import { SettingActionRow, SettingsGroup } from "../SettingsLayout";
import { SettingsSectionFallback } from "../SettingsSectionFallback";

export const loadHelpSections = (): Promise<unknown> => Promise.all([
  loadIssueReportSettings(),
  loadDiagnosticsSettings(),
]);

export interface HelpSettingsProps extends AppUpdateSettingsProps {
  disabled: boolean;
  providers: ProviderInfo[];
  projects: Project[];
  conversations: Conversation[];
  selection?: DiagnosticSelection;
  lifecycleDiagnostics?: RuntimeLifecycleDiagnosticSnapshot;
  onReportCommand?: IssueReportSettingsProps["request"];
  onRevealRuntimeLogs: () => Promise<string>;
  onCopyRuntimeDiagnosticReport: () => Promise<{ copied: boolean; eventCount: number }>;
}

export function HelpSettings({
  disabled,
  providers,
  projects,
  conversations,
  selection,
  lifecycleDiagnostics,
  onReportCommand,
  onRevealRuntimeLogs,
  onCopyRuntimeDiagnosticReport,
  ...appUpdate
}: HelpSettingsProps): React.JSX.Element {
  const IssueReportSettings = useLoadedSurface(loadIssueReportSettings, true);
  const DiagnosticsSettings = useLoadedSurface(loadDiagnosticsSettings, true);
  if (!IssueReportSettings || !DiagnosticsSettings) return <SettingsSectionFallback />;
  return (
    <>
      {onReportCommand && (
        <IssueReportSettings providers={providers} disabled={disabled} request={onReportCommand} />
      )}
      <DiagnosticsSettings
        projects={projects}
        conversations={conversations}
        providers={providers}
        selection={selection}
        lifecycleDiagnostics={lifecycleDiagnostics}
        appUpdateStatus={appUpdate.appUpdateStatus}
        onRevealRuntimeLogs={onRevealRuntimeLogs}
        onCopyRuntimeDiagnosticReport={onCopyRuntimeDiagnosticReport}
      />
      <SettingsGroup title="Support" headingId="support-heading">
        <SettingActionRow
          id="welcome-guide"
          className="runtime-log-setting"
          title="Welcome guide"
          description="A quick tour of split view, the Work tab, Duo, review and limits."
          actions={<button type="button" className="secondary-button" onClick={openWelcomeGuide}>Show welcome guide</button>}
        />
      </SettingsGroup>
      <AppUpdateSettings {...appUpdate} />
    </>
  );
}
