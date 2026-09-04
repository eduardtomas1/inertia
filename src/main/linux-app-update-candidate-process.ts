import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import { readLinuxProcessIdentity, sameProcess } from
  "../node/runtime-owned-process-journal.js";
import {
  linuxGuardianTerminalAuthority,
  monitorLinuxGuardianTerminal,
  readLinuxGuardianClaimedAsync,
  readLinuxGuardianOwnedAsync,
  readLinuxGuardianReadyWithRetriesAsync,
  recoverLinuxGuardianTerminalExact,
  signalLinuxGuardianExactAsync,
  stopPendingLinuxGuardianAsync,
  verifyLinuxRuntimeOwnedGuardianSandbox,
  type LinuxGuardianExecutableIdentity,
} from "../node/runtime-owned-process-linux.js";
import { exactProcessGroupTerminal } from
  "../node/runtime-owned-process-posix.js";
import {
  holdAppImageCandidate,
  type HeldAppImageIdentity,
} from "./appimage-executing-identity.js";
import type { AppUpdateHandoffSnapshot } from "./app-update-handoff.js";
import {
  LinuxAppUpdateCandidateClaimJournal,
  type LinuxAppUpdateCandidateInstanceClaim,
} from "./linux-app-update-candidate-claim.js";

const GUARDIAN_EXIT_TIMEOUT_MS = 5_000;
const RECOVERY_POLL_MS = 20;
const RECOVERY_TIMEOUT_MS = 5_000;

interface GuardianExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | null;
}

export interface LinuxAppUpdateCandidateProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly input: NonNullable<ChildProcess["stdin"]>;
  readonly output: NonNullable<ChildProcess["stdout"]>;
  readonly lifetime: NonNullable<ChildProcess["stdio"][number]>;
  readonly claim: LinuxAppUpdateCandidateInstanceClaim;
  alive(): boolean;
  abort(): Promise<void>;
  transferContainment(): Promise<void>;
}

export class LinuxAppUpdateCandidateClaimConflictError extends Error {
  constructor() {
    super("Another exact app update candidate owns bootstrap admission.");
    this.name = "LinuxAppUpdateCandidateClaimConflictError";
  }
}

export function linuxAppUpdateCandidateClaimOwnerIsLive(options: {
  readonly handoffDirectory: string;
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly dependencies?: {
    readonly readIdentity?: typeof readLinuxProcessIdentity;
    readonly readGuardianExecutableIdentity?: (pid: number) => {
      readonly device: string;
      readonly inode: string;
    } | null;
  };
}): boolean {
  try {
    const claim = new LinuxAppUpdateCandidateClaimJournal(
      options.handoffDirectory,
    ).current(options.snapshot);
    if (!claim) return false;
    const readIdentity = options.dependencies?.readIdentity
      ?? readLinuxProcessIdentity;
    const readGuardianExecutableIdentity =
      options.dependencies?.readGuardianExecutableIdentity
      ?? ((pid: number) => {
        const metadata = statSync(`/proc/${pid}/exe`, { bigint: true });
        return {
          device: String(metadata.dev),
          inode: String(metadata.ino),
        };
      });
    const guardian = readIdentity(claim.guardian.pid);
    const payload = readIdentity(claim.payload.pid);
    const executable = readGuardianExecutableIdentity(claim.guardian.pid);
    const confirmedGuardian = readIdentity(claim.guardian.pid);
    const confirmedPayload = readIdentity(claim.payload.pid);
    return !!guardian
      && !!payload
      && !!confirmedGuardian
      && !!confirmedPayload
      && !!executable
      && payload.parentPid === guardian.pid
      && confirmedGuardian.parentPid === guardian.parentPid
      && confirmedPayload.parentPid === payload.parentPid
      && sameProcess(claim.guardian, guardian)
      && sameProcess(claim.guardian, confirmedGuardian)
      && sameProcess(claim.payload, payload)
      && sameProcess(claim.payload, confirmedPayload)
      && executable.device === claim.guardian.guardianExecutableDevice
      && executable.inode === claim.guardian.guardianExecutableInode;
  } catch {
    return false;
  }
}

