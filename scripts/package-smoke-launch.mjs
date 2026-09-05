const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SUPERVISOR_ONLY_ENVIRONMENT_NAMES = [
  "INERTIA_PACKAGE_SMOKE_LAUNCH_MODE",
  "INERTIA_PACKAGE_SMOKE_PROCESS_GROUP_FILE",
  "INERTIA_PACKAGE_SMOKE_PROCESS_GROUP_TOKEN",
  "INERTIA_PACKAGE_SMOKE_SUPERVISOR_ROOT",
];

export function packagedAppUsesDetachedProcessGroup(platform) {
  return platform !== "win32";
}

export function isPackageSmokeOwnerToken(value) {
  return typeof value === "string" && OWNER_TOKEN_PATTERN.test(value);
}

export function packageSmokeChildEnvironment(environment) {
  const childEnvironment = { ...environment };
  for (const name of SUPERVISOR_ONLY_ENVIRONMENT_NAMES) delete childEnvironment[name];
  return childEnvironment;
}

export function resolvePackageSmokeLaunchMode(options) {
  const { configuredMode, extractAndRun, packageKind } = options;
  if (packageKind === "linux-appimage") {
    if ((configuredMode === undefined || configuredMode === "direct-app") && extractAndRun === undefined) {
      return "direct-app";
    }
    if (configuredMode === "handoff-wrapper" && extractAndRun === "1") {
      return configuredMode;
    }
    if (configuredMode === "retained-wrapper" && extractAndRun === "1") {
      return configuredMode;
    }
    throw new Error("The AppImage launcher mode does not match its exact runtime entry path.");
  }
  if (
    (configuredMode !== undefined && configuredMode !== "direct-app")
    || extractAndRun !== undefined
  ) {
    throw new Error("Non-AppImage package smoke cannot use an AppImage launcher contract.");
  }
  return "direct-app";
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
  const wrapper = options.launchMode === "handoff-wrapper"
    || options.launchMode === "retained-wrapper";
  const ownedProcessGroupId = options.ownedProcessGroupId === undefined
    ? options.launcherPid
    : options.ownedProcessGroupId;
  if (
    (wrapper ? mainPid === options.launcherPid : mainPid !== options.launcherPid)
    || !Number.isSafeInteger(generation)
    || generation < 1
    || typeof websocketUrl !== "string"
    || !websocketUrl.startsWith("ws://127.0.0.1:")
    || !options.processExists(mainPid)
    || !options.processExists(runtimePid)
    || (options.launchMode === "retained-wrapper" && !options.processExists(options.launcherPid))
    || (ownedProcessGroupId !== null && (
      options.processGroupId(mainPid) !== ownedProcessGroupId
      || options.processGroupId(runtimePid) !== ownedProcessGroupId
    ))
  ) return null;
  return { ...owned, generation, websocketUrl };
}

export async function waitForPackageSmokeReadiness(options) {
  const readiness = options.waitForReadiness();
  const handoff = options.launchMode === "handoff-wrapper";
  const retainedWrapper = options.launchMode === "retained-wrapper";
  let launcherTimer;
  const boundedLauncherExit = handoff
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
    if (!handoff || exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `The packaged ${retainedWrapper ? "retained wrapper" : handoff ? "launcher" : "app"} exited before reporting readiness (${exit.code ?? exit.signal ?? "unknown"}).`,
      );
    }
    return exit;
  });
  try {
    if (handoff) {
      const [value] = await Promise.all([readiness, launcherExit]);
      return value;
    }
    return await Promise.race([readiness, launcherExit]);
  } finally {
    if (launcherTimer !== undefined) clearTimeout(launcherTimer);
  }
}

export async function waitForPackageSmokeExit(options) {
  if (options.launchMode === "handoff-wrapper") return await options.mainExit;
  if (options.launchMode === "direct-app") {
    const directExit = await options.launcherExit;
    if (directExit.error) throw directExit.error;
    if (directExit.code !== 0 || directExit.signal !== null) {
      throw new Error(`The packaged app exited with ${directExit.code ?? directExit.signal ?? "unknown"}.`);
    }
    return directExit;
  }
  const wrapperExit = await options.launcherExit;
  if (wrapperExit.error) throw wrapperExit.error;
  if (wrapperExit.code !== 0 || wrapperExit.signal !== null) {
    throw new Error(
      `The retained AppImage wrapper exited with ${wrapperExit.code ?? wrapperExit.signal ?? "unknown"}.`,
    );
  }
  if (wrapperExit.endedAt < options.beforeQuitTimestampMs) {
    throw new Error("The retained AppImage wrapper exited before packaged shutdown began.");
  }
  if (options.mainProcessExists()) {
    throw new Error("The retained AppImage wrapper stopped supervising before the packaged app exited.");
  }
  const mainExit = await options.mainExit;
  return {
    ...mainExit,
    endedAt: Math.max(mainExit.endedAt, wrapperExit.endedAt),
  };
}

export function packageSmokeProcessesExited(options) {
  return !options.processExists(options.mainPid)
    && !options.processExists(options.runtimePid)
    && (
      options.ownedProcessGroupId === null
      || !options.processGroupExists(options.ownedProcessGroupId ?? options.launcherPid)
    );
}
