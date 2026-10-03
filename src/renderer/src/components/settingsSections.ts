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
import type { SettingsSectionContext } from "./settings/settingsTypes";
import {
  loadAttachmentStorageSettings,
  loadLifecycleIntegritySettings,
  loadMascotSettings,
  loadModelBackendsSettings,
} from "./settingsSectionLoaders";

export interface SettingsRowMetadata {
  id: string;
  title: string;
  keywords: readonly string[];
  group: string;
}

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

function rows(group: string, entries: ReadonlyArray<readonly [string, string, readonly string[]]>): SettingsRowMetadata[] {
  return entries.map(([id, title, keywords]) => ({ id, title, keywords, group }));
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  defineSection({
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    load: staticSection(AppearanceSettings),
    prefetch: [],
    rows: [
      ...rows("Theme", [["appearance-mode", "Theme", ["appearance", "light", "dark", "system", "colour", "color", "custom colours", "palette"]]]),
      ...rows("Scale and density", [
        ["interface-scale", "Interface scale", ["zoom", "size", "text size"]],
        ["response-density", "Text density", ["spacing", "type size", "response density"]],
      ]),
      ...rows("Working indicator", [
        ["working-indicator", "Working indicator", ["agent activity", "animation", "orb", "glow", "speed", "colour"]],
        ["working-indicator-activity", "Animate tool and step activity", ["automatic", "subagents"]],
      ]),
    ],
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    id: "chats",
    label: "Chats",
    icon: MessagesSquare,
    load: staticSection(ChatsSettings),
    prefetch: [],
    rows: [
      ...rows("New chats", [
        ["new-chat-model", "Model", ["default model", "default provider", "backend", "new chat defaults"]],
        ["new-chat-reasoning", "Reasoning", ["default reasoning", "effort"]],
        ["new-chat-work-mode", "Work mode", ["build", "plan", "mode"]],
        ["new-chat-access", "Access", ["supervised", "auto-accept edits", "full access", "permissions"]],
        ["new-chat-location", "Where new chats run", ["worktree", "checkout", "chat location", "workspace default"]],
      ]),
      ...rows("Transcript", [
        ["thinking-summaries", "Show reasoning summaries", ["thinking", "reasoning"]],
        ["collapse-work-log", "Collapse completed work logs", ["tool activity"]],
        ["jump-to-answers", "Scroll to the start of new answers", ["scroll", "final answer"]],
        ["message-timestamps", "Message timestamps", ["time"]],
        ["changed-file-summaries", "Show changed files after each turn", ["files", "summary"]],
        ["code-wrap", "Wrap code by default", ["code blocks"]],
        ["auto-open-plan", "Open plan automatically", ["plan panel"]],
        ["confirm-destructive-actions", "Confirm destructive actions", ["delete", "warning"]],
        ["usage-display", "Usage display", ["quota", "tokens", "limits", "context"]],
      ]),
      ...rows("Review and terminal", [
        ["wrap-diffs", "Wrap long diff lines", ["diff", "wrap"]],
        ["ignore-whitespace", "Ignore whitespace", ["diff", "whitespace"]],
        ["terminal-font-size", "Terminal font size", ["text size"]],
      ]),
    ],
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
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    load: sectionAfter(NotificationsSettings, loadMascotSettings),
    prefetch: [],
    rows: [
      ...rows("Alerts", [["desktop-notifications", "Desktop notifications", ["alerts"]]]),
      ...rows("Sound", [["completion-sound", "Sound when a task ends", ["sounds", "chime", "audio", "long tasks"]]]),
      ...rows("Desktop mascot", [["desktop-mascot", "Desktop mascot", ["companion", "sprites"]]]),
    ],
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    id: "keyboard",
    label: "Keyboard",
    icon: Keyboard,
    load: staticSection(KeyboardSettings),
    prefetch: [],
    rows: [
      ...rows("App shortcuts", [
        ["shortcut-search", "Search everything", ["command palette", "shortcut"]],
        ["shortcut-new-chat", "New chat", ["shortcut"]],
        ["shortcut-toggle-sidebar", "Toggle project navigation", ["sidebar", "shortcut"]],
        ["shortcut-toggle-terminal", "Toggle terminal", ["shortcut"]],
        ["open-settings", "Open settings", ["preferences", "comma"]],
        ["reset-shortcuts", "Reset shortcuts", ["keyboard defaults"]],
      ]),
      ...rows("Global shortcut", [["snapshot-shortcut", "Window snapshot", ["capture", "screenshot", "shortcut"]]]),
    ],
    select: (context) => ({
      keybindings: context.settings.keybindings,
      disabled: context.disabled,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    id: "projects",
    label: "Projects",
    icon: FolderOpen,
    load: lazySection(async () => (await import("./ProjectSettings")).ProjectSettings),
    prefetch: [],
    rows: [
      ...rows("All projects", [
        ["project-grouping", "Group projects", ["repository", "folder", "grouping"]],
        ["compact-sidebar", "Compact sidebar", ["sidebar", "density", "navigation"]],
      ]),
      ...rows("Project", [
        ["project-name", "Name", ["rename project"]],
        ["project-icon", "Project icon", ["image", "symbol"]],
        ["project-colour", "Project colour", ["color", "tint"]],
        ["project-colour-emphasis", "Colour shows on", ["color"]],
        ["project-pin", "Pin to top", ["favourite"]],
        ["project-model", "Model", ["default model", "override"]],
        ["project-workspace", "Where new chats run", ["worktree", "checkout", "workspace"]],
        ["project-auto-pull", "Automatically pull", ["git", "branch"]],
        ["project-browser-access", "Agent browser access", ["preview browser"]],
        ["project-spend-limit", "Claude spend limit per turn", ["budget", "cost", "usd"]],
        ["project-grouping-override", "Group this project", ["repository"]],
        ["project-actions", "Actions", ["commands", "scripts"]],
        ["project-remove", "Remove project", ["delete project"]],
      ]),
    ],
    select: (context) => ({
      initialProjectId: context.target?.section === "projects" ? context.target.projectId : undefined,
      projects: context.regularProjects,
      conversations: context.conversations,
      providers: context.providers,
      settings: context.settings,
      backendDefaults: context.backendDefaults,
      backendProfiles: context.backendProfiles,
      disabled: context.disabled,
      request: context.onReportCommand,
      onUpdateSettings: context.onUpdate,
    }),
    instanceKey: (context) => context.target?.section === "projects" ? context.target.projectId ?? "all" : "all",
  }),
  defineSection({
    id: "agents",
    label: "Agents",
    icon: Bot,
    contentClassName: "is-providers",
    load: sectionAfter(AgentsSettings, () => Promise.all([loadModelBackendsSettings(), loadLifecycleIntegritySettings()])),
    prefetch: [],
    rows: [
      ...rows("Providers", [
        ["provider-accounts", "Providers", ["agents", "accounts", "connect", "refresh", "codex", "claude"]],
        ["provider-display-name", "Account name", ["alias", "display name"]],
        ["provider-binary-path", "Executable", ["binary path", "codex path", "use automatic"]],
        ["provider-updates", "Provider updates", ["maintenance", "upgrade"]],
      ]),
      ...rows("Custom backends", [
        ["model-backends", "Custom backends", ["model backends", "api key", "openai compatible", "profiles", "endpoint"]],
      ]),
    ],
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
    id: "devices",
    label: "Devices & integrations",
    icon: MonitorSmartphone,
    load: sectionAfter(DevicesSettings, loadDevicesSections),
    prefetch: [],
    rows: [
      ...rows("Private Connect", [
        ["private-connect", "Private Connect", ["phone", "remote", "tailscale", "pairing"]],
        ["paired-devices", "Paired devices", ["phone access", "devices"]],
      ]),
      ...rows("Snapshots", [
        ["snapshots-enabled", "Window snapshots", ["screenshot", "capture"]],
        ["snapshot-access", "Capture access", ["permissions", "accessibility", "screen recording"]],
      ]),
      ...rows("Discord", [
        ["discord-repository", "Repository URL", ["github", "gitlab", "release"]],
        ["discord-webhook", "Webhook URL", ["discord webhook"]],
        ["discord-release", "Post release to Discord", ["post release", "generate", "announce"]],
      ]),
    ],
    select: (context) => ({
      projects: context.regularProjects,
      disabled: context.disabled,
      repositoryUrl: context.settings.discordReleaseRepositoryUrl,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    id: "data",
    label: "Data",
    icon: Database,
    load: sectionAfter(DataSettings, loadAttachmentStorageSettings),
    prefetch: [],
    rows: [
      ...rows("Storage", [
        ["resource-health", "Local resource health", ["memory", "storage", "browser cache", "clear cache", "where my data is"]],
        ["database-backup", "Full local database backup", ["backups"]],
        ["attachment-storage", "Attachment storage", ["disk", "files"]],
        ["attachment-storage-limit", "Attachment storage limit", ["budget", "disk"]],
        ["attachment-auto-remove", "Free space automatically when full", ["cleanup", "evict"]],
        ["attachment-remove-oldest", "Remove oldest files", ["cleanup", "delete attachments"]],
      ]),
      ...rows("Export and import", [["recovery-export", "Portable conversation recovery export", ["import", "export"]]]),
      ...rows("Archived chats", [["archived-threads", "Archived chats", ["restore chat", "archive", "unarchive"]]]),
      ...rows("Defaults", [["restore-defaults", "Restore defaults", ["reset", "factory"]]]),
    ],
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      providers: context.providers,
      archived: context.archived,
      databaseBackup: context.databaseBackup,
      onReportCommand: context.onReportCommand,
      onUpdate: context.onUpdate,
      onUnarchive: context.onUnarchive,
      onRestoreDefaults: context.onRestoreDefaults,
    }),
  }),
  defineSection({
    id: "help",
    label: "Help",
    icon: LifeBuoy,
    contentClassName: "is-diagnostics",
    load: sectionAfter(HelpSettings, loadHelpSections),
    prefetch: [],
    rows: [
      ...rows("Report an issue", [["report-issue", "Report an issue", ["bug", "feedback", "github issue"]]]),
      ...rows("Diagnostics", [["diagnostics-incidents", "Diagnostics", ["errors", "incidents", "problems", "export diagnostics"]]]),
      ...rows("Support", [
        ["runtime-diagnostics", "Support summary and logs", ["support summary", "logs", "runtime diagnostics"]],
        ["welcome-guide", "Welcome guide", ["tour", "onboarding"]],
      ]),
      ...rows("About and updates", [["app-updates", "About and updates", ["version", "check for updates", "release", "canary"]]]),
    ],
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
