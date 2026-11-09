import { useCallback, useState } from "react";

import type { ModelBackendProfileView } from "@shared/contracts";
import type { ApiKeyBackendPresetId } from "@shared/backend-presets";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import { API_KEY_PRESET_FOR_PROVIDER } from "../../../utils/backendSettingsModel";
import { loadModelBackendsSettings } from "../../settingsSectionLoaders";
import { ProvidersSettings, type ProvidersSettingsProps } from "../ProvidersSettings";
import { SettingsSectionFallback } from "../SettingsSectionFallback";
import type { SettingsViewProps } from "../settingsTypes";

export interface AgentsSettingsProps extends Omit<ProvidersSettingsProps, "onAddApiKey">, Pick<
  SettingsViewProps,
  | "onLoadBackendProfile"
  | "onCreateBackendProfile"
  | "onUpdateBackendProfile"
  | "onSetBackendCredential"
  | "onClearBackendCredential"
  | "onProbeBackendProfile"
  | "onDiscoverBackendModels"
  | "onDeleteBackendProfile"
> {
  backendProfiles: ModelBackendProfileView[];
  initialProfileId?: string;
  initialProfilePanel?: "key" | "models";
}

export function AgentsSettings({
  backendProfiles,
  initialProfileId,
  initialProfilePanel,
  onLoadBackendProfile,
  onCreateBackendProfile,
  onUpdateBackendProfile,
  onSetBackendCredential,
  onClearBackendCredential,
  onProbeBackendProfile,
  onDiscoverBackendModels,
  onDeleteBackendProfile,
  ...providers
}: AgentsSettingsProps): React.JSX.Element {
  const Backends = useLoadedSurface(loadModelBackendsSettings, true);
  const [requestedKeyPreset, setRequestedKeyPreset] = useState<ApiKeyBackendPresetId | null>(null);
  const consumeKeyRequest = useCallback(() => setRequestedKeyPreset(null), []);
  return (
    <>
      <ProvidersSettings
        {...providers}
        onAddApiKey={(providerId) => {
          const preset = API_KEY_PRESET_FOR_PROVIDER[providerId];
          if (preset) setRequestedKeyPreset(preset);
        }}
      />
      {Backends ? (
        <Backends
          profiles={backendProfiles}
          requestedKeyPreset={requestedKeyPreset}
          onRequestedKeyPresetConsumed={consumeKeyRequest}
          providers={providers.providers}
          providerIdentityLabels={providers.settings.providerIdentityLabels}
          initialProfileId={initialProfileId}
          initialProfilePanel={initialProfilePanel}
          disabled={providers.disabled}
          onConnectProvider={providers.onConnectProvider}
          onRefreshProvider={providers.onRefreshProvider}
          onLoadDetail={onLoadBackendProfile}
          onCreate={onCreateBackendProfile}
          onUpdate={onUpdateBackendProfile}
          onSetCredential={onSetBackendCredential}
          onClearCredential={onClearBackendCredential}
          onProbe={onProbeBackendProfile}
          onDiscoverModels={onDiscoverBackendModels}
          onDelete={onDeleteBackendProfile}
        />
      ) : <SettingsSectionFallback />}
    </>
  );
}
