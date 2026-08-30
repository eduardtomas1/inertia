const DEFAULT_RUNTIME_SHUTDOWN_DEADLINE_MS = 2_500;

// ConPTY can consume the complete 3-second terminal proof window while its
// public exit event drains. Preserve the existing 2.5-second outer allowance
// for the ordered artifact, client, server, and SQLite cleanup that follows.
const WINDOWS_RUNTIME_SHUTDOWN_DEADLINE_MS = 5_500;

// A close can race the macOS guardian's 5.5-second bounded asynchronous
// admission. Once admitted, the native two-freeze/TERM/KILL/drain proof owns a
// further 5-second bounded terminal budget. Keep another 2.25 seconds for
// the strictly ordered artifact, client, server, and store phases that cannot
// begin until owned-resource cleanup is proved.
const DARWIN_RUNTIME_SHUTDOWN_DEADLINE_MS = 12_750;
const RUNTIME_SUPERVISOR_SHUTDOWN_GRACE_HEADROOM_MS = 500;
export const RUNTIME_SUPERVISOR_FORCE_KILL_WAIT_MS = 1_000;

export function runtimeShutdownDeadlineMs(
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform === "darwin") return DARWIN_RUNTIME_SHUTDOWN_DEADLINE_MS;
  if (platform === "win32") return WINDOWS_RUNTIME_SHUTDOWN_DEADLINE_MS;
  return DEFAULT_RUNTIME_SHUTDOWN_DEADLINE_MS;
}

export function runtimeSupervisorShutdownEnvelopeMs(
  platform: NodeJS.Platform = process.platform,
): number {
  return runtimeSupervisorShutdownGraceMs(platform)
    + RUNTIME_SUPERVISOR_FORCE_KILL_WAIT_MS * 2;
}

export function runtimeSupervisorShutdownGraceMs(
  platform: NodeJS.Platform = process.platform,
): number {
  return runtimeShutdownDeadlineMs(platform)
    + RUNTIME_SUPERVISOR_SHUTDOWN_GRACE_HEADROOM_MS;
}
