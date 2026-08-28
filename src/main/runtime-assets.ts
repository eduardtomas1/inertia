import { join, resolve } from "node:path";

export interface RuntimeAssetLocations {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

/**
 * Runtime assets live outside app.asar in production. Development resolves the
 * same generated mark from the checked-out source tree.
 */
export function resolveRuntimeIconPath(locations: RuntimeAssetLocations): string {
  return locations.isPackaged
    ? join(resolve(locations.resourcesPath), "icons", "inertia.png")
    : join(resolve(locations.appPath), "resources", "icons", "512x512.png");
}

export function resolveRuntimeProcessGuardianPath(
  locations: RuntimeAssetLocations,
): string {
  return locations.isPackaged
    ? join(resolve(locations.resourcesPath), "runtime", "runtime-process-guardian")
    : join(
        resolve(locations.appPath),
        "resources",
        "generated",
        "runtime-process-guardian",
        "runtime-process-guardian",
      );
}

export function resolveWindowsRuntimeJobAssemblyPath(
  locations: RuntimeAssetLocations,
): string {
  return locations.isPackaged
    ? join(resolve(locations.resourcesPath), "runtime", "windows-runtime-job.exe")
    : join(
        resolve(locations.appPath),
        "resources",
        "generated",
        "runtime-process-guardian",
        "windows-runtime-job.exe",
      );
}