function guardianExit(child: ChildProcess): Promise<GuardianExit> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exit: GuardianExit): void => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    // A successfully detached payload intentionally retains inherited pipes,
    // so ChildProcess "close" is not a guardian-exit event. Exact descendant
    // checks below provide the separate stream/group terminal proof on abort.
    child.once("exit", (code, signal) => finish({ code, signal, error: null }));
  });
}

async function boundedExit(
  exit: Promise<GuardianExit>,
  timeoutMs = GUARDIAN_EXIT_TIMEOUT_MS,
): Promise<GuardianExit | null> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: GuardianExit | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    void exit.then(finish, () => finish(null));
  });
}

async function boundedBoolean(
  value: Promise<boolean>,
  timeoutMs = GUARDIAN_EXIT_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    void value.then(finish, () => finish(false));
  });
}

function waitForGuardianReady(
  stream: NodeJS.ReadableStream,
  deadlineAt: string,
  now: () => number = Date.now,
): Promise<void> {
  const remaining = Date.parse(deadlineAt) - now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return Promise.reject(new Error(
      "The app update candidate readiness deadline expired.",
    ));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = Buffer.alloc(0);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer | string): void => {
      bytes = Buffer.concat([
        bytes,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      if (bytes.byteLength > 1 || bytes[0] !== 0x52) {
        finish(new Error("The app update candidate readiness signal is invalid."));
      }
    };
    const onEnd = (): void => {
      finish(bytes.byteLength === 1 && bytes[0] === 0x52
        ? undefined
        : new Error("The app update candidate readiness signal is incomplete."));
    };
    const onError = (): void => finish(
      new Error("The app update candidate readiness channel failed."),
    );
    const timeout = setTimeout(() => finish(
      new Error("The app update candidate readiness deadline expired."),
    ), remaining);
    timeout.unref();
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function soleGuardianPayload(pid: number) {
  const children = readFileSync(
    `/proc/${pid}/task/${pid}/children`,
    "utf8",
  ).trim().split(/\s+/u).filter(Boolean);
  if (children.length !== 1 || !/^[1-9][0-9]*$/u.test(children[0]!)) {
    return null;
  }
  const identity = readLinuxProcessIdentity(Number(children[0]));
  return identity?.parentPid === pid && identity.processGroupId === pid
    ? identity
    : null;
}

function exactPayloadAlive(
  expected: LinuxAppUpdateCandidateInstanceClaim["payload"],
  requireGuardianParent: boolean,
): boolean {
  try {
    const current = readLinuxProcessIdentity(expected.pid);
    return !!current
      && (!requireGuardianParent || current.parentPid === expected.parentPid)
      && sameProcess(expected, current);
  } catch {
    return false;
  }
}

/**
 * AppImage extract-and-run deliberately retains an outer runtime wrapper, so
 * Electron can be a bounded descendant rather than the guardian's direct
 * child. Re-read the complete same-group chain to make ancestry a stable
 * identity proof rather than a one-shot numeric PPID observation.
 */
export function linuxAppUpdateCandidateProcessBelongsToClaim(
  claim: LinuxAppUpdateCandidateInstanceClaim,
  currentPid = process.pid,
  readIdentity: typeof readLinuxProcessIdentity = readLinuxProcessIdentity,
): boolean {
  const chain: NonNullable<ReturnType<typeof readLinuxProcessIdentity>>[] = [];
  let current = readIdentity(currentPid);
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (current.processGroupId !== claim.payload.processGroupId) return false;
    chain.push(current);
    if (current.pid === claim.payload.pid) {
      if (!sameProcess(claim.payload, current)) return false;
      return chain.every((observed) => {
        const confirmed = readIdentity(observed.pid);
        return !!confirmed
          && confirmed.parentPid === observed.parentPid
          && sameProcess(observed, confirmed);
      });
    }
    if (current.parentPid <= 1 || current.parentPid === current.pid) return false;
    current = readIdentity(current.parentPid);
  }
  return false;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref();
  });
}

