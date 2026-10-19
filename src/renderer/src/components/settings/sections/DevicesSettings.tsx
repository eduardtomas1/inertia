import type { AppSettings, Project } from "@shared/contracts";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import {
  loadAppControlSettings,
  loadConnectionsAndDevicesSettings,
  loadDiscordSettings,
  loadSnapshotSettings,
} from "../../settingsSectionLoaders";
import { SettingsSectionFallback } from "../SettingsSectionFallback";

export const loadDevicesSections = (): Promise<unknown> => Promise.all([
  loadConnectionsAndDevicesSettings(),
  loadSnapshotSettings(),
  loadAppControlSettings(),
  loadDiscordSettings(),
]);

export function DevicesSettings({
  projects,
  disabled,
  repositoryUrl,
  onUpdate,
}: {
  projects: Project[];
  disabled: boolean;
  repositoryUrl: string;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  const PrivateConnect = useLoadedSurface(loadConnectionsAndDevicesSettings, true);
  const Snapshots = useLoadedSurface(loadSnapshotSettings, true);
  const AppControl = useLoadedSurface(loadAppControlSettings, true);
  const Discord = useLoadedSurface(loadDiscordSettings, true);
  if (!PrivateConnect || !Snapshots || !AppControl || !Discord) return <SettingsSectionFallback />;
  return (
    <>
      <PrivateConnect projects={projects} />
      <Snapshots />
      <AppControl />
      <Discord disabled={disabled} repositoryUrl={repositoryUrl} onUpdate={onUpdate} />
    </>
  );
}
