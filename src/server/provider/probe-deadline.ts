const NORMAL_VERSION_PROBE_MS = 500;
export const MAX_PROBE_DEADLINE_MS = 30_000;

export function slowMachineProbeDeadline(
  baseMs: number,
  versionProbeMs: number | undefined,
): number {
  const slowness = Math.max(1, (versionProbeMs ?? 0) / NORMAL_VERSION_PROBE_MS);
  return Math.min(Math.max(baseMs, MAX_PROBE_DEADLINE_MS), Math.round(baseMs * slowness));
}
