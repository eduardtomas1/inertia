import type { AppSettings, Project } from "@shared/contracts";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import {
  loadConnectionsAndDevicesSettings,
  loadDiscordSettings,
  loadSnapshotSettings,
} from "../../settingsSectionLoaders";
import { SettingsSectionFallback } from "../SettingsSectionFallback";

export const loadDevicesSections = (): Promise<unknown> => Promise.all([
  loadConnectionsAndDevicesSettings(),
  loadSnapshotSettings(),
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
  const Discord = useLoadedSurface(loadDiscordSettings, true);
  if (!PrivateConnect || !Snapshots || !Discord) return <SettingsSectionFallback />;
  return (
    <>
      <PrivateConnect projects={projects} />
      <Snapshots />
      <Discord disabled={disabled} repositoryUrl={repositoryUrl} onUpdate={onUpdate} />
    </>
  );
}
