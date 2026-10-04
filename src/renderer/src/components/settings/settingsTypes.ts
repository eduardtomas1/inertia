import type {
  AppSettings,
  Conversation,
  DatabaseBackupStatus,
  ModelBackendDefault,
  ModelBackendProfileDetail,
  ModelBackendProfileDraft,
  ModelBackendProfileView,
  ModelSelection,
  Project,
  ProviderId,
  ProviderInfo,
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
  RuntimeLifecycleDiagnosticSnapshot,
} from "@shared/contracts";
import type { AppUpdateStatus } from "@shared/desktop";
import type { SettingsSection, SettingsTarget } from "../../lib/settingsTarget";
import type { IssueReportSettingsProps } from "../IssueReportSettings";
import type { SettingsSectionMemory } from "./sectionMemory";

export interface SettingsViewProps {
  onReportCommand?: IssueReportSettingsProps["request"];
  onSaveCommand?: IssueReportSettingsProps["request"];
  target?: SettingsTarget | null;
  initialSection?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  backendDefaults: ModelBackendDefault[];
  projects: Project[];
  conversations: Conversation[];
  archived: Conversation[];
  databaseBackup?: DatabaseBackupStatus;
  lifecycleDiagnostics?: RuntimeLifecycleDiagnosticSnapshot;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
  onSetDefaultModel: (update: Pick<AppSettings, "defaultProvider" | "defaultModel" | "defaultReasoningEffort">) => Promise<void>;
  onRestoreDefaults: () => Promise<void>;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId?: ProviderId) => void;
  maintenanceOperations: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceOperation>;
  maintenanceStatuses: ReadonlyMap<ProviderMaintenanceProviderId, NonNullable<ProviderInfo["maintenance"]>>;
  onRefreshProviderMaintenance: (providerId: ProviderMaintenanceProviderId) => Promise<void>;
  onUpdateProvider: (providerId: ProviderMaintenanceProviderId) => Promise<void>;
  onCancelProviderUpdate: (operationId: string) => Promise<void>;
  onOpenProviderUpdateInstructions: (url: string) => void;
  onChooseCodexBinary: () => void;
  onRevealRuntimeLogs: () => Promise<string>;
  onCopyRuntimeDiagnosticReport: () => Promise<{ copied: boolean; eventCount: number }>;
  appUpdateStatus: AppUpdateStatus | null;
  checkingAppUpdate: boolean;
  onCheckAppUpdate: () => Promise<void>;
  onDownloadAppUpdate: () => Promise<void>;
  onCancelAppUpdateDownload: () => Promise<void>;
  onInstallAppUpdate: () => Promise<void>;
  onOpenAppRelease: () => Promise<void>;
  onUnarchive: (conversation: Conversation) => void;
  onLoadBackendProfile: (profileId: string) => Promise<ModelBackendProfileDetail>;
  onCreateBackendProfile: (draft: ModelBackendProfileDraft) => Promise<ModelBackendProfileDetail>;
  onUpdateBackendProfile: (profileId: string, update: Partial<ModelBackendProfileDraft> & { enabled?: boolean }) => Promise<ModelBackendProfileDetail>;
  onSetBackendCredential: (profileId: string, secret: string) => Promise<ModelBackendProfileDetail>;
  onClearBackendCredential: (profileId: string) => Promise<ModelBackendProfileDetail>;
  onProbeBackendProfile: (profileId: string, modelId: string) => Promise<ModelBackendProfileDetail>;
  onDeleteBackendProfile: (profileId: string) => Promise<void>;
  onSetBackendDefault: (projectId: string | null, selection: ModelSelection) => Promise<void>;
  onClearBackendDefault: (projectId: string | null) => Promise<void>;
}

export interface SettingsSectionContext extends Omit<SettingsViewProps, "target" | "initialSection" | "onSectionChange"> {
  target: SettingsTarget | null;
  regularProjects: Project[];
  allConversations: Conversation[];
  onNavigate: (section: SettingsSection) => void;
  memory: SettingsSectionMemory;
}