/**
 * Reconciles a candidate guardian left by an old-app crash. A vanished PID is
 * insufficient: either the live exact guardian must expose its hardened,
 * child-free terminal state or a durable proof of that state must already
 * exist. PID reuse and any remaining process group stay quarantined.
 */
export async function recoverLinuxAppUpdateCandidateClaim(options: {
  readonly handoffDirectory: string;
  readonly guardianPath: string;
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly deadlineAt?: number;
  readonly dependencies?: {
    readonly readIdentity?: typeof readLinuxProcessIdentity;
    readonly terminalAuthority?: typeof linuxGuardianTerminalAuthority;
    readonly recoverGuardian?: typeof recoverLinuxGuardianTerminalExact;
    readonly processGroupTerminal?: typeof exactProcessGroupTerminal;
    readonly wait?: (durationMs: number) => Promise<void>;
  };
}): Promise<boolean> {
  if (options.snapshot.platform !== "linux") return false;
  const claimJournal = new LinuxAppUpdateCandidateClaimJournal(
    options.handoffDirectory,
  );
  const recovery = claimJournal.recovery(options.snapshot);
  if (!recovery) return true;
  const deadlineAt = options.deadlineAt ?? Date.now() + RECOVERY_TIMEOUT_MS;
  const readIdentity = options.dependencies?.readIdentity
    ?? readLinuxProcessIdentity;
  const terminalAuthority = options.dependencies?.terminalAuthority
    ?? linuxGuardianTerminalAuthority;
  const recoverGuardian = options.dependencies?.recoverGuardian
    ?? recoverLinuxGuardianTerminalExact;
  const processGroupTerminal = options.dependencies?.processGroupTerminal
    ?? exactProcessGroupTerminal;
  const waitForPoll = options.dependencies?.wait ?? wait;
  const { claim } = recovery;
  const durableAdmission = options.snapshot.phase === "candidate-admitted"
    || options.snapshot.phase === "completed";
  let guardian = readIdentity(claim.guardian.pid);
  if (guardian && !sameProcess(claim.guardian, guardian)) return false;
  if (!guardian && !recovery.terminalProved && !durableAdmission) return false;
  if (guardian) {
    while (
      !terminalAuthority(
        claim.guardian,
        options.guardianPath,
        "/proc",
        "inertia-done",
      )
      && !terminalAuthority(
        claim.guardian,
        options.guardianPath,
        "/proc",
        "inertia-exdone",
      )
    ) {
      if (Date.now() + RECOVERY_POLL_MS >= deadlineAt) return false;
      await waitForPoll(RECOVERY_POLL_MS);
      guardian = readIdentity(claim.guardian.pid);
      if (!guardian || !sameProcess(claim.guardian, guardian)) return false;
    }
    if (!claimJournal.publishTerminalProof(claim)) return false;
    if (!recoverGuardian(claim.guardian, options.guardianPath)) return false;
    while (Date.now() + RECOVERY_POLL_MS < deadlineAt) {
      await waitForPoll(RECOVERY_POLL_MS);
      guardian = readIdentity(claim.guardian.pid);
      if (!guardian) break;
      if (!sameProcess(claim.guardian, guardian)) return false;
    }
  }
  // Any occupant at either claimed PID is reuse, not proof of absence.
  if (
    readIdentity(claim.guardian.pid)
    || readIdentity(claim.payload.pid)
    || processGroupTerminal(claim.guardian.processGroupId, "linux") !== true
  ) return false;
  return claimJournal.retire(claim);
}

/**
 * Transfers retirement authority to the admitted candidate itself. The
 * durable admission phase closes duplicate launch admission first; only the
 * exact payload that was held behind the guardian may then consume its claim.
 */
