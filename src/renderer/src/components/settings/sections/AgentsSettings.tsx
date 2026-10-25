import type { ModelBackendProfileView } from "@shared/contracts";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import { loadModelBackendsSettings } from "../../settingsSectionLoaders";
import { ProvidersSettings, type ProvidersSettingsProps } from "../ProvidersSettings";
import { SettingsSectionFallback } from "../SettingsSectionFallback";
import type { SettingsViewProps } from "../settingsTypes";

export interface AgentsSettingsProps extends ProvidersSettingsProps, Pick<
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
  return (
    <>
      <ProvidersSettings {...providers} />
      {Backends ? (
        <Backends
          profiles={backendProfiles}
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
