import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  Activity,
  Bot,
  Copy,
  Database,
  Download,
  FileCode2,
  FolderOpen,
  GitCompareArrows,
  Keyboard,
  Laptop,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  Sun,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import clsx from "clsx";

import {
  type AppSettings,
  type Conversation,
  type DatabaseBackupStatus,
  type ModelBackendDefault,
  type ModelBackendProfileDetail,
  type ModelBackendProfileDraft,
  type ModelBackendProfileView,
  type ModelSelection,
  type Project,
  type ProviderId,
  type ProviderInfo,
  type ProviderMaintenanceOperation,
  type ProviderMaintenanceProviderId,
} from "@shared/contracts";
import { defaultSettings } from "@shared/contracts/app";
import type {
  AppHealthSnapshot,
  AppUpdateStatus,
} from "@shared/desktop";
import { INERTIA_VERSION } from "@shared/version";
import {
  APP_SHORTCUT_KEYS,
  DEFAULT_APP_KEYBINDINGS,
  type AppShortcutAction,
  type AppShortcutKey,
} from "@shared/keybindings";
import { ProviderActionIcon, ProviderStatus, providerSetupAction, providerStateDetail, providerStateLabel } from "./ProviderStatus";
import { LoadingMark, Switch } from "./ui";
import { ProviderMaintenanceNotice } from "./ProviderMaintenanceNotice";
import {
  loadConnectionsAndDevicesSettings,
  loadDiscordSettings,
  loadModelBackendsSettings,
  prefetchSettingsSection,
} from "./settingsSectionLoaders";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { ThemeLibrary } from "./ThemeLibrary";

export type SettingsViewProps = {
  target?: {
    section: "providers" | "backends" | "connections";
    profileId?: string;
  } | null;
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  backendDefaults: ModelBackendDefault[];
  projects: Project[];
  conversations: Conversation[];
  archived: Conversation[];
  databaseBackup?: DatabaseBackupStatus;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId?: ProviderId) => void;
  maintenanceOperations: ReadonlyMap<
    ProviderMaintenanceProviderId,
    ProviderMaintenanceOperation
  >;
  maintenanceStatuses: ReadonlyMap<
    ProviderMaintenanceProviderId,
    NonNullable<ProviderInfo["maintenance"]>
  >;
  onRefreshProviderMaintenance: (
    providerId: ProviderMaintenanceProviderId,
  ) => Promise<void>;
  onUpdateProvider: (
    providerId: ProviderMaintenanceProviderId,
  ) => Promise<void>;
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
};

type SettingsSection =
  | "general"
  | "providers"
  | "backends"
  | "connections"
  | "discord"
  | "source"
  | "keybindings"
  | "archive";

const sections: Array<{ id: SettingsSection; label: string; icon: typeof Sun }> = [
  { id: "general", label: "General", icon: PanelLeft },
  { id: "providers", label: "Providers", icon: Bot },
  { id: "backends", label: "Model backends", icon: ServerCog },
  { id: "connections", label: "Connections & devices", icon: Laptop },
  { id: "discord", label: "Discord", icon: Bot },
  { id: "source", label: "Source control", icon: GitCompareArrows },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "archive", label: "Archive & data", icon: ArchiveRestore },
];

const shortcuts: Array<[AppShortcutAction, string]> = [
  ["search", "Search everything"],
  ["new-chat", "New chat"],
  ["toggle-sidebar", "Toggle project navigation"],
  ["toggle-terminal", "Toggle terminal"],
] as const;

function stableRecordFingerprint(
  value: Readonly<Record<string, string | undefined>>,
): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => (
    left.localeCompare(right)
  )));
}

function overlayDirtyProviderIdentityLabels(
  authoritative: AppSettings["providerIdentityLabels"],
  draft: AppSettings["providerIdentityLabels"],
  dirtyProviderIds: ReadonlySet<ProviderId>,
): AppSettings["providerIdentityLabels"] {
  const providerIdentityLabels = { ...authoritative };
  for (const providerId of dirtyProviderIds) {
    const value = draft[providerId];
    if (value !== undefined) providerIdentityLabels[providerId] = value;
    else delete providerIdentityLabels[providerId];
  }
  return providerIdentityLabels;
}

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  const unit = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1_024)),
  );
  const value = bytes / 1_024 ** unit;
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function SettingsSectionFallback(): React.JSX.Element {
  return (
    <div className="settings-section-loading" aria-busy="true">
      <LoadingMark label="Loading settings section" />
    </div>
  );
}

