import { useMemo, useState } from "react";
import {
  ArchiveRestore,
  Bot,
  BrainCircuit,
  Check,
  Clock3,
  Database,
  Gauge,
  GitCompareArrows,
  Keyboard,
  Laptop,
  Moon,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sun,
  TerminalSquare,
} from "lucide-react";
import clsx from "clsx";

import { defaultSettings, type AppSettings, type Conversation, type ProviderId, type ProviderInfo, type ThemePreference } from "@shared/contracts";
import { ProviderActionIcon, ProviderStatus, providerSetupAction, providerStateDetail, providerStateLabel } from "./ProviderStatus";
import { Switch } from "./ui";

type SettingsViewProps = {
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  archived: Conversation[];
  onUpdate: (settings: Partial<AppSettings>) => void;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId?: ProviderId) => void;
  onUnarchive: (conversation: Conversation) => void;
};

type SettingsSection = "general" | "providers" | "source" | "keybindings" | "archive";

const themes: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Laptop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const sections: Array<{ id: SettingsSection; label: string; icon: typeof Sun }> = [
  { id: "general", label: "General", icon: PanelLeft },
  { id: "providers", label: "Providers", icon: Bot },
  { id: "source", label: "Source control", icon: GitCompareArrows },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "archive", label: "Archive & data", icon: ArchiveRestore },
];

const shortcuts = [
  ["Search everything", "⌘ K"],
  ["New thread", "⌘ N"],
  ["Toggle project navigation", "⌘ B"],
  ["Toggle terminal", "⌘ J"],
] as const;

