import type {
  AppSettings,
  AppSettingsUpdate,
  BackendDiscoveredModel,
  Conversation,
  DatabaseBackupStatus,
  ModelBackendDefault,
  ModelBackendProfileCreateDraft,
  ModelBackendProfileDetail,
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
import type { BackendProfileUpdateInput } from "../../lib/backendProfileCommands";
import type { BackendProbeOutcome } from "../../hooks/useBackendProfiles";
import type { ProviderAuthMethod } from "@shared/provider";
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
  onUpdate: (settings: AppSettingsUpdate) => Promise<void>;
  onSetDefaultModel: (update: Pick<AppSettings, "defaultProvider" | "defaultModel" | "defaultReasoningEffort">) => Promise<void>;
  onRestoreDefaults: () => Promise<void>;
  onConnectProvider: (providerId: ProviderId, method?: ProviderAuthMethod) => void;
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
  onOpenConversation?: (conversationId: string) => boolean;
  onLoadBackendProfile: (profileId: string) => Promise<ModelBackendProfileDetail>;
  onCreateBackendProfile: (draft: ModelBackendProfileCreateDraft) => Promise<ModelBackendProfileDetail>;
  onUpdateBackendProfile: (profileId: string, update: BackendProfileUpdateInput) => Promise<ModelBackendProfileDetail>;
  onSetBackendCredential: (profileId: string, secret: string) => Promise<ModelBackendProfileDetail>;
  onClearBackendCredential: (profileId: string) => Promise<ModelBackendProfileDetail>;
  onProbeBackendProfile: (profileId: string, modelIds?: readonly string[]) => Promise<BackendProbeOutcome>;
  onDiscoverBackendModels: (profileId: string) => Promise<BackendDiscoveredModel[]>;
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
