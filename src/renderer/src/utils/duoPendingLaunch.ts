export const MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY =
  "inertia:multi-spawn:pending-launch:v1";

export function writePendingMultiSpawnLaunchId(
  storage: Pick<Storage, "setItem">,
  launchId: string,
): boolean {
  try {
    storage.setItem(MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY, launchId);
    return true;
  } catch {
    return false;
  }
}

export function readPendingMultiSpawnLaunchId(
  storage: Pick<Storage, "getItem">,
): string | null {
  try {
    const launchId = storage.getItem(MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY);
    return launchId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(launchId)
      ? launchId
      : null;
  } catch {
    return null;
  }
}

export function clearPendingMultiSpawnLaunchId(
  storage: Pick<Storage, "removeItem">,
): boolean {
  try {
    storage.removeItem(MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
