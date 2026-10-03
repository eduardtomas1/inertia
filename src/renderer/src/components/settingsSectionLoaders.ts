import { createSurfaceLoader } from "../utils/surfaceLoader";

export const loadAttachmentStorageSettings = createSurfaceLoader(async () => ({
  default: (await import("./AttachmentStorageSettings")).AttachmentStorageSettings,
}));

export const loadCanaryRollbackSetting = createSurfaceLoader(
  () => import("./CanaryRollbackSetting"),
);

export const loadLifecycleIntegritySettings = createSurfaceLoader(async () => ({
  default: (await import("./LifecycleIntegritySettings"))
    .LifecycleIntegritySettings,
}));

export const loadMascotSettings = createSurfaceLoader(async () => ({
  default: (await import("./MascotSettings")).MascotSettings,
}));

export const loadIssueReportSettings = createSurfaceLoader(async () => ({
  default: (await import("./IssueReportSettings")).IssueReportSettings,
}));

export const loadModelBackendsSettings = createSurfaceLoader(async () => ({
  default: (await import("./ModelBackendsSettings")).ModelBackendsSettings,
}));

export const loadConnectionsAndDevicesSettings = createSurfaceLoader(async () => ({
  default: (await import("./ConnectionsAndDevicesSettings")).ConnectionsAndDevicesSettings,
}));

export const loadSnapshotSettings = createSurfaceLoader(async () => ({
  default: (await import("./SnapshotSettings")).SnapshotSettings,
}));

export const loadDiscordSettings = createSurfaceLoader(async () => ({
  default: (await import("./DiscordSettings")).DiscordSettings,
}));

export const loadDiagnosticsSettings = createSurfaceLoader(async () => ({
  default: (await import("./DiagnosticsSettings")).DiagnosticsSettings,
}));
