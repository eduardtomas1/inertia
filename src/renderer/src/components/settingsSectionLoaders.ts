import { createSurfaceLoader } from "../utils/surfaceLoader";

export const loadConnectionsAndDevicesSettings = createSurfaceLoader(
  async () => ({
    default: (await import("./ConnectionsAndDevicesSettings"))
      .ConnectionsAndDevicesSettings,
  }),
);
export const loadModelBackendsSettings = createSurfaceLoader(async () => ({
  default: (await import("./ModelBackendsSettings")).ModelBackendsSettings,
}));
export const loadDiscordSettings = createSurfaceLoader(async () => ({
  default: (await import("./DiscordSettings")).DiscordSettings,
}));
export const loadCanaryRollbackSetting = createSurfaceLoader(
  () => import("./CanaryRollbackSetting"),
);
export const loadLifecycleIntegritySettings = createSurfaceLoader(async () => ({
  default: (await import("./LifecycleIntegritySettings"))
    .LifecycleIntegritySettings,
}));

export function prefetchSettingsSection(section: string): void {
  if (section === "providers" || section === "archive") {
    void loadLifecycleIntegritySettings();
  }
  if (section === "backends") {
    void loadModelBackendsSettings();
  } else if (section === "connections") {
    void loadConnectionsAndDevicesSettings();
  } else if (section === "discord") {
    void loadDiscordSettings();
  }
}
