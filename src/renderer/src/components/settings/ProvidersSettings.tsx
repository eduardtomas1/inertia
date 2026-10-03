import { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import clsx from "clsx";

import type {
  AppSettings,
  ProviderId,
  ProviderInfo,
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
} from "@shared/contracts";
import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { providerVersionLabel } from "../../utils/providerStatus";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import { ProviderMaintenanceNotice } from "../ProviderMaintenanceNotice";
import {
  ProviderActionIcon,
  ProviderStatus,
  providerSetupAction,
  providerStateDetail,
  providerStateLabel,
} from "../ProviderStatus";
import { loadLifecycleIntegritySettings } from "../settingsSectionLoaders";
import { SettingStatus } from "./SettingsLayout";
import { useSettingAction } from "./useSettingAction";

export interface ProvidersSettingsProps {
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  maintenanceOperations: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceOperation>;
  maintenanceStatuses: ReadonlyMap<ProviderMaintenanceProviderId, NonNullable<ProviderInfo["maintenance"]>>;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId?: ProviderId) => void;
  onRefreshProviderMaintenance: (providerId: ProviderMaintenanceProviderId) => Promise<void>;
  onUpdateProvider: (providerId: ProviderMaintenanceProviderId) => Promise<void>;
  onCancelProviderUpdate: (operationId: string) => Promise<void>;
  onOpenProviderUpdateInstructions: (url: string) => void;
  onChooseCodexBinary: () => void;
}