export function retireLinuxAppUpdateCandidateClaimAfterAdmission(options: {
  readonly handoffDirectory: string;
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly instanceChecksum: string;
  readonly currentPid?: number;
  readonly readIdentity?: typeof readLinuxProcessIdentity;
}): boolean {
  if (
    options.snapshot.platform !== "linux"
    || (
      options.snapshot.phase !== "candidate-admitted"
      && options.snapshot.phase !== "completed"
    )
  ) return false;
  const claimJournal = new LinuxAppUpdateCandidateClaimJournal(
    options.handoffDirectory,
  );
  const claim = claimJournal.current(options.snapshot);
  if (!claim || claim.checksum !== options.instanceChecksum) return false;
  const readIdentity = options.readIdentity ?? readLinuxProcessIdentity;
  const currentPid = options.currentPid ?? process.pid;
  // A still-present or reused guardian means containment transfer was not
  // conclusively completed. Extract-and-run may retain the claimed AppImage
  // wrapper above Electron, so prove a stable exact ancestry chain.
  return !readIdentity(claim.guardian.pid)
    && linuxAppUpdateCandidateProcessBelongsToClaim(
      claim,
      currentPid,
      readIdentity,
    )
    && claimJournal.retire(claim);
}

async function stopAdmittedGuardian(options: {
  readonly child: ChildProcess;
  readonly exit: Promise<GuardianExit>;
  readonly guardianPath: string;
  readonly guardian: LinuxAppUpdateCandidateInstanceClaim["guardian"];
  readonly claim: LinuxAppUpdateCandidateInstanceClaim;
  readonly claimJournal: LinuxAppUpdateCandidateClaimJournal;
}): Promise<boolean> {
  let terminalProved = false;
  let releaseDelivered = false;
  let monitorFailed = false;
  let finishRelease!: (released: boolean) => void;
  const releaseCompletion = new Promise<boolean>((resolve) => {
    finishRelease = resolve;
  });
  const stopMonitor = monitorLinuxGuardianTerminal(
    options.guardian,
    options.guardianPath,
    () => {
      terminalProved = options.claimJournal.publishTerminalProof(options.claim);
      return terminalProved;
    },
    () => {
      monitorFailed = true;
      finishRelease(false);
    },
    {
      release: async (signal) => {
        releaseDelivered = await signalLinuxGuardianExactAsync(
          options.guardian,
          options.guardianPath,
          "release",
          signal,
        );
        finishRelease(releaseDelivered);
        return releaseDelivered;
      },
      // A vanished guardian before its hardened terminal proof is not cleanup.
      missing: () => false,
    },
  );
  try {
    // The payload may exit between admission and an abort request. In that
    // case the guardian is already in its authenticated terminal state and a
    // stop signal is intentionally rejected. Keep waiting for the monitor's
    // child-free proof instead of turning that safe race into an unconfirmed
    // cleanup.
    await signalLinuxGuardianExactAsync(
      options.guardian,
      options.guardianPath,
      "stop",
    );
    const [exited, releaseConfirmed] = await Promise.all([
      boundedExit(options.exit),
      boundedBoolean(releaseCompletion),
    ]);
    return !monitorFailed
      && terminalProved
      && releaseDelivered
      && releaseConfirmed
      && !!exited
      && exited.error === null
      && exited.signal === null
      && exactProcessGroupTerminal(options.guardian.pid, "linux") === true;
  } finally {
    stopMonitor();
  }
}

async function stopPendingGuardian(options: {
  readonly child: ChildProcess;
  readonly exit: Promise<GuardianExit>;
  readonly guardianPath: string;
  readonly guardianExecutable: LinuxGuardianExecutableIdentity;
}): Promise<boolean> {
  const pid = options.child.pid;
  if (!pid || pid <= 1) return false;
  if (!await stopPendingLinuxGuardianAsync(
    pid,
    options.guardianPath,
    process.pid,
    undefined,
    options.guardianExecutable,
  )) return false;
  const exited = await boundedExit(options.exit);
  return !!exited
    && exited.error === null
    && exited.signal === null
    && exactProcessGroupTerminal(pid, "linux") === true;
}

