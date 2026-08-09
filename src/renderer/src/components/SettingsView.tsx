import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  Activity,
  Bot,
  Check,
  Copy,
  Database,
  Download,
  FileCode2,
  FolderOpen,
  GitCompareArrows,
  Keyboard,
  Laptop,
  Moon,
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
  defaultSettings,
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
  type ThemePreference,
} from "@shared/contracts";
import type { AppHealthSnapshot, AppUpdateStatus } from "@shared/desktop";
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
  loadModelBackendsSettings,
  prefetchSettingsSection,
} from "./settingsSectionLoaders";
import { useLoadedSurface } from "../hooks/useLoadedSurface";

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
  onUpdate: (settings: Partial<AppSettings>) => void;
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

type SettingsSection = "general" | "providers" | "backends" | "connections" | "source" | "keybindings" | "archive";

const themes: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Laptop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const sections: Array<{ id: SettingsSection; label: string; icon: typeof Sun }> = [
  { id: "general", label: "General", icon: PanelLeft },
  { id: "providers", label: "Providers", icon: Bot },
  { id: "backends", label: "Model backends", icon: ServerCog },
  { id: "connections", label: "Connections & devices", icon: Laptop },
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
  onUpdate,
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
  const defaultProvider = providers.find(({ id }) => id === settings.defaultProvider);
  const defaultModel = defaultProvider?.models.find(({ id }) => id === settings.defaultModel)
    ?? defaultProvider?.models.find(({ isDefault }) => isDefault)
    ?? defaultProvider?.models[0];
  const reasoningOptions = defaultModel?.reasoningOptions ?? [];
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
      setHealthStatus("Recreatable browser cache cleared. User data was not changed.");
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
  const exportRecoveryData = async (): Promise<void> => {
    if (recoveryOperation) return;
    setRecoveryOperation("export");
    setRecoveryStatus(null);
    try {
      const result = await window.inertia.exportRecoveryData();
      setRecoveryStatus(result.status === "exported"
        ? "Recovery file exported. Attachments, credentials, provider sessions, and vault data were excluded."
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
          ? "That recovery file was already imported into the authorized folder; no data was duplicated."
          : `Imported ${result.summary.projects} projects, ${result.summary.conversations} conversations, and ${result.summary.messages} messages under new identities with supervised access.`
        : "Recovery import cancelled.");
    } catch {
      setRecoveryStatus("The recovery file was rejected or could not be imported.");
    } finally {
      setRecoveryOperation(null);
    }
  };

  return (
    <main className="settings-view">
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
              <div className="settings-card-heading"><div><Sun size={18} /></div><span><h3 id="appearance-heading">Appearance</h3><p>Choose a theme and a coherent scale for the whole interface.</p></span></div>
              <div className="theme-options" role="radiogroup" aria-label="Theme">
                {themes.map((theme) => { const ThemeIcon = theme.icon; return <button type="button" role="radio" aria-checked={settings.theme === theme.value} className={clsx("theme-option", settings.theme === theme.value && "is-active")} disabled={disabled} key={theme.value} onClick={() => onUpdate({ theme: theme.value })}><ThemeIcon size={18} /><span>{theme.label}</span>{settings.theme === theme.value && <Check size={15} />}</button>; })}
              </div>
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
                <span><strong>Workspace startup</strong><small>Begin with a compact environment summary or open the last workspace tool.</small></span>
                <div role="radiogroup" aria-label="Workspace startup surface">
                  <button type="button" role="radio" aria-checked={settings.workspaceStartupSurface === "summary"} className={clsx(settings.workspaceStartupSurface === "summary" && "is-active")} disabled={disabled} onClick={() => onUpdate({ workspaceStartupSurface: "summary" })}>Summary</button>
                  <button type="button" role="radio" aria-checked={settings.workspaceStartupSurface === "tools"} className={clsx(settings.workspaceStartupSurface === "tools" && "is-active")} disabled={disabled} onClick={() => onUpdate({ workspaceStartupSurface: "tools" })}>Workspace tools</button>
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
              </div>
            </section>

            <section className="settings-card" aria-labelledby="terminal-heading">
              <div className="settings-card-heading"><div><TerminalSquare size={18} /></div><span><h3 id="terminal-heading">Terminal</h3><p>Keep command output comfortable to read.</p></span></div>
              <div className="range-setting"><label htmlFor="terminal-font-size">Terminal font size</label><output htmlFor="terminal-font-size">{settings.terminalFontSize}px</output><input id="terminal-font-size" type="range" min="11" max="22" step="1" value={settings.terminalFontSize} disabled={disabled} onChange={(event) => onUpdate({ terminalFontSize: Number(event.target.value) })} /><div className="range-labels"><span>Compact</span><span>Comfortable</span></div></div>
            </section>

            <section className="settings-card" aria-labelledby="application-update-heading">
              <div className="settings-card-heading"><div><Download size={18} /></div><span><h3 id="application-update-heading">Application updates</h3><p>Check the official Inertia release without downloading or installing anything automatically.</p></span></div>
              <div className="codex-binary-path application-update-setting">
                <span>
                  <strong>Inertia v{INERTIA_VERSION}</strong>
                  <small>
                    {updateCheckStatus
                      ?? appUpdateStatus?.message
                      ?? "Inertia checks quietly after launch. You stay in control of every download and install."}
                  </small>
                </span>
                <div>
                  {appUpdateStatus?.state === "available" && (
                    <button type="button" className="secondary-button" onClick={() => { void onOpenAppRelease(); }}><Download size={14} />View release</button>
                  )}
                  <button type="button" className="secondary-button" disabled={checkingUpdate || checkingAppUpdate} onClick={() => { void checkAppUpdate(); }}><RefreshCw size={14} />{checkingUpdate || checkingAppUpdate ? "Checking…" : "Check now"}</button>
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
                  const identityLabel = settings.providerIdentityLabels[provider.id];
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
                            key={`${provider.id}:${identityLabel ?? ""}`}
                            defaultValue={identityLabel ?? ""}
                            maxLength={48}
                            placeholder={`${provider.label} account`}
                            disabled={disabled}
                            onBlur={(event) => {
                              const next = event.currentTarget.value.trim();
                              if (next === (identityLabel ?? "")) return;
                              const providerIdentityLabels = {
                                ...settings.providerIdentityLabels,
                              };
                              if (next) providerIdentityLabels[provider.id] = next;
                              else delete providerIdentityLabels[provider.id];
                              onUpdate({ providerIdentityLabels });
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
              <p className="settings-card-note">Authentication remains with each provider. Inertia never stores account passwords or provider tokens.</p>
            </section>

            <section className="settings-card codex-binary-setting" aria-labelledby="codex-binary-heading">
              <div className="settings-card-heading"><div><Bot size={18} /></div><span><h3 id="codex-binary-heading">Codex executable</h3><p>Automatic discovery checks official, package-manager, custom-home, and PATH installations.</p></span></div>
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
              <div className="settings-card-heading"><div><Bot size={18} /></div><span><h3 id="defaults-heading">New chat defaults</h3><p>These choices apply only when a new chat is created.</p></span></div>
              <div className="settings-form-grid">
                <label><span>Provider</span><select value={settings.defaultProvider} disabled={disabled} onChange={(event) => onUpdate({ defaultProvider: event.target.value as ProviderId, defaultModel: "", defaultReasoningEffort: "" })}>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.label} — {providerStateLabel(provider)}</option>)}</select></label>
                <label><span>Model</span><select value={defaultModel?.id ?? ""} disabled={disabled || !defaultProvider?.models.length} onChange={(event) => { const model = defaultProvider?.models.find(({ id }) => id === event.target.value); onUpdate({ defaultModel: event.target.value, defaultReasoningEffort: model?.defaultReasoningEffort ?? "" }); }}><option value="">Provider default</option>{defaultProvider?.models.map((model) => <option value={model.id} key={model.id}>{model.label}{model.isDefault ? " — Default" : ""}</option>)}</select></label>
                <label><span>Reasoning</span><select value={settings.defaultReasoningEffort || defaultModel?.defaultReasoningEffort || ""} disabled={disabled || reasoningOptions.length === 0} onChange={(event) => onUpdate({ defaultReasoningEffort: event.target.value })}><option value="">Model default</option>{reasoningOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
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

        {section === "source" && (
          <section className="settings-card" aria-labelledby="source-heading">
            <div className="settings-card-heading"><div><GitCompareArrows size={18} /></div><span><h3 id="source-heading">Changes</h3><p>Keep diffs readable without hiding the work being reviewed.</p></span></div>
            <div className="settings-rows"><SettingSwitch title="Wrap long diff lines" detail="Keep wide changes readable without horizontal scrolling." checked={settings.wrapDiffs} disabled={disabled} onChange={(wrapDiffs) => onUpdate({ wrapDiffs })} /><SettingSwitch title="Ignore whitespace" detail="Hide whitespace-only changes when supported." checked={settings.ignoreWhitespace} disabled={disabled} onChange={(ignoreWhitespace) => onUpdate({ ignoreWhitespace })} /></div>
            <p className="settings-card-note">Commits, pushes, branches, and worktrees always use the current project repository.</p>
          </section>
        )}

        {section === "keybindings" && (
          <section className="settings-card" aria-labelledby="keybindings-heading">
            <div className="settings-card-heading"><div><Keyboard size={18} /></div><span><h3 id="keybindings-heading">Keyboard shortcuts</h3><p>Fast paths for the actions used most often.</p></span></div>
            <div className="shortcut-list">{shortcuts.map(([action, label]) => <label key={action}><span>{label}</span><span className="shortcut-binding"><kbd>{primaryModifier}</kbd><select aria-label={`${label} key`} value={settings.keybindings[action]} disabled={disabled} onChange={(event) => onUpdate({ keybindings: { ...settings.keybindings, [action]: event.target.value as AppShortcutKey } })}>{APP_SHORTCUT_KEYS.map((key) => <option value={key} key={key} disabled={shortcuts.some(([other]) => other !== action && settings.keybindings[other] === key)}>{key.toUpperCase()}</option>)}</select></span></label>)}</div>
            <button className="secondary-button settings-keybinding-reset" type="button" disabled={disabled || Object.entries(DEFAULT_APP_KEYBINDINGS).every(([action, key]) => settings.keybindings[action as AppShortcutAction] === key)} onClick={() => onUpdate({ keybindings: DEFAULT_APP_KEYBINDINGS })}><RotateCcw size={14} />Reset shortcuts</button>
            <p className="settings-card-note">The primary Cmd/Ctrl modifier stays fixed. Available keys avoid common browser and system shortcuts.</p>
          </section>
        )}

        {section === "archive" && (
          <>
            <section className="settings-card" aria-labelledby="archive-heading">
              <div className="settings-card-heading"><div><ArchiveRestore size={18} /></div><span><h3 id="archive-heading">Archived threads</h3><p>Restore earlier work without losing its provider or project context.</p></span></div>
              {archived.length > 0 ? <div className="archive-list">{archived.map((thread) => <div className="archive-row" key={thread.id}><span><strong>{thread.title}</strong><small>{archivedByProvider.get(thread.providerId) ?? thread.providerId}</small></span><button type="button" className="secondary-button" disabled={disabled} onClick={() => onUnarchive(thread)}><ArchiveRestore size={14} />Restore</button></div>)}</div> : <div className="settings-empty-state"><ArchiveRestore size={19} /><strong>No archived threads</strong><span>Archived work will appear here.</span></div>}
            </section>
            <section className="settings-card" aria-labelledby="data-heading">
              <div className="settings-card-heading"><div><Database size={18} /></div><span><h3 id="data-heading">Local data</h3><p>Full SQLite backups and portable conversation exports serve different recovery needs.</p></span></div>
              <div className="settings-data-note"><ShieldCheck size={17} /><span><strong>Provider credentials stay outside Inertia.</strong><small>Account authentication remains in each provider’s own secure storage.</small></span></div>
              <div className="codex-binary-path runtime-log-setting app-health-setting">
                <span>
                  <strong><Activity size={14} />Local resource health</strong>
                  <small>Sampled only while this page is open. Values cover Inertia processes and fixed app-owned storage; project files are never scanned.</small>
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
                  <small>Automatic validated copies of the complete SQLite database include provider-session references, execution context, Git artifacts, and attachment records. Credential secrets and separately stored attachment bytes remain outside SQLite.</small>
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
                  <small>Exports contain project paths and conversation messages only. They exclude attachments, provider sessions, execution context, Git artifacts, credentials, secret references, and vault data. Imports always create new identities with supervised access.</small>
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
                  <small>Local-only lifecycle and failure metadata. Prompts, source, token values, and credentials are excluded. Logs rotate at 256 KB and expire after seven days.</small>
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
