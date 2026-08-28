import { app } from "electron";
import { resolveRequiredRuntimeProcessGuardianPath } from "./runtime-bootstrap-recovery.js";
import {
  resolveRequiredWindowsRuntimeJobAssembly,
  type WindowsRuntimeJobAssembly,
} from "./windows-runtime-job.js";

export function resolveDesktopRuntimeProcessSafetyAssets(): {
  runtimeProcessGuardianPath: string | null;
  windowsRuntimeJobAssembly: WindowsRuntimeJobAssembly | null;
} {
  const locations = {
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
  return {
    runtimeProcessGuardianPath: resolveRequiredRuntimeProcessGuardianPath(locations),
    windowsRuntimeJobAssembly: resolveRequiredWindowsRuntimeJobAssembly({
      platform: locations.platform,
      locations,
    }),
  };
}
