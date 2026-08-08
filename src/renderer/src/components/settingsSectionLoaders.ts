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

export function prefetchSettingsSection(section: string): void {
  if (section === "backends") {
    void loadModelBackendsSettings();
  } else if (section === "connections") {
    void loadConnectionsAndDevicesSettings();
  }
}
