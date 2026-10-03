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
