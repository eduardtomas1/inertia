const DEFAULT_RUNTIME_SHUTDOWN_DEADLINE_MS = 2_500;

// A close can race the macOS guardian's 5.5-second bounded asynchronous
// admission. Once admitted, the native two-freeze/TERM/KILL/drain proof owns a
// further 2.25-second bounded terminal budget. Keep another 2.25 seconds for
// the strictly ordered artifact, client, server, and store phases that cannot
// begin until owned-resource cleanup is proved.
const DARWIN_RUNTIME_SHUTDOWN_DEADLINE_MS = 10_000;
const RUNTIME_SUPERVISOR_SHUTDOWN_GRACE_HEADROOM_MS = 500;
export const RUNTIME_SUPERVISOR_FORCE_KILL_WAIT_MS = 1_000;

export function runtimeShutdownDeadlineMs(
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "darwin"
    ? DARWIN_RUNTIME_SHUTDOWN_DEADLINE_MS
    : DEFAULT_RUNTIME_SHUTDOWN_DEADLINE_MS;
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
