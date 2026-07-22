import { ArchiveRestore, Bot, Check, Clock3, GitCompareArrows, Laptop, Moon, PanelLeft, RefreshCw, Sun, TerminalSquare } from "lucide-react";
import clsx from "clsx";
import type { AppSettings, Conversation, ProviderId, ProviderInfo, ThemePreference } from "@shared/contracts";
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

const themes: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Laptop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function SettingsView({ settings, disabled, providers, archived, onUpdate, onConnectProvider, onRefreshProvider, onUnarchive }: SettingsViewProps): React.JSX.Element {
  return (
    <main className="settings-view">
      <div className="settings-content">
        <div className="settings-heading">
          <span className="welcome-kicker">Make it yours</span>
          <h2>A workspace that stays out of the way.</h2>
          <p>These preferences are saved locally and follow every project.</p>
        </div>

        <section className="settings-card" aria-labelledby="appearance-heading">
          <div className="settings-card-heading">
            <div><Sun size={18} /></div>
            <span><h3 id="appearance-heading">Appearance</h3><p>Choose the contrast that feels right.</p></span>
          </div>
          <div className="theme-options" role="radiogroup" aria-label="Theme">
            {themes.map((theme) => {
              const ThemeIcon = theme.icon;
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === theme.value}
                  className={clsx("theme-option", settings.theme === theme.value && "is-active")}
                  disabled={disabled}
                  key={theme.value}
                  onClick={() => onUpdate({ theme: theme.value })}
                >
                  <ThemeIcon size={18} />
                  <span>{theme.label}</span>
                  {settings.theme === theme.value && <Check size={15} />}
                </button>
              );
            })}
          </div>
        </section>

        <section className="settings-card" aria-labelledby="workspace-heading">
          <div className="settings-card-heading">
            <div><PanelLeft size={18} /></div>
            <span><h3 id="workspace-heading">Workspace</h3><p>Adjust how much context is visible at once.</p></span>
          </div>
          <div className="settings-rows">
            <div className="setting-row">
              <span className="setting-row-icon"><PanelLeft size={17} /></span>
              <span className="setting-copy"><strong>Compact project sidebar</strong><small>Reduce spacing while keeping project names visible.</small></span>
              <Switch
                label="Compact project sidebar"
                checked={settings.compactSidebar}
                disabled={disabled}
                onChange={(compactSidebar) => onUpdate({ compactSidebar })}
              />
            </div>
            <div className="setting-row">
              <span className="setting-row-icon"><Clock3 size={17} /></span>
              <span className="setting-copy"><strong>Message timestamps</strong><small>Show a quiet time label alongside each message.</small></span>
              <Switch
                label="Message timestamps"
                checked={settings.showTimestamps}
                disabled={disabled}
                onChange={(showTimestamps) => onUpdate({ showTimestamps })}
              />
            </div>
          </div>
        </section>

        <section className="settings-card" aria-labelledby="agents-heading">
          <div className="settings-card-heading">
            <div><Bot size={18} /></div>
            <span><h3 id="agents-heading">Agents</h3><p>Connect the local coding tools you already use.</p></span>
            <button type="button" className="secondary-button provider-refresh-all" aria-label="Refresh all agents" disabled={disabled} onClick={() => onRefreshProvider()}>
              <RefreshCw size={14} />Refresh
            </button>
          </div>
          <div className="settings-rows provider-account-list">
            {providers.map((provider) => {
              const action = providerSetupAction(provider);
              return (
                <div className="setting-row provider-account-row" key={provider.id}>
                  <span className="setting-row-icon"><Bot size={17} /></span>
                  <span className="setting-copy provider-account-copy">
                    <span className="provider-account-title"><strong>{provider.label}</strong><ProviderStatus provider={provider} /></span>
                    <small>{providerStateDetail(provider)}</small>
                  </span>
                  {action && (
                    <button
                      type="button"
                      className="secondary-button provider-account-action"
                      aria-label={`${action === "connect" ? provider.id === "opencode" ? "Configure" : "Connect" : "Refresh"} ${provider.label}`}
                      disabled={disabled}
                      onClick={() => action === "connect" ? onConnectProvider(provider.id) : onRefreshProvider(provider.id)}
                    >
                      <ProviderActionIcon action={action} />
                      {action === "connect" ? provider.id === "opencode" ? "Configure" : "Connect" : "Refresh"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="settings-card-note">Sign-in stays with each provider. Inertia does not store your account credentials.</p>
        </section>

        <section className="settings-card" aria-labelledby="agent-heading">
          <div className="settings-card-heading">
            <div><Bot size={18} /></div>
            <span><h3 id="agent-heading">Agent defaults</h3><p>Choose how new threads begin.</p></span>
          </div>
          <div className="settings-form-grid">
            <label><span>Provider</span><select value={settings.defaultProvider} disabled={disabled} onChange={(event) => onUpdate({ defaultProvider: event.target.value as AppSettings["defaultProvider"] })}>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.label} — {providerStateLabel(provider)}</option>)}</select></label>
            <label><span>Model override</span><input value={settings.defaultModel} disabled={disabled} placeholder="Provider default" onChange={(event) => onUpdate({ defaultModel: event.target.value })} /></label>
            <label><span>Access</span><select value={settings.defaultAccessMode} disabled={disabled} onChange={(event) => onUpdate({ defaultAccessMode: event.target.value as AppSettings["defaultAccessMode"] })}><option value="supervised">Supervised</option><option value="auto-edit">Auto-accept edits</option><option value="full">Full access</option></select></label>
            <label><span>New thread location</span><select value={settings.newThreadMode} disabled={disabled} onChange={(event) => onUpdate({ newThreadMode: event.target.value as AppSettings["newThreadMode"] })}><option value="local">Current checkout</option><option value="worktree">Isolated worktree</option></select></label>
          </div>
        </section>

        <section className="settings-card" aria-labelledby="source-heading">
          <div className="settings-card-heading">
            <div><GitCompareArrows size={18} /></div>
            <span><h3 id="source-heading">Changes</h3><p>Control how diffs are presented.</p></span>
          </div>
          <div className="settings-rows">
            <div className="setting-row"><span className="setting-row-icon"><GitCompareArrows size={17} /></span><span className="setting-copy"><strong>Wrap long diff lines</strong><small>Keep wide changes readable without horizontal scrolling.</small></span><Switch label="Wrap long diff lines" checked={settings.wrapDiffs} disabled={disabled} onChange={(wrapDiffs) => onUpdate({ wrapDiffs })} /></div>
            <div className="setting-row"><span className="setting-row-icon"><GitCompareArrows size={17} /></span><span className="setting-copy"><strong>Ignore whitespace</strong><small>Hide whitespace-only changes when supported.</small></span><Switch label="Ignore whitespace" checked={settings.ignoreWhitespace} disabled={disabled} onChange={(ignoreWhitespace) => onUpdate({ ignoreWhitespace })} /></div>
          </div>
        </section>

        <section className="settings-card" aria-labelledby="terminal-heading">
          <div className="settings-card-heading">
            <div><TerminalSquare size={18} /></div>
            <span><h3 id="terminal-heading">Terminal</h3><p>Keep command output comfortable to read.</p></span>
          </div>
          <div className="range-setting">
            <label htmlFor="terminal-font-size">Terminal font size</label>
            <output htmlFor="terminal-font-size">{settings.terminalFontSize}px</output>
            <input
              id="terminal-font-size"
              type="range"
              min="11"
              max="22"
              step="1"
              value={settings.terminalFontSize}
              disabled={disabled}
              onChange={(event) => onUpdate({ terminalFontSize: Number(event.target.value) })}
            />
            <div className="range-labels"><span>Compact</span><span>Comfortable</span></div>
          </div>
        </section>

        {archived.length > 0 && (
          <section className="settings-card" aria-labelledby="archive-heading">
            <div className="settings-card-heading"><div><ArchiveRestore size={18} /></div><span><h3 id="archive-heading">Archived threads</h3><p>Restore past work to its project.</p></span></div>
            <div className="archive-list">{archived.map((thread) => <div className="archive-row" key={thread.id}><span><strong>{thread.title}</strong><small>{providers.find(({ id }) => id === thread.providerId)?.label ?? thread.providerId}</small></span><button type="button" className="secondary-button" disabled={disabled} onClick={() => onUnarchive(thread)}><ArchiveRestore size={14} />Restore</button></div>)}</div>
          </section>
        )}

        <p className="settings-footnote">Inertia V1 · Your settings and project history stay on this device.</p>
      </div>
    </main>
  );
}
