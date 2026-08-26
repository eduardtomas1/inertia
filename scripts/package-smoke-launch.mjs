const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function packagedAppUsesDetachedProcessGroup(platform, inheritSupervisedProcessGroup) {
  return platform !== "win32" && inheritSupervisedProcessGroup !== true;
}

export function isPackageSmokeOwnerToken(value) {
  return typeof value === "string" && OWNER_TOKEN_PATTERN.test(value);
}

export function parsePackageSmokeOwnedPids(value, options) {
  if (!value || typeof value !== "object") return null;
  const { mainPid, runtimePid, timestampMs, ownerToken } = value;
  if (
    ownerToken !== options.ownerToken
    || !isPackageSmokeOwnerToken(ownerToken)
    || !Number.isSafeInteger(mainPid)
    || mainPid <= 0
    || !Number.isSafeInteger(runtimePid)
    || runtimePid <= 0
    || runtimePid === mainPid
    || !Number.isSafeInteger(timestampMs)
    || timestampMs < options.launchedAt
  ) return null;
  return { mainPid, runtimePid, timestampMs, ownerToken };
}

export function parsePackageSmokeReadiness(value, options) {
  const owned = parsePackageSmokeOwnedPids(value, options);
  if (owned === null) return null;
  const { mainPid, runtimePid } = owned;
  const { generation, websocketUrl } = value;
  const handoff = options.allowLauncherHandoff === true;
  const ownedProcessGroupId = options.ownedProcessGroupId ?? options.launcherPid;
  if (
    (handoff ? mainPid === options.launcherPid : mainPid !== options.launcherPid)
    || !Number.isSafeInteger(generation)
    || generation < 1
    || typeof websocketUrl !== "string"
    || !websocketUrl.startsWith("ws://127.0.0.1:")
    || (handoff && (
      !options.processExists(mainPid)
      || !options.processExists(runtimePid)
      || options.processGroupId(mainPid) !== ownedProcessGroupId
      || options.processGroupId(runtimePid) !== ownedProcessGroupId
    ))
  ) return null;
  return { ...owned, generation, websocketUrl };
}

export async function waitForPackageSmokeReadiness(options) {
  const readiness = options.waitForReadiness();
  let launcherTimer;
  const boundedLauncherExit = options.allowLauncherHandoff
    ? Promise.race([
        options.launcherExit,
        new Promise((_, reject) => {
          launcherTimer = setTimeout(
            () => reject(new Error("The AppImage launcher did not complete handoff before the startup deadline.")),
            options.launcherTimeoutMs,
          );
        }),
      ])
    : options.launcherExit;
  const launcherExit = boundedLauncherExit.then((exit) => {
    if (exit.error) throw exit.error;
    if (!options.allowLauncherHandoff || exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `The packaged ${options.allowLauncherHandoff ? "launcher" : "app"} exited before reporting readiness (${exit.code ?? exit.signal ?? "unknown"}).`,
      );
    }
    return exit;
  });
  try {
    if (options.allowLauncherHandoff) {
      const [value] = await Promise.all([readiness, launcherExit]);
      return value;
    }
    return await Promise.race([readiness, launcherExit]);
  } finally {
    if (launcherTimer !== undefined) clearTimeout(launcherTimer);
  }
}

export function packageSmokeProcessesExited(options) {
  return !options.processExists(options.mainPid)
    && !options.processExists(options.runtimePid)
    && (
      options.ownedProcessGroupId === null
      || !options.processGroupExists(options.ownedProcessGroupId ?? options.launcherPid)
    );
}