/**
 * Starts the candidate behind the native Linux subreaper. The candidate is
 * executed through inherited fd 4, so replacing its pathname after validation
 * cannot choose another executable. Abort succeeds only after the exact
 * guardian proves a child-free terminal state and its whole group is inert.
 */
export async function startLinuxAppUpdateCandidate(options: {
  readonly executablePath: string;
  readonly guardianPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly handoffDirectory: string;
  readonly launchId: string;
  readonly testHooks?: {
    readonly afterCandidateHeld?: (
      identity: HeldAppImageIdentity,
    ) => void | Promise<void>;
    readonly afterGuardianSpawned?: (pid: number) => void | Promise<void>;
    /** Test-only clock seam for the readiness phase after the guardian exists. */
    readonly readinessNow?: () => number;
  };
}): Promise<LinuxAppUpdateCandidateProcess> {
  const guardianExecutable = verifyLinuxRuntimeOwnedGuardianSandbox(
    options.guardianPath,
  );
  if (!guardianExecutable) {
    throw new Error("The app update candidate guardian is unavailable.");
  }
  const held = await holdAppImageCandidate(options.executablePath, {
    artifactDigest: options.snapshot.candidateArtifactDigest,
    executableIdentityDigest:
      options.snapshot.candidateExecutableIdentityDigest,
  }, options.snapshot.deadlineAt);
  let child: ChildProcess | null = null;
  let exit: Promise<GuardianExit> | null = null;
  let guardian = null as LinuxAppUpdateCandidateInstanceClaim["guardian"] | null;
  let claim: LinuxAppUpdateCandidateInstanceClaim | null = null;
  let claimJournal: LinuxAppUpdateCandidateClaimJournal | null = null;
  let admitted = false;
  try {
    await options.testHooks?.afterCandidateHeld?.(held);
    child = spawn(options.guardianPath, [
      "handoff",
      String(process.pid),
      guardianExecutable.guardianExecutableDevice,
      guardianExecutable.guardianExecutableInode,
      held.device,
      held.inode,
      held.artifactDigest,
      "--",
      "/proc/self/fd/4",
    ], {
      detached: true,
      shell: false,
      env: options.environment,
      stdio: [
        "pipe",
        "pipe",
        "ignore",
        "pipe",
        held.fileDescriptor,
        "pipe",
      ],
    });
    exit = guardianExit(child);
    await held.close();
    const guardianPid = child.pid;
    if (!guardianPid || guardianPid <= 1) {
      throw new Error("The app update candidate guardian identity is unavailable.");
    }
    await options.testHooks?.afterGuardianSpawned?.(guardianPid);
    const readyChannel = (
      child.stdio as unknown as Array<NodeJS.ReadableStream | null>
    )[5];
    if (!readyChannel) {
      throw new Error("The app update candidate readiness channel is unavailable.");
    }
    await waitForGuardianReady(
      readyChannel,
      options.snapshot.deadlineAt,
      options.testHooks?.readinessNow,
    );
    (readyChannel as { destroy?: () => void }).destroy?.();
    const readyGuardian = await readLinuxGuardianReadyWithRetriesAsync(
      guardianPid,
      options.guardianPath,
      process.pid,
      undefined,
      guardianExecutable,
    );
    guardian = readyGuardian
      ? { ...readyGuardian, ...guardianExecutable }
      : null;
    const candidatePayload = guardian ? soleGuardianPayload(guardian.pid) : null;
    if (!guardian || !candidatePayload) {
      throw new Error("The app update candidate guardian was not admitted.");
    }
    claimJournal = new LinuxAppUpdateCandidateClaimJournal(
      options.handoffDirectory,
    );
    claim = claimJournal.claim(
      options.snapshot,
      options.launchId,
      guardian as Required<typeof guardian>,
      candidatePayload,
    );
    if (!claim) {
      if (linuxAppUpdateCandidateClaimOwnerIsLive({
        handoffDirectory: options.handoffDirectory,
        snapshot: options.snapshot,
      })) throw new LinuxAppUpdateCandidateClaimConflictError();
      throw new Error("Another app update candidate owns bootstrap admission.");
    }
    if (!await signalLinuxGuardianExactAsync(
      guardian,
      options.guardianPath,
      "claim",
    ) || !await readLinuxGuardianClaimedAsync(
      guardian.pid,
      options.guardianPath,
      process.pid,
      undefined,
      guardianExecutable,
    )) throw new Error("The app update candidate guardian claim failed.");
    if (!await signalLinuxGuardianExactAsync(
      guardian,
      options.guardianPath,
      "exec",
    ) || !await readLinuxGuardianOwnedAsync(
      guardian.pid,
      options.guardianPath,
      process.pid,
      undefined,
      guardianExecutable,
    )) throw new Error("The app update candidate guardian authorization failed.");
    admitted = true;
    const exactChild = child;
    const exactExit = exit;
    const exactGuardian = guardian;
    const exactClaim = claim;
    const exactClaimJournal = claimJournal;
    let state: "contained" | "aborted" | "transferred" =
      "contained";
    let cleanup: Promise<void> | null = null;
    const abort = (): Promise<void> => {
      cleanup ??= (async () => {
        if (state === "aborted") return;
        if (state !== "contained") {
          throw new Error(
            "The transferred app update candidate cannot be aborted exactly.",
          );
        }
        if (!await stopAdmittedGuardian({
          child: exactChild,
          exit: exactExit,
          guardianPath: options.guardianPath,
          guardian: exactGuardian,
          claim: exactClaim,
          claimJournal: exactClaimJournal,
        })) throw new Error(
          "The app update candidate guardian cleanup could not be confirmed.",
        );
        if (!exactClaimJournal.retire(exactClaim)) {
          throw new Error("The app update candidate claim could not be retired.");
        }
        state = "aborted";
      })();
      return cleanup;
    };
    return Object.freeze({
      child: exactChild,
      pid: exactClaim.payload.pid,
      input: exactChild.stdin!,
      output: exactChild.stdout!,
      lifetime: exactChild.stdio[3]!,
      claim: exactClaim,
      alive: () => state !== "aborted"
        && exactPayloadAlive(exactClaim.payload, state === "contained"),
      abort,
      transferContainment: async () => {
        if (state === "transferred") return;
        if (
          state !== "contained"
          || cleanup
          || !exactPayloadAlive(exactClaim.payload, true)
        ) {
          throw new Error("The app update candidate cannot receive containment.");
        }
        if (!await signalLinuxGuardianExactAsync(
          exactGuardian,
          options.guardianPath,
          "detach",
        )) throw new Error("The app update candidate containment transfer failed.");
        const exited = await boundedExit(exactExit);
        const currentGuardian = readLinuxProcessIdentity(exactGuardian.pid);
        if (
          !exited
          || exited.error
          || exited.signal !== null
          || exited.code !== 0
          || (currentGuardian && sameProcess(exactGuardian, currentGuardian))
          || !exactPayloadAlive(exactClaim.payload, false)
        ) throw new Error(
          "The app update candidate containment transfer is unconfirmed.",
        );
        state = "transferred";
      },
    });
  } catch (error) {
    let cleanupConfirmed = child === null;
    if (child && exit) {
      cleanupConfirmed = guardian && claim && claimJournal
        ? await stopAdmittedGuardian({
            child,
            exit,
            guardianPath: options.guardianPath,
            guardian,
            claim,
            claimJournal,
          })
        : await stopPendingGuardian({
            child,
            exit,
            guardianPath: options.guardianPath,
            guardianExecutable,
          });
    }
    if (cleanupConfirmed && claim && claimJournal) {
      cleanupConfirmed = claimJournal.retire(claim);
    }
    if (!cleanupConfirmed) {
      throw new AggregateError(
        [error],
        "The app update candidate guardian cleanup is unconfirmed.",
      );
    }
    throw error;
  } finally {
    if (!admitted) await held.close().catch(() => undefined);
  }
}
