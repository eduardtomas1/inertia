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