function stableRecordFingerprint(
  value: Readonly<Record<string, string | undefined>>,
): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => (
    left.localeCompare(right, "en")
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

export function ProvidersSettings({
  settings,
  disabled,
  providers,
  maintenanceOperations,
  maintenanceStatuses,
  onUpdate,
  onConnectProvider,
  onRefreshProvider,
  onRefreshProviderMaintenance,
  onUpdateProvider,
  onCancelProviderUpdate,
  onOpenProviderUpdateInstructions,
  onChooseCodexBinary,
}: ProvidersSettingsProps): React.JSX.Element {
  const LifecycleIntegritySettings = useLoadedSurface(loadLifecycleIntegritySettings, true);
  const labelAction = useSettingAction();
  const binaryAction = useSettingAction();
  const defaultsAction = useSettingAction();
  const updateDefaults = (update: Partial<AppSettings>): void => {
    void defaultsAction.run(() => onUpdate(update));
  };
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId | null>(
    () => providers[0]?.id ?? null,
  );
  const [providerDetailTab, setProviderDetailTab] = useState<
    "configuration" | "models"
  >("configuration");
  const providerConfigurationTabRef = useRef<HTMLButtonElement>(null);
  const providerModelsTabRef = useRef<HTMLButtonElement>(null);
  const [providerAdvancedOpen, setProviderAdvancedOpen] = useState(false);
  const [providerIdentityLabelsDraft, setProviderIdentityLabelsDraft] = useState(
    () => settings.providerIdentityLabels,
  );
  const providerIdentityLabelsDraftRef = useRef(providerIdentityLabelsDraft);
  const authoritativeProviderIdentityLabelsRef = useRef(
    settings.providerIdentityLabels,
  );
  const dirtyProviderIdentityLabelsRef = useRef(new Set<ProviderId>());
  const pendingProviderIdentityLabelsRef = useRef<string | null>(null);
  const providerIdentityLabelsFingerprint = stableRecordFingerprint(
    settings.providerIdentityLabels,
  );
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
  const defaultProvider = providers.find(({ id }) => id === settings.defaultProvider);
  const selectedProvider = providers.find(({ id }) => id === selectedProviderId)
    ?? providers[0]
    ?? null;
  const selectedProviderAction = selectedProvider
    ? providerSetupAction(selectedProvider)
    : null;
  const selectedProviderIdentityLabel = selectedProvider
    ? providerIdentityLabelsDraft[selectedProvider.id]
    : undefined;
  const onProviderDetailTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    let nextTab: "configuration" | "models" | null = null;
    if (event.key === "Home") nextTab = "configuration";
    else if (event.key === "End") nextTab = "models";
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextTab = providerDetailTab === "configuration"
        ? "models"
        : "configuration";
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextTab = providerDetailTab === "configuration"
        ? "models"
        : "configuration";
    }
    if (!nextTab) return;
    event.preventDefault();
    setProviderDetailTab(nextTab);
    (nextTab === "configuration"
      ? providerConfigurationTabRef
      : providerModelsTabRef).current?.focus();
  };
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
  const updateProviderIdentityLabelDraft = (
    providerId: ProviderId,
    value: string,
  ): void => {
    const providerIdentityLabels = {
      ...providerIdentityLabelsDraftRef.current,
      [providerId]: value,
    };
    providerIdentityLabelsDraftRef.current = providerIdentityLabels;
    dirtyProviderIdentityLabelsRef.current.add(providerId);
    setProviderIdentityLabelsDraft(providerIdentityLabels);
  };
  const commitProviderIdentityLabel = (
    providerId: ProviderId,
    value: string,
  ): void => {
    const next = value.trim();
    const providerIdentityLabels = {
      ...providerIdentityLabelsDraftRef.current,
    };
    if (next) providerIdentityLabels[providerId] = next;
    else delete providerIdentityLabels[providerId];
    providerIdentityLabelsDraftRef.current = providerIdentityLabels;
    dirtyProviderIdentityLabelsRef.current.delete(providerId);
    setProviderIdentityLabelsDraft(providerIdentityLabels);
    const fingerprint = stableRecordFingerprint(providerIdentityLabels);
    if (
      fingerprint === providerIdentityLabelsFingerprint
      || fingerprint === pendingProviderIdentityLabelsRef.current
    ) return;
    pendingProviderIdentityLabelsRef.current = fingerprint;
    void labelAction.run(() => onUpdate({ providerIdentityLabels })).then((saved) => {
      if (saved || pendingProviderIdentityLabelsRef.current !== fingerprint) return;
      pendingProviderIdentityLabelsRef.current = null;
      const authoritative = authoritativeProviderIdentityLabelsRef.current;
      const providerIdentityLabels = overlayDirtyProviderIdentityLabels(
        authoritative,
        providerIdentityLabelsDraftRef.current,
        dirtyProviderIdentityLabelsRef.current,
      );
      providerIdentityLabelsDraftRef.current = providerIdentityLabels;
      setProviderIdentityLabelsDraft(providerIdentityLabels);
    });
  };
  return (
    <section
      className="settings-card provider-settings-section"
      aria-labelledby="providers-heading"
      data-setting-id="provider-accounts"
    >
      <div className="settings-card-heading provider-settings-heading">
        <span>
          <h3 id="providers-heading">Providers</h3>
          <p>Use the coding tools and accounts already installed on this computer.</p>
        </span>
        <span className="provider-settings-heading-actions">
          <small>Local provider status</small>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh all providers"
            title="Refresh all providers"
            disabled={disabled}
            onClick={() => onRefreshProvider()}
          >
            <RefreshCw size={13} />
          </button>
        </span>
      </div>

      <div className="provider-settings-shell">
        <div className="provider-settings-rail" aria-label="Provider accounts">
          {providers.map((provider) => {
            const identityLabel = providerIdentityLabelsDraft[provider.id];
            const selected = selectedProvider?.id === provider.id;
            return (
              <div
                className={clsx(
                  "provider-settings-list-row",
                  selected && "is-selected",
                )}
                key={provider.id}
              >
                <button
                  type="button"
                  aria-label={`Configure ${provider.label}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedProviderId(provider.id);
                    setProviderDetailTab("configuration");
                  }}
                >
                  <ProviderBrandIcon
                    providerId={provider.id}
                    label={`${provider.label} icon`}
                    size={17}
                  />
                  <span>
                    <span className="provider-settings-list-title">
                      <strong>{identityLabel ?? provider.label}</strong>
                      {provider.version && <code>{providerVersionLabel(provider.version)}</code>}
                    </span>
                    <small>
                      {identityLabel ? `${provider.label} · ` : ""}
                      {providerStateDetail(provider)}
                    </small>
                  </span>
                </button>
                <ProviderStatus provider={provider} compact />
              </div>
            );
          })}
        </div>

        <div className="provider-settings-editor">
          {selectedProvider ? (
            <>
              <header className="provider-settings-editor-header">
                <span className="provider-settings-editor-copy">
                  <span className="provider-settings-editor-title">
                    <ProviderBrandIcon
                      providerId={selectedProvider.id}
                      label={`${selectedProvider.label} icon`}
                      size={17}
                    />
                    <strong>
                      {selectedProviderIdentityLabel ?? selectedProvider.label}
                    </strong>
                    {selectedProvider.version && (
                      <code>{providerVersionLabel(selectedProvider.version)}</code>
                    )}
                  </span>
                  <small>
                    {selectedProviderIdentityLabel
                      ? `${selectedProvider.label} · `
                      : ""}
                    {providerStateDetail(selectedProvider)}
                  </small>
                </span>
                {selectedProviderAction && (
                  <button
                    type="button"
                    className="secondary-button provider-settings-account-action"
                    disabled={disabled}
                    onClick={() => selectedProviderAction === "connect"
                      ? onConnectProvider(selectedProvider.id)
                      : onRefreshProvider(selectedProvider.id)}
                  >
                    <ProviderActionIcon action={selectedProviderAction} />
                    {selectedProviderAction === "connect"
                      ? selectedProvider.id === "opencode"
                        ? "Configure"
                        : "Connect"
                      : "Refresh"}
                  </button>
                )}
              </header>

              <div className="provider-settings-tabs" role="tablist" aria-label={`${selectedProvider.label} settings`}>
                <button
                  ref={providerConfigurationTabRef}
                  type="button"
                  role="tab"
                  id="provider-settings-configuration-tab"
                  aria-controls="provider-settings-configuration-panel"
                  aria-selected={providerDetailTab === "configuration"}
                  tabIndex={providerDetailTab === "configuration" ? 0 : -1}
                  className={clsx(providerDetailTab === "configuration" && "is-active")}
                  onClick={() => setProviderDetailTab("configuration")}
                  onKeyDown={onProviderDetailTabKeyDown}
                >
                  Configuration
                </button>
                <button
                  ref={providerModelsTabRef}
                  type="button"
                  role="tab"
                  id="provider-settings-models-tab"
                  aria-controls="provider-settings-models-panel"
                  aria-selected={providerDetailTab === "models"}
                  tabIndex={providerDetailTab === "models" ? 0 : -1}
                  className={clsx(providerDetailTab === "models" && "is-active")}
                  onClick={() => setProviderDetailTab("models")}
                  onKeyDown={onProviderDetailTabKeyDown}
                >
                  Models
                  {selectedProvider.models.length > 0 && (
                    <small>{selectedProvider.models.length}</small>
                  )}
                </button>
              </div>

              {providerDetailTab === "configuration" ? (
                <div
                  className="provider-settings-editor-body"
                  role="tabpanel"
                  id="provider-settings-configuration-panel"
                  aria-labelledby="provider-settings-configuration-tab"
                >
                  <label className="provider-settings-field" data-setting-id="provider-display-name">
                    <span className="setting-title">Display name<SettingStatus notice={labelAction.notice} /></span>
                    <input
                      aria-label="Name in Inertia"
                      value={selectedProviderIdentityLabel ?? ""}
                      maxLength={48}
                      placeholder={`${selectedProvider.label} account`}
                      disabled={disabled}
                      onChange={(event) => updateProviderIdentityLabelDraft(
                        selectedProvider.id,
                        event.currentTarget.value,
                      )}
                      onBlur={(event) => commitProviderIdentityLabel(
                        selectedProvider.id,
                        event.currentTarget.value,
                      )}
                    />
                    <small>Optional label shown anywhere Inertia identifies this account.</small>
                  </label>

                  <div className="provider-settings-field">
                    <span>Account status</span>
                    <div className="provider-settings-status-line">
                      <ProviderStatus provider={selectedProvider} />
                      {selectedProvider.statusMessage && (
                        <small>{selectedProvider.statusMessage}</small>
                      )}
                    </div>
                    <small>Authentication remains in the provider&apos;s official flow.</small>
                  </div>

                  {LifecycleIntegritySettings && (
                    <LifecycleIntegritySettings
                      surface="provider-capability"
                      provider={selectedProvider}
                    />
                  )}

                  <div className="provider-settings-field" data-setting-id="provider-binary-path">
                    <span className="setting-title">Binary path<SettingStatus notice={binaryAction.notice} /></span>
                    <div className="provider-settings-binary-row">
                      <input
                        aria-label={`${selectedProvider.label} executable path`}
                        value={selectedProvider.id === "codex"
                          ? settings.codexBinaryPath
                            || selectedProvider.executable
                            || ""
                          : selectedProvider.executable ?? ""}
                        placeholder={`No working ${selectedProvider.label} executable detected`}
                        readOnly
                        title={selectedProvider.executable ?? undefined}
                      />
                      {selectedProvider.id === "codex" && (
                        <div>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={disabled}
                            onClick={onChooseCodexBinary}
                          >
                            <FolderOpen size={13} />
                            Browse
                          </button>
                          {settings.codexBinaryPath && (
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={disabled}
                              onClick={() => { void binaryAction.run(() => onUpdate({ codexBinaryPath: "" })); }}
                            >
                              <Trash2 size={13} />
                              Use automatic
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <small>
                      {selectedProvider.id === "codex"
                        ? "Checks official, package-manager, custom-home, and PATH installs. Manual selections are version-checked before saving."
                        : `Detected from the ${selectedProvider.label} installation available to Inertia.`}
                    </small>
                  </div>

                  <div className="provider-settings-maintenance" data-setting-id="provider-updates">
                    <ProviderMaintenanceNotice
                      providerLabel={selectedProvider.label}
                      status={maintenanceStatuses.get(selectedProvider.id) ?? null}
                      operation={maintenanceOperations.get(selectedProvider.id) ?? null}
                      disabled={disabled}
                      dismissible={false}
                      showManagedUpdateAction
                      showStatus
                      onRefresh={() => onRefreshProviderMaintenance(selectedProvider.id)}
                      onUpdate={() => onUpdateProvider(selectedProvider.id)}
                      onCancel={onCancelProviderUpdate}
                      onOpenInstructions={onOpenProviderUpdateInstructions}
                    />
                  </div>

                  <p className="provider-settings-privacy-note">
                    Inertia stores no provider account passwords or tokens.
                  </p>
                </div>
              ) : (
                <div
                  className="provider-settings-editor-body provider-settings-models"
                  role="tabpanel"
                  id="provider-settings-models-panel"
                  aria-labelledby="provider-settings-models-tab"
                >
                  {selectedProvider.models.length > 0 ? (
                    selectedProvider.models.map((model) => (
                      <div className="provider-settings-model-row" key={model.id}>
                        <span>
                          <strong>{model.label}</strong>
                          {model.isDefault && <small>Default</small>}
                        </span>
                        <code>{model.id}</code>
                        <p>{model.description || "Available from the provider."}</p>
                        <small>
                          {model.reasoningOptions.length > 0
                            ? `${model.reasoningOptions.length} reasoning levels`
                            : "Provider-managed reasoning"}
                          {model.inputModalities.includes("image")
                            ? " · Image input"
                            : ""}
                        </small>
                      </div>
                    ))
                  ) : (
                    <div className="provider-settings-empty-models">
                      <Bot size={20} />
                      <strong>No models reported yet</strong>
                      <small>Refresh or connect this provider to load its model catalog.</small>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="provider-settings-empty-models">
              <Bot size={20} />
              <strong>No providers detected</strong>
              <small>Refresh to check the supported provider installations.</small>
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        className="provider-settings-advanced-toggle"
        aria-controls="provider-settings-advanced"
        aria-expanded={providerAdvancedOpen}
        onClick={() => setProviderAdvancedOpen((open) => !open)}
      >
        <ChevronDown
          size={13}
          className={clsx(providerAdvancedOpen && "is-open")}
        />
        Advanced
      </button>
      {providerAdvancedOpen && (
        <div className="provider-settings-advanced" id="provider-settings-advanced">
          <div className="provider-settings-advanced-heading" data-setting-id="new-chat-defaults">
            <strong className="setting-title">New chat defaults<SettingStatus notice={defaultsAction.notice} /></strong>
            <small>Applied only when a new chat is created.</small>
          </div>
          <div className="settings-form-grid">
            <label><span>Provider</span><select value={settings.defaultProvider} disabled={disabled} onChange={(event) => updateDefaults({ defaultProvider: event.target.value as ProviderId, defaultModel: "", defaultReasoningEffort: "" })}>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.label} — {providerStateLabel(provider)}</option>)}</select></label>
            <label><span>Model</span><select value={settings.defaultModel} disabled={disabled || !defaultProvider?.models.length} onChange={(event) => { const model = defaultProvider?.models.find(({ id }) => id === event.target.value); updateDefaults({ defaultModel: event.target.value, defaultReasoningEffort: model?.defaultReasoningEffort ?? "" }); }}><option value="">{providerDefaultModelLabel}</option>{settings.defaultModel && !storedDefaultModel && <option value={settings.defaultModel}>{settings.defaultModel} — Unavailable</option>}{defaultProvider?.models.map((model) => <option value={model.id} key={model.id}>{model.label}{model.isDefault ? " — Default" : ""}</option>)}</select></label>
            <label><span>Reasoning</span><select value={settings.defaultReasoningEffort} disabled={disabled || reasoningOptions.length === 0} onChange={(event) => updateDefaults({ defaultReasoningEffort: event.target.value })}><option value="">Model default{modelDefaultReasoningLabel ? ` — ${modelDefaultReasoningLabel}` : ""}</option>{settings.defaultReasoningEffort && !reasoningOptions.some(({ value }) => value === settings.defaultReasoningEffort) && <option value={settings.defaultReasoningEffort}>{settings.defaultReasoningEffort} — Unavailable</option>}{reasoningOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
            <label><span>Mode</span><select value={settings.defaultInteractionMode} disabled={disabled} onChange={(event) => updateDefaults({ defaultInteractionMode: event.target.value as AppSettings["defaultInteractionMode"] })}><option value="build">Build</option><option value="plan">Plan</option></select></label>
            <label><span>Access</span><select value={settings.defaultAccessMode} disabled={disabled} onChange={(event) => updateDefaults({ defaultAccessMode: event.target.value as AppSettings["defaultAccessMode"] })}><option value="supervised">Supervised</option><option value="auto-edit">Auto-accept edits</option><option value="full">Full access</option></select></label>
            <label><span>Chat location</span><select value={settings.newThreadMode} disabled={disabled} onChange={(event) => updateDefaults({ newThreadMode: event.target.value as AppSettings["newThreadMode"] })}><option value="local">Current checkout</option><option value="worktree">Isolated worktree</option></select></label>
          </div>
        </div>
      )}
    </section>
  );
}
