import { memo, type ComponentType } from "react";
import {
  Bell,
  Bot,
  Database,
  FolderOpen,
  Keyboard,
  LifeBuoy,
  MessagesSquare,
  MonitorSmartphone,
  Palette,
  type LucideIcon,
} from "lucide-react";

import type { SettingsSection } from "../lib/settingsTarget";
import { createSurfaceLoader, type SurfaceLoader } from "../utils/surfaceLoader";
import { AgentsSettings } from "./settings/sections/AgentsSettings";
import { AppearanceSettings } from "./settings/sections/AppearanceSettings";
import { ChatsSettings } from "./settings/sections/ChatsSettings";
import { DataSettings } from "./settings/sections/DataSettings";
import { DevicesSettings, loadDevicesSections } from "./settings/sections/DevicesSettings";
import { HelpSettings, loadHelpSections } from "./settings/sections/HelpSettings";
import { KeyboardSettings } from "./settings/sections/KeyboardSettings";
import { NotificationsSettings } from "./settings/sections/NotificationsSettings";
import { chosenProjectId } from "./settings/sectionMemory";
import type { SettingsSectionContext } from "./settings/settingsTypes";
import {
  loadAttachmentStorageSettings,
  loadLifecycleIntegritySettings,
  loadMascotSettings,
  loadModelBackendsSettings,
} from "./settingsSectionLoaders";
import { settingsSectionRows, type SettingsRowMetadata } from "./settingsRows";

type SectionLoader<Props> = SurfaceLoader<{ default: ComponentType<Props> }>;

export interface SettingsSectionDefinition {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  contentClassName?: string;
  load: SectionLoader<object>;
  prefetch: readonly SurfaceLoader<unknown>[];
  rows: readonly SettingsRowMetadata[];
  select: (context: SettingsSectionContext) => object;
  instanceKey?: (context: SettingsSectionContext) => string;
}

function defineSection<Props extends object>(definition: Omit<SettingsSectionDefinition, "load" | "select"> & {
  load: SectionLoader<Props>;
  select: (context: SettingsSectionContext) => Props;
}): SettingsSectionDefinition {
  return definition as unknown as SettingsSectionDefinition;
}

function staticSection<Props extends object>(component: ComponentType<Props>): SectionLoader<Props> {
  const loaded = { default: memo(component) as ComponentType<Props> };
  const loader = (() => Promise.resolve(loaded)) as SectionLoader<Props>;
  loader.peek = () => loaded;
  return loader;
}

function sectionAfter<Props extends object>(component: ComponentType<Props>, ready: () => Promise<unknown>): SectionLoader<Props> {
  const loaded = { default: memo(component) as ComponentType<Props> };
  return createSurfaceLoader(async () => {
    await ready();
    return loaded;
  });
}