export function SettingsView({ settings, disabled, providers, archived, onUpdate, onConnectProvider, onRefreshProvider, onUnarchive }: SettingsViewProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>("general");
  const defaultProvider = providers.find(({ id }) => id === settings.defaultProvider);
  const defaultModel = defaultProvider?.models.find(({ id }) => id === settings.defaultModel)
    ?? defaultProvider?.models.find(({ isDefault }) => isDefault)
    ?? defaultProvider?.models[0];
  const reasoningOptions = defaultModel?.reasoningOptions ?? [];
  const title = sections.find(({ id }) => id === section)?.label ?? "Settings";
  const archivedByProvider = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.label])), [providers]);

  return (
    <main className="settings-view">
      <aside className="settings-navigation" aria-label="Settings sections">
        <div className="settings-navigation-heading"><strong>Settings</strong><small>Inertia v0.0.3</small></div>
        <nav>
          {sections.map((item) => {
            const Icon = item.icon;
            return <button type="button" className={clsx(section === item.id && "is-active")} aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)} key={item.id}><Icon size={15} /><span>{item.label}</span>{item.id === "archive" && archived.length > 0 && <small>{archived.length}</small>}</button>;
          })}
        </nav>
        <p>Preferences and project history stay on this device.</p>
      </aside>

      <div className="settings-content">
        <div className="settings-heading settings-heading-row">
          <span><span className="welcome-kicker">Make it yours</span><h2>{title}</h2><p>Keep the workspace calm, capable, and predictable.</p></span>
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => onUpdate(defaultSettings)}><RotateCcw size={14} />Restore defaults</button>
        </div>

        {section === "general" && (
          <>
            <section className="settings-card" aria-labelledby="appearance-heading">
              <div className="settings-card-heading"><div><Sun size={18} /></div><span><h3 id="appearance-heading">Appearance</h3><p>Use system, light, or dark—nothing tinted or distracting.</p></span></div>
              <div className="theme-options" role="radiogroup" aria-label="Theme">
                {themes.map((theme) => { const ThemeIcon = theme.icon; return <button type="button" role="radio" aria-checked={settings.theme === theme.value} className={clsx("theme-option", settings.theme === theme.value && "is-active")} disabled={disabled} key={theme.value} onClick={() => onUpdate({ theme: theme.value })}><ThemeIcon size={18} /><span>{theme.label}</span>{settings.theme === theme.value && <Check size={15} />}</button>; })}
              </div>
            </section>

            <section className="settings-card" aria-labelledby="workspace-heading">
              <div className="settings-card-heading"><div><PanelLeft size={18} /></div><span><h3 id="workspace-heading">Workspace</h3><p>Choose which quiet details help you stay oriented.</p></span></div>
              <div className="settings-rows">
                <SettingSwitch icon={<PanelLeft size={17} />} title="Compact project navigation" detail="Reduce spacing while keeping project names readable." checked={settings.compactSidebar} disabled={disabled} onChange={(compactSidebar) => onUpdate({ compactSidebar })} />
                <SettingSwitch icon={<Clock3 size={17} />} title="Message timestamps" detail="Show a quiet time label alongside each message." checked={settings.showTimestamps} disabled={disabled} onChange={(showTimestamps) => onUpdate({ showTimestamps })} />
                <SettingSwitch icon={<BrainCircuit size={17} />} title="Live thinking summaries" detail="Show provider-supplied reasoning summaries as they arrive." checked={settings.showThinking} disabled={disabled} onChange={(showThinking) => onUpdate({ showThinking })} />
                <SettingSwitch icon={<Gauge size={17} />} title="Usage and context" detail="Show remaining account usage and context when reported." checked={settings.showUsage} disabled={disabled} onChange={(showUsage) => onUpdate({ showUsage })} />
                <SettingSwitch icon={<Bot size={17} />} title="Open plan automatically" detail="Reveal the Plan panel when an agent publishes steps." checked={settings.autoOpenPlan} disabled={disabled} onChange={(autoOpenPlan) => onUpdate({ autoOpenPlan })} />
                <SettingSwitch icon={<ShieldCheck size={17} />} title="Confirm destructive actions" detail="Ask before deleting threads or restoring checkpoints." checked={settings.confirmDestructiveActions} disabled={disabled} onChange={(confirmDestructiveActions) => onUpdate({ confirmDestructiveActions })} />
              </div>
            </section>

            <section className="settings-card" aria-labelledby="terminal-heading">
              <div className="settings-card-heading"><div><TerminalSquare size={18} /></div><span><h3 id="terminal-heading">Terminal</h3><p>Keep command output comfortable to read.</p></span></div>
              <div className="range-setting"><label htmlFor="terminal-font-size">Terminal font size</label><output htmlFor="terminal-font-size">{settings.terminalFontSize}px</output><input id="terminal-font-size" type="range" min="11" max="22" step="1" value={settings.terminalFontSize} disabled={disabled} onChange={(event) => onUpdate({ terminalFontSize: Number(event.target.value) })} /><div className="range-labels"><span>Compact</span><span>Comfortable</span></div></div>
            </section>
          </>
        )}

        {section === "providers" && (
          <>
            <section className="settings-card" aria-labelledby="agents-heading">
              <div className="settings-card-heading"><div><Bot size={18} /></div><span><h3 id="agents-heading">Agent accounts</h3><p>Use the coding tools and accounts already installed on this computer.</p></span><button type="button" className="secondary-button provider-refresh-all" aria-label="Refresh all agents" disabled={disabled} onClick={() => onRefreshProvider()}><RefreshCw size={14} />Refresh</button></div>
              <div className="settings-rows provider-account-list">
                {providers.map((provider) => { const action = providerSetupAction(provider); return <div className="setting-row provider-account-row" key={provider.id}><span className="setting-row-icon"><Bot size={17} /></span><span className="setting-copy provider-account-copy"><span className="provider-account-title"><strong>{provider.label}</strong><ProviderStatus provider={provider} /></span><small>{providerStateDetail(provider)}{provider.models.length > 0 ? ` · ${provider.models.length} models available` : ""}</small></span>{action && <button type="button" className="secondary-button provider-account-action" disabled={disabled} onClick={() => action === "connect" ? onConnectProvider(provider.id) : onRefreshProvider(provider.id)}><ProviderActionIcon action={action} />{action === "connect" ? provider.id === "opencode" ? "Configure" : "Connect" : "Refresh"}</button>}</div>; })}
              </div>
              <p className="settings-card-note">Authentication remains with each provider. Inertia never stores account passwords or provider tokens.</p>
            </section>

            <section className="settings-card" aria-labelledby="defaults-heading">
              <div className="settings-card-heading"><div><Bot size={18} /></div><span><h3 id="defaults-heading">New thread defaults</h3><p>These choices apply only when a new thread is created.</p></span></div>
              <div className="settings-form-grid">
                <label><span>Provider</span><select value={settings.defaultProvider} disabled={disabled} onChange={(event) => onUpdate({ defaultProvider: event.target.value as ProviderId, defaultModel: "", defaultReasoningEffort: "" })}>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.label} — {providerStateLabel(provider)}</option>)}</select></label>
                <label><span>Model</span><select value={defaultModel?.id ?? ""} disabled={disabled || !defaultProvider?.models.length} onChange={(event) => { const model = defaultProvider?.models.find(({ id }) => id === event.target.value); onUpdate({ defaultModel: event.target.value, defaultReasoningEffort: model?.defaultReasoningEffort ?? "" }); }}><option value="">Provider default</option>{defaultProvider?.models.map((model) => <option value={model.id} key={model.id}>{model.label}{model.isDefault ? " — Default" : ""}</option>)}</select></label>
                <label><span>Reasoning</span><select value={settings.defaultReasoningEffort || defaultModel?.defaultReasoningEffort || ""} disabled={disabled || reasoningOptions.length === 0} onChange={(event) => onUpdate({ defaultReasoningEffort: event.target.value })}><option value="">Model default</option>{reasoningOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
                <label><span>Mode</span><select value={settings.defaultInteractionMode} disabled={disabled} onChange={(event) => onUpdate({ defaultInteractionMode: event.target.value as AppSettings["defaultInteractionMode"] })}><option value="build">Build</option><option value="plan">Plan</option></select></label>
                <label><span>Access</span><select value={settings.defaultAccessMode} disabled={disabled} onChange={(event) => onUpdate({ defaultAccessMode: event.target.value as AppSettings["defaultAccessMode"] })}><option value="supervised">Supervised</option><option value="auto-edit">Auto-accept edits</option><option value="full">Full access</option></select></label>
                <label><span>Thread location</span><select value={settings.newThreadMode} disabled={disabled} onChange={(event) => onUpdate({ newThreadMode: event.target.value as AppSettings["newThreadMode"] })}><option value="local">Current checkout</option><option value="worktree">Isolated worktree</option></select></label>
              </div>
            </section>
          </>
        )}

        {section === "source" && (
          <section className="settings-card" aria-labelledby="source-heading">
            <div className="settings-card-heading"><div><GitCompareArrows size={18} /></div><span><h3 id="source-heading">Changes</h3><p>Keep diffs readable without hiding the work being reviewed.</p></span></div>
            <div className="settings-rows"><SettingSwitch icon={<GitCompareArrows size={17} />} title="Wrap long diff lines" detail="Keep wide changes readable without horizontal scrolling." checked={settings.wrapDiffs} disabled={disabled} onChange={(wrapDiffs) => onUpdate({ wrapDiffs })} /><SettingSwitch icon={<GitCompareArrows size={17} />} title="Ignore whitespace" detail="Hide whitespace-only changes when supported." checked={settings.ignoreWhitespace} disabled={disabled} onChange={(ignoreWhitespace) => onUpdate({ ignoreWhitespace })} /></div>
            <p className="settings-card-note">Commits, pushes, branches, and worktrees always use the current project repository.</p>
          </section>
        )}

        {section === "keybindings" && (
          <section className="settings-card" aria-labelledby="keybindings-heading">
            <div className="settings-card-heading"><div><Keyboard size={18} /></div><span><h3 id="keybindings-heading">Keyboard shortcuts</h3><p>Fast paths for the actions used most often.</p></span></div>
            <div className="shortcut-list">{shortcuts.map(([label, keys]) => <div key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}</div>
            <p className="settings-card-note">Custom bindings are planned; the current set avoids conflicting with provider terminals.</p>
          </section>
        )}

        {section === "archive" && (
          <>
            <section className="settings-card" aria-labelledby="archive-heading">
              <div className="settings-card-heading"><div><ArchiveRestore size={18} /></div><span><h3 id="archive-heading">Archived threads</h3><p>Restore earlier work without losing its provider or project context.</p></span></div>
              {archived.length > 0 ? <div className="archive-list">{archived.map((thread) => <div className="archive-row" key={thread.id}><span><strong>{thread.title}</strong><small>{archivedByProvider.get(thread.providerId) ?? thread.providerId}</small></span><button type="button" className="secondary-button" disabled={disabled} onClick={() => onUnarchive(thread)}><ArchiveRestore size={14} />Restore</button></div>)}</div> : <div className="settings-empty-state"><ArchiveRestore size={19} /><strong>No archived threads</strong><span>Archived work will appear here.</span></div>}
            </section>
            <section className="settings-card" aria-labelledby="data-heading"><div className="settings-card-heading"><div><Database size={18} /></div><span><h3 id="data-heading">Local data</h3><p>Projects, sessions, context usage, and preferences are stored locally.</p></span></div><div className="settings-data-note"><ShieldCheck size={17} /><span><strong>Provider credentials stay outside Inertia.</strong><small>Account authentication remains in each provider’s own secure storage.</small></span></div></section>
          </>
        )}
      </div>
    </main>
  );
}

function SettingSwitch({ icon, title, detail, checked, disabled, onChange }: { icon: React.JSX.Element; title: string; detail: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }): React.JSX.Element {
  return <div className="setting-row"><span className="setting-row-icon">{icon}</span><span className="setting-copy"><strong>{title}</strong><small>{detail}</small></span><Switch label={title} checked={checked} disabled={disabled} onChange={onChange} /></div>;
}
