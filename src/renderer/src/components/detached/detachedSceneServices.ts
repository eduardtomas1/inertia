import type { useAppUpdate } from "../../app-update";
import type { useProviderMaintenance } from "../../hooks/useProviderMaintenance";
import type { WorkspacePanelTab } from "../workspacePanelTypes";

type ProviderMaintenance = ReturnType<typeof useProviderMaintenance>;
type AppUpdate = ReturnType<typeof useAppUpdate>;

const resolved = (): Promise<void> => Promise.resolve();

export const DETACHED_HIDDEN_SURFACES: readonly WorkspacePanelTab[] = ["preview"];

export const DETACHED_PROVIDER_MAINTENANCE: ProviderMaintenance = {
  statuses: new Map(),
  operations: new Map(),
  refresh: resolved,
  update: resolved,
  cancel: resolved,
};

export const DETACHED_APP_UPDATE: AppUpdate = {
  status: null,
  checking: false,
  error: null,
  check: resolved,
  download: resolved,
  cancelDownload: resolved,
  install: resolved,
  dismissError: () => undefined,
  openRelease: resolved,
  openReleases: resolved,
};