function lazySection<Props extends object>(load: () => Promise<ComponentType<Props>>): SectionLoader<Props> {
  return createSurfaceLoader(async () => ({ default: memo(await load()) as ComponentType<Props> }));
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  defineSection({
    ...settingsSectionRows("appearance"),
    icon: Palette,
    load: staticSection(AppearanceSettings),
    prefetch: [],
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    ...settingsSectionRows("chats"),
    icon: MessagesSquare,
    load: staticSection(ChatsSettings),
    prefetch: [],
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      providers: context.providers,
      backendProfiles: context.backendProfiles,
      backendDefaults: context.backendDefaults,
      onUpdate: context.onUpdate,
      onSetDefaultModel: context.onSetDefaultModel,
      onSetBackendDefault: context.onSetBackendDefault,
    }),
  }),
  defineSection({
    ...settingsSectionRows("notifications"),
    icon: Bell,
    load: sectionAfter(NotificationsSettings, loadMascotSettings),
    prefetch: [],
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    ...settingsSectionRows("keyboard"),
    icon: Keyboard,
    load: staticSection(KeyboardSettings),
    prefetch: [],
    select: (context) => ({
      keybindings: context.settings.keybindings,
      disabled: context.disabled,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    ...settingsSectionRows("projects"),
    icon: FolderOpen,
    load: lazySection(async () => (await import("./ProjectSettings")).ProjectSettings),
    prefetch: [],
    select: (context) => ({
      initialProjectId: chosenProjectId(context.memory, context.target) ?? undefined,
      target: context.target,
      memory: context.memory,
      projects: context.regularProjects,
      conversations: context.conversations,
      providers: context.providers,
      settings: context.settings,
      backendDefaults: context.backendDefaults,
      backendProfiles: context.backendProfiles,
      disabled: context.disabled,
      request: context.onSaveCommand ?? context.onReportCommand,
      onUpdateSettings: context.onUpdate,
    }),
    instanceKey: (context) => context.target?.section === "projects" ? context.target.projectId ?? "all" : "all",
  }),
  defineSection({
    ...settingsSectionRows("agents"),
    icon: Bot,
    contentClassName: "is-providers",
    load: sectionAfter(AgentsSettings, () => Promise.all([loadModelBackendsSettings(), loadLifecycleIntegritySettings()])),
    prefetch: [],
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      providers: context.providers,
      maintenanceOperations: context.maintenanceOperations,
      maintenanceStatuses: context.maintenanceStatuses,
      onUpdate: context.onUpdate,
      onConnectProvider: context.onConnectProvider,
      onRefreshProvider: context.onRefreshProvider,
      onRefreshProviderMaintenance: context.onRefreshProviderMaintenance,
      onUpdateProvider: context.onUpdateProvider,
      onCancelProviderUpdate: context.onCancelProviderUpdate,
      onOpenProviderUpdateInstructions: context.onOpenProviderUpdateInstructions,
      onChooseCodexBinary: context.onChooseCodexBinary,
      memory: context.memory,
      backendProfiles: context.backendProfiles,
      initialProfileId: context.target?.section === "agents" ? context.target.profileId : undefined,
      onLoadBackendProfile: context.onLoadBackendProfile,
      onCreateBackendProfile: context.onCreateBackendProfile,
      onUpdateBackendProfile: context.onUpdateBackendProfile,
      onSetBackendCredential: context.onSetBackendCredential,
      onClearBackendCredential: context.onClearBackendCredential,
      onProbeBackendProfile: context.onProbeBackendProfile,
      onDeleteBackendProfile: context.onDeleteBackendProfile,
    }),
    instanceKey: (context) => context.target?.section === "agents" ? context.target.profileId ?? "all" : "all",
  }),
  defineSection({
    ...settingsSectionRows("devices"),
    icon: MonitorSmartphone,
    load: sectionAfter(DevicesSettings, loadDevicesSections),
    prefetch: [],
    select: (context) => ({
      projects: context.regularProjects,
      disabled: context.disabled,
      repositoryUrl: context.settings.discordReleaseRepositoryUrl,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    ...settingsSectionRows("data"),
    icon: Database,
    load: sectionAfter(DataSettings, loadAttachmentStorageSettings),
    prefetch: [],
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      providers: context.providers,
      archived: context.archived,
      databaseBackup: context.databaseBackup,
      onReportCommand: context.onSaveCommand ?? context.onReportCommand,
      onUpdate: context.onUpdate,
      onUnarchive: context.onUnarchive,
      onRestoreDefaults: context.onRestoreDefaults,
    }),
  }),
  defineSection({
    ...settingsSectionRows("help"),
    icon: LifeBuoy,
    contentClassName: "is-diagnostics",
    load: sectionAfter(HelpSettings, loadHelpSections),
    prefetch: [],
    select: (context) => ({
      disabled: context.disabled,
      providers: context.providers,
      backendProfiles: context.backendProfiles,
      projects: context.projects,
      regularProjects: context.regularProjects,
      conversations: context.allConversations,
      selection: context.target?.section === "help" ? context.target.selection : undefined,
      lifecycleDiagnostics: context.lifecycleDiagnostics,
      onReportCommand: context.onReportCommand,
      onNavigate: context.onNavigate,
      onRevealRuntimeLogs: context.onRevealRuntimeLogs,
      onCopyRuntimeDiagnosticReport: context.onCopyRuntimeDiagnosticReport,
      appUpdateStatus: context.appUpdateStatus,
      checkingAppUpdate: context.checkingAppUpdate,
      onCheckAppUpdate: context.onCheckAppUpdate,
      onDownloadAppUpdate: context.onDownloadAppUpdate,
      onCancelAppUpdateDownload: context.onCancelAppUpdateDownload,
      onInstallAppUpdate: context.onInstallAppUpdate,
      onOpenAppRelease: context.onOpenAppRelease,
    }),
  }),
];

export function settingsSectionDefinition(section: SettingsSection): SettingsSectionDefinition {
  return SETTINGS_SECTIONS.find(({ id }) => id === section) ?? SETTINGS_SECTIONS[0]!;
}

export function prefetchSettingsSection(definition: SettingsSectionDefinition): void {
  void definition.load();
  for (const loader of definition.prefetch) void loader();
}
