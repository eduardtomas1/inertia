import { memo, type ComponentType } from "react";
import {
  Activity,
  ArchiveRestore,
  Bot,
  Bug,
  FolderOpen,
  GitCompareArrows,
  Keyboard,
  Laptop,
  MessageSquare,
  PanelLeft,
  Scan,
  ServerCog,
  type LucideIcon,
} from "lucide-react";

import type { SettingsSection } from "../lib/settingsTarget";
import { createSurfaceLoader, type SurfaceLoader } from "../utils/surfaceLoader";
import { ArchiveDataSettings } from "./settings/ArchiveDataSettings";
import { GeneralSettings } from "./settings/GeneralSettings";
import { KeybindingsSettings } from "./settings/KeybindingsSettings";
import { ProvidersSettings } from "./settings/ProvidersSettings";
import { SourceControlSettings } from "./settings/SourceControlSettings";
import { SupportSettings } from "./settings/SupportSettings";
import type { SettingsSectionContext } from "./settings/settingsTypes";
import {
  loadAttachmentStorageSettings,
  loadLifecycleIntegritySettings,
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

function lazySection<Props extends object>(load: () => Promise<ComponentType<Props>>): SectionLoader<Props> {
  return createSurfaceLoader(async () => ({ default: memo(await load()) as ComponentType<Props> }));
}

function rows(group: string, entries: ReadonlyArray<readonly [string, string, readonly string[]]>): SettingsRowMetadata[] {
  return entries.map(([id, title, keywords]) => ({ id, title, keywords, group }));
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  defineSection({
    id: "general",
    label: "General",
    icon: PanelLeft,
    load: staticSection(GeneralSettings),
    prefetch: [],
    rows: [
      ...rows("General", [["restore-defaults", "Restore defaults", ["reset", "factory"]]]),
      ...rows("Appearance", [
        ["appearance-mode", "Appearance", ["theme", "light", "dark", "system", "colour", "color", "custom colours"]],
        ["interface-scale", "Interface scale", ["zoom", "size", "text size"]],
        ["working-indicator", "Working indicator", ["agent activity", "animation", "orb", "glow", "speed"]],
      ]),
      ...rows("Workspace", [
        ["project-grouping", "Logical project grouping", ["repository", "folder"]],
        ["compact-sidebar", "Compact project navigation", ["sidebar", "density"]],
        ["message-timestamps", "Message timestamps", ["time"]],
        ["thinking-summaries", "Live thinking summaries", ["reasoning"]],
        ["auto-open-plan", "Open plan automatically", ["plan panel"]],
        ["desktop-mascot", "Desktop mascot", ["companion", "sprites"]],
        ["confirm-destructive-actions", "Confirm destructive actions", ["delete", "warning"]],
        ["usage-display", "Usage and context", ["quota", "tokens", "limits"]],
      ]),
      ...rows("Notifications", [
        ["desktop-notifications", "Desktop notifications", ["alerts"]],
        ["completion-sound", "Sound when a task ends", ["sounds", "chime", "audio"]],
      ]),
      ...rows("Agent responses", [
        ["response-density", "Response density", ["spacing", "type size"]],
        ["code-wrap", "Wrap code by default", ["code blocks"]],
        ["collapse-work-log", "Collapse completed work logs", ["tool activity"]],
        ["changed-file-summaries", "Changed-file summaries", ["files"]],
        ["jump-to-answers", "Jump to completed answers", ["scroll"]],
      ]),
      ...rows("Terminal", [["terminal-font-size", "Terminal font size", ["text size"]]]),
      ...rows("Application updates", [["app-updates", "Application updates", ["version", "check for updates", "release", "canary"]]]),
    ],
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      onUpdate: context.onUpdate,
      appUpdateStatus: context.appUpdateStatus,
      checkingAppUpdate: context.checkingAppUpdate,
      onCheckAppUpdate: context.onCheckAppUpdate,
      onDownloadAppUpdate: context.onDownloadAppUpdate,
      onCancelAppUpdateDownload: context.onCancelAppUpdateDownload,
      onInstallAppUpdate: context.onInstallAppUpdate,
      onOpenAppRelease: context.onOpenAppRelease,
    }),
  }),
  defineSection({
    id: "snapshots",
    label: "Snapshots",
    icon: Scan,
    load: lazySection(async () => (await import("./SnapshotSettings")).SnapshotSettings),
    prefetch: [],
    rows: rows("Snapshots", [
      ["snapshots-enabled", "Enable Snapshots", ["screenshot", "capture"]],
      ["snapshot-shortcut", "Capture shortcut", ["keyboard", "screenshot"]],
      ["snapshot-access", "Capture access", ["permissions", "accessibility", "screen recording"]],
    ]),
    select: () => ({}),
  }),
  defineSection({
    id: "projects",
    label: "Projects",
    icon: FolderOpen,
    load: lazySection(async () => (await import("./ProjectSettings")).ProjectSettings),
    prefetch: [],
    rows: rows("Projects", [
      ["project-workspace-default", "Workspace default", ["worktree", "checkout", "chat location"]],
      ["project-name", "Name", ["rename project"]],
      ["project-icon", "Project icon", ["image", "symbol"]],
      ["project-colour", "Project colour", ["color", "tint"]],
      ["project-colour-emphasis", "Colour shows on", ["color"]],
      ["project-pin", "Pin to top", ["favourite"]],
      ["project-model", "Model", ["default model"]],
      ["project-workspace", "Workspace", ["worktree", "checkout"]],
      ["project-auto-pull", "Automatically pull", ["git", "branch"]],
      ["project-browser-access", "Agent browser access", ["preview browser"]],
      ["project-spend-limit", "Claude spend limit per turn", ["budget", "cost", "usd"]],
      ["project-grouping-override", "Project grouping", ["repository"]],
      ["project-actions", "Actions", ["commands", "scripts"]],
      ["project-remove", "Remove project", ["delete project"]],
    ]),
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
    id: "providers",
    label: "Providers",
    icon: Bot,
    contentClassName: "is-providers",
    load: staticSection(ProvidersSettings),
    prefetch: [loadLifecycleIntegritySettings],
    rows: [
      ...rows("Providers", [
        ["provider-accounts", "Providers", ["agents", "accounts", "connect", "refresh", "codex", "claude"]],
        ["provider-display-name", "Display name", ["alias", "account name"]],
        ["provider-binary-path", "Binary path", ["executable", "codex path", "use automatic"]],
        ["provider-updates", "Provider updates", ["maintenance", "upgrade"]],
      ]),
      ...rows("Advanced", [
        ["new-chat-defaults", "New chat defaults", ["default provider", "default model", "reasoning", "mode", "access", "chat location"]],
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
    }),
  }),
  defineSection({
    id: "backends",
    label: "Model backends",
    icon: ServerCog,
    contentClassName: "is-backends",
    load: lazySection(async () => (await import("./ModelBackendsSettings")).ModelBackendsSettings),
    prefetch: [],
    rows: rows("Model backends", [
      ["model-backends", "Model backends", ["custom backend", "api key", "openai compatible", "profiles"]],
    ]),
    select: (context) => ({
      profiles: context.backendProfiles,
      initialProfileId: context.target?.section === "backends" ? context.target.profileId : undefined,
      defaults: context.backendDefaults,
      projects: context.regularProjects,
      disabled: context.disabled,
      onLoadDetail: context.onLoadBackendProfile,
      onCreate: context.onCreateBackendProfile,
      onUpdate: context.onUpdateBackendProfile,
      onSetCredential: context.onSetBackendCredential,
      onClearCredential: context.onClearBackendCredential,
      onProbe: context.onProbeBackendProfile,
      onDelete: context.onDeleteBackendProfile,
      onSetDefault: context.onSetBackendDefault,
      onClearDefault: context.onClearBackendDefault,
    }),
  }),
  defineSection({
    id: "connections",
    label: "Connections & devices",
    icon: Laptop,
    load: lazySection(async () => (await import("./ConnectionsAndDevicesSettings")).ConnectionsAndDevicesSettings),
    prefetch: [],
    rows: rows("Connections & devices", [
      ["private-connect", "Private Connect", ["phone", "remote", "tailscale", "pairing"]],
      ["paired-devices", "Paired devices", ["phone access", "devices"]],
    ]),
    select: (context) => ({ projects: context.regularProjects }),
  }),
  defineSection({
    id: "discord",
    label: "Discord",
    icon: MessageSquare,
    load: lazySection(async () => (await import("./DiscordSettings")).DiscordSettings),
    prefetch: [],
    rows: rows("Discord", [
      ["discord-repository", "Repository URL", ["github", "gitlab", "release"]],
      ["discord-webhook", "Webhook URL", ["discord webhook"]],
      ["discord-release", "Release info", ["post release", "generate"]],
    ]),
    select: (context) => ({
      disabled: context.disabled,
      repositoryUrl: context.settings.discordReleaseRepositoryUrl,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    id: "diagnostics",
    label: "Diagnostics",
    icon: Activity,
    contentClassName: "is-diagnostics",
    load: lazySection(async () => (await import("./DiagnosticsSettings")).DiagnosticsSettings),
    prefetch: [],
    rows: rows("Diagnostics", [
      ["diagnostics-incidents", "Incidents", ["errors", "logs", "problems", "export diagnostics"]],
    ]),
    select: (context) => ({
      projects: context.projects,
      conversations: context.allConversations,
      providers: context.providers,
      selection: context.target?.section === "diagnostics" ? context.target.selection : undefined,
    }),
  }),
  defineSection({
    id: "source",
    label: "Source control",
    icon: GitCompareArrows,
    load: staticSection(SourceControlSettings),
    prefetch: [],
    rows: rows("Changes", [
      ["wrap-diffs", "Wrap long diff lines", ["diff", "wrap"]],
      ["ignore-whitespace", "Ignore whitespace", ["diff", "whitespace"]],
    ]),
    select: (context) => ({
      wrapDiffs: context.settings.wrapDiffs,
      ignoreWhitespace: context.settings.ignoreWhitespace,
      disabled: context.disabled,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    id: "keybindings",
    label: "Keybindings",
    icon: Keyboard,
    load: staticSection(KeybindingsSettings),
    prefetch: [],
    rows: rows("Keyboard shortcuts", [
      ["shortcut-search", "Search everything", ["command palette", "shortcut"]],
      ["shortcut-new-chat", "New chat", ["shortcut"]],
      ["shortcut-toggle-sidebar", "Toggle project navigation", ["sidebar", "shortcut"]],
      ["shortcut-toggle-terminal", "Toggle terminal", ["shortcut"]],
      ["reset-shortcuts", "Reset shortcuts", ["keyboard defaults"]],
      ["open-settings", "Open settings", ["preferences", "comma"]],
    ]),
    select: (context) => ({
      keybindings: context.settings.keybindings,
      disabled: context.disabled,
      onUpdate: context.onUpdate,
    }),
  }),
  defineSection({
    id: "support",
    label: "Report an issue",
    icon: Bug,
    contentClassName: "is-issue-report",
    load: staticSection(SupportSettings),
    prefetch: [],
    rows: rows("Help", [
      ["welcome-guide", "Welcome guide", ["tour", "onboarding"]],
      ["report-issue", "Report an issue", ["bug", "feedback", "github issue"]],
    ]),
    select: (context) => ({
      disabled: context.disabled,
      providers: context.providers,
      backendProfiles: context.backendProfiles,
      projects: context.regularProjects,
      onReportCommand: context.onReportCommand,
      onNavigate: context.onNavigate,
    }),
  }),
  defineSection({
    id: "archive",
    label: "Archive & data",
    icon: ArchiveRestore,
    load: staticSection(ArchiveDataSettings),
    prefetch: [loadAttachmentStorageSettings, loadLifecycleIntegritySettings],
    rows: rows("Archive & data", [
      ["archived-threads", "Archived threads", ["restore chat", "archive"]],
      ["resource-health", "Local resource health", ["memory", "storage", "browser cache"]],
      ["attachment-storage", "Attachment storage", ["disk", "files", "budget"]],
      ["database-backup", "Full local database backup", ["backups"]],
      ["recovery-export", "Portable conversation recovery export", ["import", "export"]],
      ["runtime-diagnostics", "Runtime diagnostics", ["support summary", "logs"]],
    ]),
    select: (context) => ({
      settings: context.settings,
      disabled: context.disabled,
      providers: context.providers,
      archived: context.archived,
      databaseBackup: context.databaseBackup,
      lifecycleDiagnostics: context.lifecycleDiagnostics,
      appUpdateStatus: context.appUpdateStatus,
      onReportCommand: context.onReportCommand,
      onUpdate: context.onUpdate,
      onUnarchive: context.onUnarchive,
      onRevealRuntimeLogs: context.onRevealRuntimeLogs,
      onCopyRuntimeDiagnosticReport: context.onCopyRuntimeDiagnosticReport,
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