export function SettingsView({
  target,
  settings,
  disabled,
  providers,
  backendProfiles,
  backendDefaults,
  projects,
  conversations: _conversations,
  archived,
  databaseBackup,
  onUpdate: updateSettingsRequest,
  onConnectProvider,
  onRefreshProvider,
  maintenanceOperations,
  maintenanceStatuses,
  onRefreshProviderMaintenance,
  onUpdateProvider,
  onCancelProviderUpdate,
  onOpenProviderUpdateInstructions,
  onChooseCodexBinary,
  onRevealRuntimeLogs,
  onCopyRuntimeDiagnosticReport,
  appUpdateStatus,
  checkingAppUpdate,
  onCheckAppUpdate,
  onDownloadAppUpdate,
  onCancelAppUpdateDownload,
  onInstallAppUpdate,
  onOpenAppRelease,
  onUnarchive,
  onLoadBackendProfile,
  onCreateBackendProfile,
  onUpdateBackendProfile,
  onSetBackendCredential,
  onClearBackendCredential,
  onProbeBackendProfile,
  onDeleteBackendProfile,
  onSetBackendDefault,
  onClearBackendDefault,
}: SettingsViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    rootRef.current?.focus();
  }, []);
  const onUpdate = (updates: Partial<AppSettings>): void => {
    void updateSettingsRequest(updates).catch(() => undefined);
  };
  const [section, setSection] = useState<SettingsSection>(
    target?.section ?? "general",
  );
  const ModelBackendsSettings = useLoadedSurface(
    loadModelBackendsSettings,
    section === "backends",
  );
  const ConnectionsAndDevicesSettings = useLoadedSurface(
    loadConnectionsAndDevicesSettings,
    section === "connections",
  );
  const DiscordSettings = useLoadedSurface(
    loadDiscordSettings,
    section === "discord",
  );
  const previousTarget = useRef(target);
  useEffect(() => {
    if (target && target !== previousTarget.current) setSection(target.section);
    previousTarget.current = target;
  }, [target]);
  const [revealingLogs, setRevealingLogs] = useState(false);
  const [copyingSupportReport, setCopyingSupportReport] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [logRevealStatus, setLogRevealStatus] = useState<string | null>(null);
  const [supportReportStatus, setSupportReportStatus] = useState<string | null>(null);
  const [updateCheckStatus, setUpdateCheckStatus] = useState<string | null>(null);
  const [recoveryOperation, setRecoveryOperation] = useState<
    "export" | "import" | null
  >(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string | null>(null);
  const [appHealth, setAppHealth] = useState<AppHealthSnapshot | null>(null);
  const [healthStatus, setHealthStatus] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [providerIdentityLabelsDraft, setProviderIdentityLabelsDraft] = useState(
    () => settings.providerIdentityLabels,
  );
  const providerIdentityLabelsDraftRef = useRef(providerIdentityLabelsDraft);
  const authoritativeProviderIdentityLabelsRef = useRef(
    settings.providerIdentityLabels,
  );
  const dirtyProviderIdentityLabelsRef = useRef(new Set<ProviderId>());
  const pendingProviderIdentityLabelsRef = useRef<string | null>(null);
  const [keybindingsDraft, setKeybindingsDraft] = useState(
    () => settings.keybindings,
  );
  const keybindingsDraftRef = useRef(keybindingsDraft);
  const authoritativeKeybindingsRef = useRef(settings.keybindings);
  const pendingKeybindingsRef = useRef<string | null>(null);
  const providerIdentityLabelsFingerprint = stableRecordFingerprint(
    settings.providerIdentityLabels,
  );
  const keybindingsFingerprint = stableRecordFingerprint(settings.keybindings);
  useEffect(() => {
    authoritativeProviderIdentityLabelsRef.current =
      settings.providerIdentityLabels;
    if (
      pendingProviderIdentityLabelsRef.current !== null
      && pendingProviderIdentityLabelsRef.current
        !== providerIdentityLabelsFingerprint
    ) return;
    pendingProviderIdentityLabelsRef.current = null;
    const providerIdentityLabels = overlayDirtyProviderIdentityLabels(
      settings.providerIdentityLabels,
      providerIdentityLabelsDraftRef.current,
      dirtyProviderIdentityLabelsRef.current,
    );
    providerIdentityLabelsDraftRef.current = providerIdentityLabels;
    setProviderIdentityLabelsDraft(providerIdentityLabels);
  }, [providerIdentityLabelsFingerprint, settings.providerIdentityLabels]);
  useEffect(() => {
    authoritativeKeybindingsRef.current = settings.keybindings;
    if (
      pendingKeybindingsRef.current !== null
      && pendingKeybindingsRef.current !== keybindingsFingerprint
    ) return;
    pendingKeybindingsRef.current = null;
    keybindingsDraftRef.current = settings.keybindings;
    setKeybindingsDraft(settings.keybindings);
  }, [keybindingsFingerprint, settings.keybindings]);
  const defaultProvider = providers.find(({ id }) => id === settings.defaultProvider);
  const storedDefaultModel = defaultProvider?.models.find(
    ({ id }) => id === settings.defaultModel,
  );
  const providerDefaultModel = defaultProvider?.models.find(
    ({ isDefault }) => isDefault,
  ) ?? defaultProvider?.models[0];
  const effectiveDefaultModel = storedDefaultModel ?? providerDefaultModel;
  const reasoningOptions = effectiveDefaultModel?.reasoningOptions ?? [];
  const modelDefaultReasoning = reasoningOptions.find(
    ({ value }) => value === effectiveDefaultModel?.defaultReasoningEffort,
  );
  const providerDefaultModelLabel = providerDefaultModel
    ? `Provider default — ${providerDefaultModel.label}`
    : "Provider default";
  const modelDefaultReasoningLabel = modelDefaultReasoning?.label
    ?? effectiveDefaultModel?.defaultReasoningEffort;
  const primaryModifier = window.inertia.getPlatform() === "darwin" ? "⌘" : "Ctrl";
  const archivedByProvider = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.label])), [providers]);
  useEffect(() => {
    if (section !== "archive") return;
    let active = true;
    const sample = async (): Promise<void> => {
      try {
        const health = await window.inertia.getAppHealth();
        if (active) {
          setAppHealth(health);
          setHealthStatus(null);
        }
      } catch {
        if (active) setHealthStatus("Local health data is unavailable.");
      }
    };
    void sample();
    const timer = window.setInterval(() => { void sample(); }, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [section]);
  const clearAppCache = async (): Promise<void> => {
    if (clearingCache) return;
    setClearingCache(true);
    setHealthStatus(null);
    try {
      setAppHealth(await window.inertia.clearAppCache());
      setHealthStatus("Browser cache cleared; user data was unchanged.");
    } catch {
      setHealthStatus("The browser cache could not be cleared.");
    } finally {
      setClearingCache(false);
    }
  };
  const revealRuntimeLogs = async (): Promise<void> => {
    if (revealingLogs) return;
    setRevealingLogs(true);
    setLogRevealStatus(null);
    try {
      const error = await onRevealRuntimeLogs();
      setLogRevealStatus(error ? "The runtime log folder could not be opened." : "Runtime log folder opened.");
    } catch {
      setLogRevealStatus("The runtime log folder could not be opened.");
    } finally {
      setRevealingLogs(false);
    }
  };
  const copyRuntimeSupportReport = async (): Promise<void> => {
    if (copyingSupportReport) return;
    setCopyingSupportReport(true);
    setSupportReportStatus(null);
    try {
      const result = await onCopyRuntimeDiagnosticReport();
      setSupportReportStatus(result.copied
        ? `Private support summary copied · ${result.eventCount} lifecycle ${result.eventCount === 1 ? "event" : "events"}.`
        : "The support summary could not be copied.");
    } catch {
      setSupportReportStatus("The support summary could not be copied.");
    } finally {
      setCopyingSupportReport(false);
    }
  };
  const checkAppUpdate = async (): Promise<void> => {
    if (checkingUpdate || checkingAppUpdate) return;
    setCheckingUpdate(true);
    setUpdateCheckStatus(null);
    try {
      await onCheckAppUpdate();
    } catch {
      setUpdateCheckStatus("The update check could not be completed.");
    } finally {
      setCheckingUpdate(false);
    }
  };
  const runAppUpdateAction = async (
    operation: () => Promise<void>,
    failureMessage: string,
  ): Promise<void> => {
    setUpdateCheckStatus(null);
    try {
      await operation();
    } catch {
      setUpdateCheckStatus(failureMessage);
    }
  };
  const exportRecoveryData = async (): Promise<void> => {
    if (recoveryOperation) return;
    setRecoveryOperation("export");
    setRecoveryStatus(null);
    try {
      const result = await window.inertia.exportRecoveryData();
      setRecoveryStatus(result.status === "exported"
        ? "Recovery exported without attachments, credentials, sessions, or vault data."
        : "Recovery export cancelled.");
    } catch {
      setRecoveryStatus("The recovery file could not be exported.");
    } finally {
      setRecoveryOperation(null);
    }
  };
  const importRecoveryData = async (): Promise<void> => {
    if (recoveryOperation) return;
    setRecoveryOperation("import");
    setRecoveryStatus(null);
    try {
      const result = await window.inertia.importRecoveryData();
      setRecoveryStatus(result.status === "imported"
        ? result.summary.alreadyImported
          ? "That recovery file was already imported; nothing was duplicated."
          : `Imported ${result.summary.projects} projects, ${result.summary.conversations} conversations, and ${result.summary.messages} messages as new supervised identities.`
        : "Recovery import cancelled.");
    } catch {
      setRecoveryStatus("The recovery file was rejected or could not be imported.");
    } finally {
      setRecoveryOperation(null);
    }
  };
  return (
    <main
      ref={rootRef}
      className="settings-view"
      aria-label="Settings"
      tabIndex={-1}
    >
      <aside className="settings-navigation" aria-label="Settings sections">
        <nav>
          {sections.map((item) => {
            const Icon = item.icon;
            return <button type="button" className={clsx(section === item.id && "is-active")} aria-current={section === item.id ? "page" : undefined} onFocus={() => prefetchSettingsSection(item.id)} onPointerDown={() => prefetchSettingsSection(item.id)} onPointerEnter={() => prefetchSettingsSection(item.id)} onClick={() => setSection(item.id)} key={item.id}><Icon size={15} /><span>{item.label}</span>{item.id === "archive" && archived.length > 0 && <small>{archived.length}</small>}</button>;
          })}
        </nav>
      </aside>

      <div className={clsx(
        "settings-content",
        section === "backends" && "is-backends",
      )}>
        <h2 className="visually-hidden">
          {sections.find((item) => item.id === section)?.label ?? "Settings"}
        </h2>
        {section === "general" && (
          <div className="settings-toolbar">
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => onUpdate(defaultSettings)}><RotateCcw size={14} />Restore defaults</button>
          </div>
        )}

        {section === "general" && (
          <>
            <section className="settings-card" aria-labelledby="appearance-heading">
              <div className="settings-card-heading"><div><Sun size={18} /></div><span><h3 id="appearance-heading">Appearance</h3><p>Choose an appearance mode, then make the whole workbench feel like yours.</p></span></div>
              <ThemeLibrary settings={settings} disabled={disabled} onUpdate={onUpdate} />
              <div className="response-density-setting interface-scale-setting">
                <span><strong>Interface scale</strong><small>Scale navigation, messages, controls, files, and diffs live. Terminal text stays independent.</small></span>
                <div role="radiogroup" aria-label="Interface scale">
                  {(["compact", "default", "comfortable", "large"] as const).map((scale) => <button type="button" role="radio" aria-checked={settings.interfaceScale === scale} className={clsx(settings.interfaceScale === scale && "is-active")} disabled={disabled} key={scale} onClick={() => onUpdate({ interfaceScale: scale })}>{scale === "default" ? "Default" : scale[0].toUpperCase() + scale.slice(1)}</button>)}
                </div>
              </div>
            </section>

            <section className="settings-card" aria-labelledby="workspace-heading">
              <div className="settings-card-heading"><div><PanelLeft size={18} /></div><span><h3 id="workspace-heading">Workspace</h3><p>Choose which quiet details help you stay oriented.</p></span></div>
              <div className="response-density-setting">
                <span><strong>Project navigation</strong><small>Browse projects or focus on work that needs attention across them.</small></span>
                <div role="radiogroup" aria-label="Project navigation">
                  <button type="button" role="radio" aria-checked={settings.sidebarMode === "classic"} className={clsx(settings.sidebarMode === "classic" && "is-active")} disabled={disabled} onClick={() => onUpdate({ sidebarMode: "classic" })}>Projects</button>
                  <button type="button" role="radio" aria-checked={settings.sidebarMode === "activity"} className={clsx(settings.sidebarMode === "activity" && "is-active")} disabled={disabled} onClick={() => onUpdate({ sidebarMode: "activity" })}>Work</button>
                </div>
              </div>
              <div className="response-density-setting">
                <span><strong>Workspace startup</strong><small>Begin in Environment or restore the last workspace panel you used.</small></span>
                <div role="radiogroup" aria-label="Workspace startup surface">
                  <button type="button" role="radio" aria-checked={settings.workspaceStartupSurface === "summary"} className={clsx(settings.workspaceStartupSurface === "summary" && "is-active")} disabled={disabled} onClick={() => onUpdate({ workspaceStartupSurface: "summary" })}>Environment</button>
                  <button type="button" role="radio" aria-checked={settings.workspaceStartupSurface === "tools"} className={clsx(settings.workspaceStartupSurface === "tools" && "is-active")} disabled={disabled} onClick={() => onUpdate({ workspaceStartupSurface: "tools" })}>Last panel</button>
                </div>
              </div>
              <div className="response-density-setting project-grouping-setting">
                <span><strong>Logical project grouping</strong><small>Use canonical Git identity and normalized paths, never display names.</small></span>
                <div role="radiogroup" aria-label="Logical project grouping">
                  <button type="button" role="radio" aria-checked={settings.projectGrouping === "repository"} className={clsx(settings.projectGrouping === "repository" && "is-active")} disabled={disabled} onClick={() => onUpdate({ projectGrouping: "repository" })}>Repository</button>
                  <button type="button" role="radio" aria-checked={settings.projectGrouping === "repository-path"} className={clsx(settings.projectGrouping === "repository-path" && "is-active")} disabled={disabled} onClick={() => onUpdate({ projectGrouping: "repository-path" })}>Repo + folder</button>
                  <button type="button" role="radio" aria-checked={settings.projectGrouping === "separate"} className={clsx(settings.projectGrouping === "separate" && "is-active")} disabled={disabled} onClick={() => onUpdate({ projectGrouping: "separate" })}>Keep separate</button>
                </div>
              </div>
              <div className="settings-rows">
                <SettingSwitch title="Compact project navigation" detail="Reduce spacing while keeping project names readable." checked={settings.compactSidebar} disabled={disabled} onChange={(compactSidebar) => onUpdate({ compactSidebar })} />
                <SettingSwitch title="Message timestamps" detail="Show a quiet time label alongside each message." checked={settings.showTimestamps} disabled={disabled} onChange={(showTimestamps) => onUpdate({ showTimestamps })} />
                <SettingSwitch title="Live thinking summaries" detail="Show provider-supplied reasoning summaries as they arrive." checked={settings.showThinking} disabled={disabled} onChange={(showThinking) => onUpdate({ showThinking })} />
                <SettingSwitch title="Open plan automatically" detail="Reveal the Plan panel when an agent publishes steps." checked={settings.autoOpenPlan} disabled={disabled} onChange={(autoOpenPlan) => onUpdate({ autoOpenPlan })} />
                <SettingSwitch title="Desktop notifications" detail="Show privacy-safe completion and attention alerts without prompt or response text." checked={settings.desktopNotifications} disabled={disabled} onChange={(desktopNotifications) => onUpdate({ desktopNotifications })} />
                <SettingSwitch title="Confirm destructive actions" detail="Ask before deleting threads or restoring checkpoints." checked={settings.confirmDestructiveActions} disabled={disabled} onChange={(confirmDestructiveActions) => onUpdate({ confirmDestructiveActions })} />
              </div>
              <div className="response-density-setting usage-display-setting">
                <span><strong>Usage and context</strong><small>Choose a full composer card, a restrained summary, or hide provider usage entirely.</small></span>
                <div role="radiogroup" aria-label="Usage and context display">
                  {(["expanded", "compact", "hidden"] as const).map((mode) => <button type="button" role="radio" aria-checked={settings.usageDisplayMode === mode} className={clsx(settings.usageDisplayMode === mode && "is-active")} disabled={disabled} key={mode} onClick={() => onUpdate({ usageDisplayMode: mode })}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}
                </div>
              </div>
            </section>

            <section className="settings-card" aria-labelledby="responses-heading">
              <div className="settings-card-heading"><div><FileCode2 size={18} /></div><span><h3 id="responses-heading">Agent responses</h3><p>Choose how final answers and the work behind them are presented.</p></span></div>
              <div className="response-density-setting">
                <span><strong>Response density</strong><small>Adjust spacing and type size without changing terminal text.</small></span>
                <div role="radiogroup" aria-label="Response density">
                  {(["compact", "default", "comfortable"] as const).map((density) => <button type="button" role="radio" aria-checked={settings.responseDensity === density} className={clsx(settings.responseDensity === density && "is-active")} disabled={disabled} key={density} onClick={() => onUpdate({ responseDensity: density })}>{density === "default" ? "Default" : density[0].toUpperCase() + density.slice(1)}</button>)}
                </div>
              </div>
              <div className="settings-rows">
                <SettingSwitch title="Wrap code by default" detail="Start fenced code blocks wrapped; each block still has its own control." checked={settings.defaultCodeWrap} disabled={disabled} onChange={(defaultCodeWrap) => onUpdate({ defaultCodeWrap })} />
                <SettingSwitch title="Collapse completed work logs" detail="Keep final answers visible while condensing successful tool activity." checked={settings.autoCollapseWorkLog} disabled={disabled} onChange={(autoCollapseWorkLog) => onUpdate({ autoCollapseWorkLog })} />
                <SettingSwitch title="Changed-file summaries" detail="Show the current workspace file summary below the latest settled turn." checked={settings.showChangedFileSummaries} disabled={disabled} onChange={(showChangedFileSummaries) => onUpdate({ showChangedFileSummaries })} />
                <SettingSwitch title="Jump to completed answers" detail="Position the transcript at the beginning of each new final answer." checked={settings.autoScrollToFinalAnswer} disabled={disabled} onChange={(autoScrollToFinalAnswer) => onUpdate({ autoScrollToFinalAnswer })} />
              </div>
            </section>

            <section className="settings-card" aria-labelledby="terminal-heading">
              <div className="settings-card-heading"><div><TerminalSquare size={18} /></div><span><h3 id="terminal-heading">Terminal</h3><p>Keep command output comfortable to read.</p></span></div>
              <div className="range-setting"><label htmlFor="terminal-font-size">Terminal font size</label><output htmlFor="terminal-font-size">{settings.terminalFontSize}px</output><input id="terminal-font-size" type="range" min="11" max="22" step="1" value={settings.terminalFontSize} disabled={disabled} onChange={(event) => onUpdate({ terminalFontSize: Number(event.target.value) })} /><div className="range-labels"><span>Compact</span><span>Comfortable</span></div></div>
            </section>

            <section className="settings-card" aria-labelledby="application-update-heading">
              <div className="settings-card-heading"><div><Download size={18} /></div><span><h3 id="application-update-heading">Application updates</h3><p>Update on your schedule, never during active work.</p></span></div>
              <div className="codex-binary-path application-update-setting">
                <span>
                  <strong>Inertia v{INERTIA_VERSION}</strong>
                  <small role="status" aria-live="polite" aria-atomic="true">
                    {updateCheckStatus
                      ?? appUpdateStatus?.message
                      ?? "Checks run quietly after launch; downloads and installs remain manual."}
                  </small>
                </span>
                <div>
                  {appUpdateStatus?.state === "available" && (
                    <button type="button" className="secondary-button" onClick={() => { void runAppUpdateAction(onOpenAppRelease, "The release page could not be opened."); }}><Download size={14} />View release</button>
                  )}
                  {appUpdateStatus?.delivery === "in-app" && ["available", "cancelled", "failed"].includes(appUpdateStatus.state) && (
                    <button type="button" className="secondary-button" onClick={() => { void runAppUpdateAction(onDownloadAppUpdate, "The update download could not be started."); }}><Download size={14} />{appUpdateStatus.state === "available" ? "Download" : "Retry download"}</button>
                  )}
                  {appUpdateStatus?.state === "downloading" && (
                    <button type="button" className="secondary-button" onClick={() => { void runAppUpdateAction(onCancelAppUpdateDownload, "The update download could not be cancelled."); }}>Cancel download</button>
                  )}
                  {appUpdateStatus?.state === "downloaded" && (
                    <button type="button" className="secondary-button" onClick={() => { void runAppUpdateAction(onInstallAppUpdate, "The update restart could not be started safely."); }}>Restart to update</button>
                  )}
                  <button type="button" className="secondary-button" disabled={checkingUpdate || checkingAppUpdate || ["downloading", "downloaded", "installing"].includes(appUpdateStatus?.state ?? "")} onClick={() => { void checkAppUpdate(); }}><RefreshCw size={14} />{checkingUpdate || checkingAppUpdate ? "Checking…" : "Check now"}</button>
                </div>
              </div>
            </section>
          </>
        )}

        {section === "providers" && (
          <>
            <section className="settings-card" aria-labelledby="agents-heading">
              <div className="settings-card-heading"><div><Bot size={18} /></div><span><h3 id="agents-heading">Agent accounts</h3><p>Use the coding tools and accounts already installed on this computer.</p></span><button type="button" className="secondary-button provider-refresh-all" aria-label="Refresh all agents" disabled={disabled} onClick={() => onRefreshProvider()}><RefreshCw size={14} />Refresh</button></div>
              <div className="settings-rows provider-account-list">
                {providers.map((provider) => {
                  const action = providerSetupAction(provider);
                  const identityLabel = providerIdentityLabelsDraft[provider.id];
                  return (
                    <div className="setting-row provider-account-row" key={provider.id}>
                      <span className="setting-row-icon"><Bot size={17} /></span>
                      <div className="setting-copy provider-account-copy">
                        <span className="provider-account-title">
                          <strong>{identityLabel ?? provider.label}</strong>
                          <ProviderStatus provider={provider} />
                        </span>
                        <small>
                          {identityLabel ? `${provider.label} · ` : ""}{providerStateDetail(provider)}
                          {provider.models.length > 0
                            ? ` · ${provider.models.length} models available`
                            : ""}
                        </small>
                        <label className="provider-identity-alias">
                          <span>Name in Inertia</span>
                          <input
                            value={identityLabel ?? ""}
                            maxLength={48}
                            placeholder={`${provider.label} account`}
                            disabled={disabled}
                            onChange={(event) => {
                              const providerIdentityLabels = {
                                ...providerIdentityLabelsDraftRef.current,
                                [provider.id]: event.currentTarget.value,
                              };
                              providerIdentityLabelsDraftRef.current =
                                providerIdentityLabels;
                              dirtyProviderIdentityLabelsRef.current.add(
                                provider.id,
                              );
                              setProviderIdentityLabelsDraft(
                                providerIdentityLabels,
                              );
                            }}
                            onBlur={(event) => {
                              const next = event.currentTarget.value.trim();
                              const providerIdentityLabels = {
                                ...providerIdentityLabelsDraftRef.current,
                              };
                              if (next) providerIdentityLabels[provider.id] = next;
                              else delete providerIdentityLabels[provider.id];
                              providerIdentityLabelsDraftRef.current =
                                providerIdentityLabels;
                              dirtyProviderIdentityLabelsRef.current.delete(
                                provider.id,
                              );
                              setProviderIdentityLabelsDraft(
                                providerIdentityLabels,
                              );
                              const fingerprint = stableRecordFingerprint(
                                providerIdentityLabels,
                              );
                              if (
                                fingerprint === providerIdentityLabelsFingerprint
                                || fingerprint
                                  === pendingProviderIdentityLabelsRef.current
                              ) return;
                              pendingProviderIdentityLabelsRef.current = fingerprint;
                              void updateSettingsRequest({ providerIdentityLabels }).catch(() => {
                                if (
                                  pendingProviderIdentityLabelsRef.current
                                    !== fingerprint
                                ) return;
                                pendingProviderIdentityLabelsRef.current = null;
                                const authoritative =
                                  authoritativeProviderIdentityLabelsRef.current;
                                const providerIdentityLabels =
                                  overlayDirtyProviderIdentityLabels(
                                    authoritative,
                                    providerIdentityLabelsDraftRef.current,
                                    dirtyProviderIdentityLabelsRef.current,
                                  );
                                providerIdentityLabelsDraftRef.current =
                                  providerIdentityLabels;
                                setProviderIdentityLabelsDraft(
                                  providerIdentityLabels,
                                );
                              });
                            }}
                          />
                        </label>
                        <ProviderMaintenanceNotice
                          providerLabel={provider.label}
                          status={maintenanceStatuses.get(provider.id) ?? null}
                          operation={maintenanceOperations.get(provider.id) ?? null}
                          disabled={disabled}
                          dismissible={false}
                          showManagedUpdateAction
                          onRefresh={() => onRefreshProviderMaintenance(provider.id)}
                          onUpdate={() => onUpdateProvider(provider.id)}
                          onCancel={onCancelProviderUpdate}
                          onOpenInstructions={onOpenProviderUpdateInstructions}
                        />
                      </div>
                      {action && (
                        <button
                          type="button"
                          className="secondary-button provider-account-action"
                          disabled={disabled}
                          onClick={() => action === "connect"
                            ? onConnectProvider(provider.id)
                            : onRefreshProvider(provider.id)}
                        >
                          <ProviderActionIcon action={action} />
                          {action === "connect"
                            ? provider.id === "opencode" ? "Configure" : "Connect"
                            : "Refresh"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="settings-card-note">Authentication stays with each provider; Inertia stores no account passwords or tokens.</p>
            </section>

            <section className="settings-card codex-binary-setting" aria-labelledby="codex-binary-heading">
              <div className="settings-card-heading"><div><Bot size={18} /></div><span><h3 id="codex-binary-heading">Codex executable</h3><p>Checks official, package-manager, custom-home, and PATH installs.</p></span></div>
              <div className="codex-binary-path">
                <span><strong>{settings.codexBinaryPath ? "Manual override" : "Selected executable"}</strong><small title={settings.codexBinaryPath || providers.find(({ id }) => id === "codex")?.executable || undefined}>{settings.codexBinaryPath || providers.find(({ id }) => id === "codex")?.executable || "No working Codex executable detected"}</small></span>
                <div>
                  <button type="button" className="secondary-button" disabled={disabled} onClick={onChooseCodexBinary}><FolderOpen size={14} />Browse</button>
                  {settings.codexBinaryPath && <button type="button" className="secondary-button" disabled={disabled} onClick={() => onUpdate({ codexBinaryPath: "" })}><Trash2 size={14} />Use automatic</button>}
                </div>
              </div>
              <p className="settings-card-note">The selected file is version-checked before it is saved. Sign-in and App Server support are reported separately.</p>
            </section>

            <section className="settings-card" aria-labelledby="defaults-heading">
              <div className="settings-card-heading"><div><Bot size={18} /></div><span><h3 id="defaults-heading">New chat defaults</h3><p>Applied only to new chats.</p></span></div>
              <div className="settings-form-grid">
                <label><span>Provider</span><select value={settings.defaultProvider} disabled={disabled} onChange={(event) => onUpdate({ defaultProvider: event.target.value as ProviderId, defaultModel: "", defaultReasoningEffort: "" })}>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.label} — {providerStateLabel(provider)}</option>)}</select></label>
                <label><span>Model</span><select value={settings.defaultModel} disabled={disabled || !defaultProvider?.models.length} onChange={(event) => { const model = defaultProvider?.models.find(({ id }) => id === event.target.value); onUpdate({ defaultModel: event.target.value, defaultReasoningEffort: model?.defaultReasoningEffort ?? "" }); }}><option value="">{providerDefaultModelLabel}</option>{settings.defaultModel && !storedDefaultModel && <option value={settings.defaultModel}>{settings.defaultModel} — Unavailable</option>}{defaultProvider?.models.map((model) => <option value={model.id} key={model.id}>{model.label}{model.isDefault ? " — Default" : ""}</option>)}</select></label>
                <label><span>Reasoning</span><select value={settings.defaultReasoningEffort} disabled={disabled || reasoningOptions.length === 0} onChange={(event) => onUpdate({ defaultReasoningEffort: event.target.value })}><option value="">Model default{modelDefaultReasoningLabel ? ` — ${modelDefaultReasoningLabel}` : ""}</option>{settings.defaultReasoningEffort && !reasoningOptions.some(({ value }) => value === settings.defaultReasoningEffort) && <option value={settings.defaultReasoningEffort}>{settings.defaultReasoningEffort} — Unavailable</option>}{reasoningOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
                <label><span>Mode</span><select value={settings.defaultInteractionMode} disabled={disabled} onChange={(event) => onUpdate({ defaultInteractionMode: event.target.value as AppSettings["defaultInteractionMode"] })}><option value="build">Build</option><option value="plan">Plan</option></select></label>
                <label><span>Access</span><select value={settings.defaultAccessMode} disabled={disabled} onChange={(event) => onUpdate({ defaultAccessMode: event.target.value as AppSettings["defaultAccessMode"] })}><option value="supervised">Supervised</option><option value="auto-edit">Auto-accept edits</option><option value="full">Full access</option></select></label>
                <label><span>Chat location</span><select value={settings.newThreadMode} disabled={disabled} onChange={(event) => onUpdate({ newThreadMode: event.target.value as AppSettings["newThreadMode"] })}><option value="local">Current checkout</option><option value="worktree">Isolated worktree</option></select></label>
              </div>
            </section>
          </>
        )}

        {section === "backends" && (
          ModelBackendsSettings ? (
            <ModelBackendsSettings
              profiles={backendProfiles}
              initialProfileId={target?.section === "backends"
                ? target.profileId
                : undefined}
              defaults={backendDefaults}
              projects={projects}
              disabled={disabled}
              onLoadDetail={onLoadBackendProfile}
              onCreate={onCreateBackendProfile}
              onUpdate={onUpdateBackendProfile}
              onSetCredential={onSetBackendCredential}
              onClearCredential={onClearBackendCredential}
              onProbe={onProbeBackendProfile}
              onDelete={onDeleteBackendProfile}
              onSetDefault={onSetBackendDefault}
              onClearDefault={onClearBackendDefault}
            />
          ) : <SettingsSectionFallback />
        )}

        {section === "connections" && (
          ConnectionsAndDevicesSettings ? (
            <ConnectionsAndDevicesSettings projects={projects} />
          ) : <SettingsSectionFallback />
        )}

        {section === "discord" && (
          DiscordSettings ? (
            <DiscordSettings
              disabled={disabled}
              repositoryUrl={settings.discordReleaseRepositoryUrl}
              onUpdate={onUpdate}
            />
          ) : <SettingsSectionFallback />
        )}

        {section === "source" && (
          <section className="settings-card" aria-labelledby="source-heading">
            <div className="settings-card-heading"><div><GitCompareArrows size={18} /></div><span><h3 id="source-heading">Changes</h3><p>Keep diffs easy to review.</p></span></div>
            <div className="settings-rows"><SettingSwitch title="Wrap long diff lines" detail="Read wide changes without horizontal scrolling." checked={settings.wrapDiffs} disabled={disabled} onChange={(wrapDiffs) => onUpdate({ wrapDiffs })} /><SettingSwitch title="Ignore whitespace" detail="Hide whitespace-only changes when supported." checked={settings.ignoreWhitespace} disabled={disabled} onChange={(ignoreWhitespace) => onUpdate({ ignoreWhitespace })} /></div>
            <p className="settings-card-note">Git actions always use the current project repository.</p>
          </section>
        )}

        {section === "keybindings" && (
          <section className="settings-card" aria-labelledby="keybindings-heading">
            <div className="settings-card-heading"><div><Keyboard size={18} /></div><span><h3 id="keybindings-heading">Keyboard shortcuts</h3><p>Fast paths for common actions.</p></span></div>
            <div className="shortcut-list">{shortcuts.map(([action, label]) => <label key={action}><span>{label}</span><span className="shortcut-binding"><kbd>{primaryModifier}</kbd><select aria-label={`${label} key`} value={keybindingsDraft[action]} disabled={disabled} onChange={(event) => {
              const keybindings = {
                ...keybindingsDraftRef.current,
                [action]: event.target.value as AppShortcutKey,
              };
              keybindingsDraftRef.current = keybindings;
              setKeybindingsDraft(keybindings);
              const fingerprint = stableRecordFingerprint(keybindings);
              pendingKeybindingsRef.current = fingerprint;
              void updateSettingsRequest({ keybindings }).catch(() => {
                if (pendingKeybindingsRef.current !== fingerprint) return;
                pendingKeybindingsRef.current = null;
                const authoritative = authoritativeKeybindingsRef.current;
                keybindingsDraftRef.current = authoritative;
                setKeybindingsDraft(authoritative);
              });
            }}>{APP_SHORTCUT_KEYS.map((key) => <option value={key} key={key} disabled={shortcuts.some(([other]) => other !== action && keybindingsDraft[other] === key)}>{key.toUpperCase()}</option>)}</select></span></label>)}</div>
            <button className="secondary-button settings-keybinding-reset" type="button" disabled={disabled || Object.entries(DEFAULT_APP_KEYBINDINGS).every(([action, key]) => keybindingsDraft[action as AppShortcutAction] === key)} onClick={() => {
              const keybindings = { ...DEFAULT_APP_KEYBINDINGS };
              keybindingsDraftRef.current = keybindings;
              setKeybindingsDraft(keybindings);
              const fingerprint = stableRecordFingerprint(keybindings);
              pendingKeybindingsRef.current = fingerprint;
              void updateSettingsRequest({ keybindings }).catch(() => {
                if (pendingKeybindingsRef.current !== fingerprint) return;
                pendingKeybindingsRef.current = null;
                const authoritative = authoritativeKeybindingsRef.current;
                keybindingsDraftRef.current = authoritative;
                setKeybindingsDraft(authoritative);
              });
            }}><RotateCcw size={14} />Reset shortcuts</button>
            <p className="settings-card-note">Cmd/Ctrl stays fixed; available keys avoid system shortcuts.</p>
          </section>
        )}

        {section === "archive" && (
          <>
            <section className="settings-card" aria-labelledby="archive-heading">
              <div className="settings-card-heading"><div><ArchiveRestore size={18} /></div><span><h3 id="archive-heading">Archived threads</h3><p>Restore work with its original context.</p></span></div>
              {archived.length > 0 ? <div className="archive-list">{archived.map((thread) => <div className="archive-row" key={thread.id}><span><strong>{thread.title}</strong><small>{archivedByProvider.get(thread.providerId) ?? thread.providerId}</small></span><button type="button" className="secondary-button" disabled={disabled} onClick={() => onUnarchive(thread)}><ArchiveRestore size={14} />Restore</button></div>)}</div> : <div className="settings-empty-state"><ArchiveRestore size={19} /><strong>No archived threads</strong><span>Archived work will appear here.</span></div>}
            </section>
            <section className="settings-card" aria-labelledby="data-heading">
              <div className="settings-card-heading"><div><Database size={18} /></div><span><h3 id="data-heading">Local data</h3><p>Database backups and portable recovery exports.</p></span></div>
              <div className="settings-data-note"><ShieldCheck size={17} /><span><strong>Provider credentials stay outside Inertia.</strong><small>Account authentication remains in each provider’s own secure storage.</small></span></div>
              <div className="codex-binary-path runtime-log-setting app-health-setting">
                <span>
                  <strong><Activity size={14} />Local resource health</strong>
                  <small>Sampled only while open; covers Inertia processes and app storage, never project files.</small>
                  {appHealth ? (
                    <span className="app-health-grid">
                      <span><b>{formatStorageBytes(appHealth.totalMemoryBytes)}</b><small>App memory</small></span>
                      <span><b>{formatStorageBytes(appHealth.databaseBytes)}</b><small>Database</small></span>
                      <span><b>{formatStorageBytes(appHealth.cacheBytes)}</b><small>Browser cache</small></span>
                      <span><b>{formatStorageBytes(appHealth.temporaryAttachmentBytes)}</b><small>Temporary attachments</small></span>
                    </span>
                  ) : <small>Measuring local usage…</small>}
                  {appHealth && <small>Local service: {appHealth.runtimePhase} · main {appHealth.mainProcess ? `${appHealth.mainProcess.cpuPercent.toFixed(1)}% CPU` : "unavailable"} · renderer {appHealth.rendererProcess ? formatStorageBytes(appHealth.rendererProcess.memoryBytes) : "unavailable"}.</small>}
                </span>
                <div>
                  <button type="button" className="secondary-button" disabled={clearingCache || !appHealth} onClick={() => { void clearAppCache(); }}><Trash2 size={14} />{clearingCache ? "Clearing…" : "Clear browser cache"}</button>
                </div>
              </div>
              {healthStatus && <p className="settings-card-note" role="status">{healthStatus}</p>}
              <div className="codex-binary-path runtime-log-setting">
                <span>
                  <strong>Full local database backup</strong>
                  <small>Validated SQLite copies include presets, session references, execution context, Git artifacts, and attachment records—not secrets or attachment bytes.</small>
                  <small>
                    {databaseBackup?.lastValidatedAt
                      ? <>Last validated backup: <time dateTime={databaseBackup.lastValidatedAt} title={databaseBackup.lastValidatedAt}>{new Date(databaseBackup.lastValidatedAt).toLocaleString()}</time>.</>
                      : "No validated backup yet. Inertia creates one after a short startup quiet period or the first completed turn, then keeps an hourly rotation."}
                  </small>
                </span>
              </div>
              <div className="codex-binary-path runtime-log-setting">
                <span>
                  <strong>Portable conversation recovery export</strong>
                  <small>Exports project paths and messages without presets, attachments, sessions, execution context, Git artifacts, credentials, secret references, or vault data. Imports create new supervised identities.</small>
                </span>
                <div>
                  <button type="button" className="secondary-button" disabled={disabled || recoveryOperation !== null} onClick={() => { void exportRecoveryData(); }}><Download size={14} />{recoveryOperation === "export" ? "Exporting…" : "Export recovery file"}</button>
                  <button type="button" className="secondary-button" disabled={disabled || recoveryOperation !== null} onClick={() => { void importRecoveryData(); }}><ArchiveRestore size={14} />{recoveryOperation === "import" ? "Importing…" : "Import recovery file"}</button>
                </div>
              </div>
              {recoveryStatus && <p className="settings-card-note" role="status">{recoveryStatus}</p>}
              <div className="codex-binary-path runtime-log-setting">
                <span>
                  <strong>Runtime diagnostics</strong>
                  <small>Local-only lifecycle and failure metadata. Excludes prompts, source, tokens, and credentials. Logs rotate at 256 KB and expire after seven days.</small>
                </span>
                <div>
                  <button type="button" className="secondary-button" disabled={copyingSupportReport} onClick={() => { void copyRuntimeSupportReport(); }}><Copy size={14} />{copyingSupportReport ? "Copying…" : "Copy support summary"}</button>
                  <button type="button" className="secondary-button" disabled={revealingLogs} onClick={() => { void revealRuntimeLogs(); }}><FolderOpen size={14} />{revealingLogs ? "Opening…" : "Reveal log folder"}</button>
                </div>
              </div>
              {logRevealStatus && <p className="settings-card-note" role="status">{logRevealStatus}</p>}
              {supportReportStatus && <p className="settings-card-note" role="status">{supportReportStatus}</p>}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function SettingSwitch({ title, detail, checked, disabled, onChange }: { title: string; detail: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }): React.JSX.Element {
  return <div className="setting-row"><span className="setting-copy"><strong>{title}</strong><small>{detail}</small></span><Switch label={title} checked={checked} disabled={disabled} onChange={onChange} /></div>;
}
