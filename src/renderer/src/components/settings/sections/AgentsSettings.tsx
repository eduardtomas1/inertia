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
  | "onDeleteBackendProfile"
> {
  backendProfiles: ModelBackendProfileView[];
  initialProfileId?: string;
}

export function AgentsSettings({
  backendProfiles,
  initialProfileId,
  onLoadBackendProfile,
  onCreateBackendProfile,
  onUpdateBackendProfile,
  onSetBackendCredential,
  onClearBackendCredential,
  onProbeBackendProfile,
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
          initialProfileId={initialProfileId}
          disabled={providers.disabled}
          onLoadDetail={onLoadBackendProfile}
          onCreate={onCreateBackendProfile}
          onUpdate={onUpdateBackendProfile}
          onSetCredential={onSetBackendCredential}
          onClearCredential={onClearBackendCredential}
          onProbe={onProbeBackendProfile}
          onDelete={onDeleteBackendProfile}
        />
      ) : <SettingsSectionFallback />}
    </>
  );
}
