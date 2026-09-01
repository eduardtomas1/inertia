import type { ChildProcess } from "node:child_process";
import type { DarwinProcessIdentity } from "./runtime-owned-process-darwin.js";
import { sameProcess } from "./runtime-owned-process-journal.js";

export interface DarwinGuardianStopClaim {
  released: boolean;
  stopRequested: boolean;
  readonly settleStopRequest: () => void;
  admissionSucceeded: boolean;
  admission: Promise<boolean> | null;
  darwinIdentity?: DarwinProcessIdentity;
  darwinStopSignalSent?: boolean;
  darwinStopBarrier?: Promise<boolean>;
}

type KillableChild = Pick<ChildProcess, "pid" | "kill">;

const DARWIN_STOP_IDENTITY_ATTEMPTS = 2;

export function matchesExactDarwinGuardianIdentity<TRegistry>(
  registry: TRegistry,
  isRegistryActive: (registry: TRegistry) => boolean,
  readIdentity: (pid: number) => DarwinProcessIdentity | null,
  expected: DarwinProcessIdentity,
  pid: number,
): boolean {
  for (let attempt = 0; attempt < DARWIN_STOP_IDENTITY_ATTEMPTS; attempt += 1) {
    if (!isRegistryActive(registry)) return false;
    try {
      const current = readIdentity(pid);
      return current !== null && sameProcess(expected, current);
    } catch {
      // A loaded host can time out one bounded helper invocation. Retry only
      // unreadable results; a readable absence or mismatch fails immediately.
      if (attempt + 1 === DARWIN_STOP_IDENTITY_ATTEMPTS) return false;
    }
  }
  return false;
}

/**
 * Reuses one admission/stop barrier per guardian, preventing duplicate exact
 * identity checks or termination signals while admission is still in flight.
 */
export function requestExactDarwinGuardianStop<TRegistry>(
  registry: TRegistry,
  isRegistryActive: (registry: TRegistry) => boolean,
  readIdentity: (pid: number) => DarwinProcessIdentity | null,
  claim: DarwinGuardianStopClaim,
  child: KillableChild,
): Promise<boolean> {
  if (claim.darwinStopBarrier) return claim.darwinStopBarrier;
  claim.stopRequested = true;
  claim.settleStopRequest();
  const admission = claim.admission;
  const barrier = (async (): Promise<boolean> => {
    const admitted = admission ? await admission : claim.admissionSucceeded;
    if (!admitted || !isRegistryActive(registry)) {
      return false;
    }
    if (claim.released || claim.darwinStopSignalSent) return true;
    return signalExactDarwinGuardianStop(
      registry, isRegistryActive, readIdentity, claim, child,
    );
  })();
  claim.darwinStopBarrier = barrier;
  return barrier;
}

/**
 * Rejects an already-reused guardian PID immediately before the signal. A
 * transient helper failure receives one bounded retry, while any readable
 * mismatch fails closed without signalling the numeric PID.
 */
export function signalExactDarwinGuardianStop<TRegistry>(
  registry: TRegistry,
  isRegistryActive: (registry: TRegistry) => boolean,
  readIdentity: (pid: number) => DarwinProcessIdentity | null,
  claim: DarwinGuardianStopClaim,
  child: KillableChild,
): boolean {
  if (claim.released || claim.darwinStopSignalSent) return true;
  const expected = claim.darwinIdentity;
  const pid = child.pid ?? 0;
  if (!expected || pid <= 1) return false;
  if (
    !matchesExactDarwinGuardianIdentity(
      registry,
      isRegistryActive,
      readIdentity,
      expected,
      pid,
    )
    || !isRegistryActive(registry)
  ) return false;
  try {
    claim.darwinStopSignalSent = child.kill("SIGTERM");
    return claim.darwinStopSignalSent;
  } catch {
    return false;
  }
}

export function signalExactDarwinGuardianAuthorization<TRegistry>(
  registry: TRegistry,
  isRegistryActive: (registry: TRegistry) => boolean,
  readIdentity: (pid: number) => DarwinProcessIdentity | null,
  expected: DarwinProcessIdentity,
  signal: (pid: number, signal: NodeJS.Signals) => boolean,
): boolean {
  if (
    !matchesExactDarwinGuardianIdentity(
      registry,
      isRegistryActive,
      readIdentity,
      expected,
      expected.pid,
    )
    || !isRegistryActive(registry)
  ) return false;
  try { return signal(expected.pid, "SIGUSR1"); } catch { return false; }
}

export function hardStopUnclaimedDarwinGuardian<TRegistry>(
  registry: TRegistry,
  isRegistryActive: (registry: TRegistry) => boolean,
  readIdentity: (pid: number) => DarwinProcessIdentity | null,
  expectedIdentity: DarwinProcessIdentity | null,
  child: KillableChild,
): void {
  const pid = child.pid;
  if (!pid || !expectedIdentity || !isRegistryActive(registry)) return;
  if (!matchesExactDarwinGuardianIdentity(
    registry,
    isRegistryActive,
    readIdentity,
    expectedIdentity,
    pid,
  ) || !isRegistryActive(registry)) return;
  try { child.kill("SIGKILL"); } catch { /* The exact guardian may be gone. */ }
}
