import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import clsx from "clsx";

import type {
  AppSettings,
  ProviderId,
  ProviderInfo,
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
} from "@shared/contracts";
import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import { ProviderMaintenanceNotice } from "../ProviderMaintenanceNotice";
import {
  ProviderActionIcon,
  ProviderStatus,
  providerSetupAction,
  providerStateLabel,
} from "../ProviderStatus";
import { loadLifecycleIntegritySettings } from "../settingsSectionLoaders";
import { useSectionMemory, type SettingsSectionMemory } from "./sectionMemory";
import { IconButton } from "../ui";
import { SettingCopy } from "./SettingsLayout";
import "./ProvidersSettings.css";
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
  memory: SettingsSectionMemory;
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
  memory,
}: ProvidersSettingsProps): React.JSX.Element {
  const LifecycleIntegritySettings = useLoadedSurface(loadLifecycleIntegritySettings, true);
  const labelAction = useSettingAction();
  const binaryAction = useSettingAction();
  const [selectedProviderId, setSelectedProviderId] = useSectionMemory<ProviderId | null>(
    memory,
    "providers.selected",
    () => providers[0]?.id ?? null,
  );
  const [providerDetailTab, setProviderDetailTab] = useSectionMemory<"configuration" | "models">(
    memory,
    "providers.tab",
    () => "configuration",
  );
  const providerConfigurationTabRef = useRef<HTMLButtonElement>(null);
  const providerModelsTabRef = useRef<HTMLButtonElement>(null);
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
  const selectedStateId = useId();
  const selectedProviderMessage = selectedProvider?.statusMessage
    && selectedProvider.installState !== "not-installed"
    && selectedProvider.statusMessage.toLowerCase() !== providerStateLabel(selectedProvider).toLowerCase()
    ? selectedProvider.statusMessage
    : null;
  const binaryValue = selectedProvider
    ? selectedProvider.id === "codex"
      ? settings.codexBinaryPath || selectedProvider.executable || ""
      : selectedProvider.executable ?? ""
    : "";
  return (
    <section
      className="settings-card provider-settings-section"
      aria-labelledby="providers-heading"
      data-setting-id="provider-accounts"
    >
      <div className="settings-card-heading provider-settings-heading">
        <span>
          <h3 id="providers-heading">Providers</h3>
        </span>
        <IconButton
          label="Refresh all providers"
          aria-disabled={disabled || undefined}
          onClick={() => { if (!disabled) onRefreshProvider(); }}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="provider-settings-shell">
        <div className="provider-settings-rail" role="group" aria-label="Provider accounts">
          {providers.map((provider) => {
            const identityLabel = providerIdentityLabelsDraft[provider.id];
            const selected = selectedProvider?.id === provider.id;
            const stateId = `provider-settings-state-${provider.id}`;
            return (
              <button
                type="button"
                className={clsx("provider-settings-list-row", selected && "is-selected")}
                key={provider.id}
                aria-label={`Configure ${provider.label}`}
                aria-describedby={stateId}
                aria-pressed={selected}
                onClick={() => {
                  setSelectedProviderId(provider.id);
                  setProviderDetailTab("configuration");
                }}
              >
                <ProviderBrandIcon
                  providerId={provider.id}
                  label={`${provider.label} icon`}
                  size={16}
                />
                <span className="provider-settings-list-copy">
                  <strong>{identityLabel ?? provider.label}</strong>
                  <ProviderStatus provider={provider} id={stateId} />
                </span>
              </button>
            );
          })}
        </div>

        <div className="provider-settings-editor">
          {selectedProvider ? (
            <>
              <header className="provider-settings-editor-header">
                <ProviderBrandIcon
                  providerId={selectedProvider.id}
                  label={`${selectedProvider.label} icon`}
                  size={16}
                />
                <span className="provider-settings-editor-copy">
                  <strong>
                    {selectedProviderIdentityLabel
                      ? `${selectedProviderIdentityLabel} · ${selectedProvider.label}`
                      : selectedProvider.label}
                  </strong>
                  <ProviderStatus provider={selectedProvider} id={selectedStateId} />
                  {selectedProviderMessage && <small>{selectedProviderMessage}</small>}
                </span>
                {selectedProviderAction && (
                  <button
                    type="button"
                    className="secondary-button provider-settings-account-action"
                    aria-disabled={disabled || undefined}
                    onClick={() => {
                      if (disabled) return;
                      if (selectedProviderAction === "connect") onConnectProvider(selectedProvider.id);
                      else onRefreshProvider(selectedProvider.id);
                    }}
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
                  <div className="setting-row setting-text-field" data-setting-id="provider-display-name">
                    <SettingCopy
                      title="Account name"
                      description="Shown wherever Inertia names this account."
                      notice={labelAction.notice}
                    />
                    <span className="setting-field-control">
                      <input
                        className="setting-input"
                        aria-label="Account name"
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
                    </span>
                  </div>

                  <div className="setting-row provider-settings-binary" data-setting-id="provider-binary-path">
                    <SettingCopy
                      title="Executable"
                      description={selectedProvider.id === "codex"
                        ? "Found automatically. A file you choose is version-checked before it is saved."
                        : undefined}
                      notice={binaryAction.notice}
                    />
                    <span className="provider-settings-binary-control">
                      <input
                        className="setting-input"
                        aria-label={`${selectedProvider.label} executable path`}
                        value={binaryValue}
                        placeholder={`No working ${selectedProvider.label} executable detected`}
                        readOnly
                        title={binaryValue || undefined}
                      />
                      {selectedProvider.id === "codex" && (
                        <span className="provider-settings-binary-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            aria-disabled={disabled || undefined}
                            onClick={() => { if (!disabled) onChooseCodexBinary(); }}
                          >
                            <FolderOpen size={14} aria-hidden="true" />
                            Browse
                          </button>
                          {settings.codexBinaryPath && (
                            <button
                              type="button"
                              className="secondary-button"
                              aria-disabled={disabled || binaryAction.busy || undefined}
                              onClick={() => {
                                if (disabled || binaryAction.busy) return;
                                void binaryAction.run(() => onUpdate({ codexBinaryPath: "" }));
                              }}
                            >
                              Use automatic
                            </button>
                          )}
                        </span>
                      )}
                    </span>
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

                  {LifecycleIntegritySettings && (
                    <LifecycleIntegritySettings
                      surface="provider-capability"
                      provider={selectedProvider}
                    />
                  )}

                  <p className="provider-settings-privacy-note">
                    Sign-in stays in the provider&apos;s own flow. Inertia stores no provider passwords or tokens.
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
                    <p className="provider-settings-empty">
                      No models reported yet. Refresh or connect this provider to load them.
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="provider-settings-empty">
              No providers detected. Refresh to check again.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
