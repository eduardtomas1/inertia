import type { ElectronApplication } from "@playwright/test";
import type { ChildProcess } from "node:child_process";

type ProcessStage = "launcher-exit" | "launcher-close" | "main-window-page-closed" | "cleanup-prepared"
  | "quit-requested" | "quit-request-fulfilled" | "quit-request-rejected"
  | "graceful-exit" | "abnormal-exit" | "force-stop-started"
  | "force-stop-confirmed" | "force-stop-unconfirmed"
  | "transport-started" | "transport-settled" | "transport-timed-out"
  | "directory-remove-started" | "directory-remove-fulfilled"
  | "directory-remove-rejected" | "directory-remove-timed-out"
  | "window-destroy-entered" | "window-destroy-returned" | "process-exit-called"
  | "window-identity-unavailable" | "window-observer-unavailable"
  | "process-exit-observer-unavailable" | "debugger-disconnect-wait"
  | "main-pid-advisory-present" | "main-pid-advisory-absent" | "main-pid-advisory-unknown";

export interface ElectronProcessEvidenceSnapshot {
  readonly launcherPid: number | null;
  readonly mainPid: number | null;
  readonly mainIdentity: "pending" | "captured" | "unavailable" | "timed-out";
  readonly launcherExitObserved: boolean;
  readonly launcherCloseObserved: boolean;
  readonly launcherExitCode: number | null;
  readonly stages: readonly { stage: ProcessStage; elapsedMs: number }[];
}

export interface ElectronProcessEvidence {
  record: (stage: ProcessStage) => void;
  captureMainPid: (readPid: () => Promise<unknown>) => void;
  observeMainPresence: (probe?: (pid: number) => void) => void;
  snapshot: () => ElectronProcessEvidenceSnapshot;
  stop: () => void;
}

const records = new WeakMap<ChildProcess, ElectronProcessEvidence>();
const validPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;

export function electronProcessEvidence(child: ChildProcess): ElectronProcessEvidence {
  const existing = records.get(child);
  if (existing) return existing;
  const startedAt = Date.now();
  const launcherPid = validPid(child.pid) ? child.pid : null;
  let mainPid: number | null = null;
  let mainIdentity: ElectronProcessEvidenceSnapshot["mainIdentity"] = "unavailable";
  let identityTimer: ReturnType<typeof setTimeout> | undefined;
  let launcherExitObserved = child.exitCode !== null || child.signalCode !== null;
  let launcherCloseObserved = false;
  const stages: { stage: ProcessStage; elapsedMs: number }[] = [];
  let observingStderr = false;
  const record = (stage: ProcessStage): void => {
    if (stages.length < 24) stages.push({ stage, elapsedMs: Math.max(0, Date.now() - startedAt) });
    if (stage === "quit-requested" && !observingStderr) {
      observingStderr = true;
      child.stderr?.on("data", onStderr);
    }
  };
  const stderrStages = new Map<string, ProcessStage>([
    ["[Inertia test exit: window-destroy-entered]", "window-destroy-entered"],
    ["[Inertia test exit: window-destroy-returned]", "window-destroy-returned"],
    ["[Inertia test exit: process-exit-called]", "process-exit-called"],
    ["[Inertia test exit: window-identity-unavailable]", "window-identity-unavailable"],
    ["[Inertia test exit: window-observer-unavailable]", "window-observer-unavailable"],
    ["[Inertia test exit: process-exit-observer-unavailable]", "process-exit-observer-unavailable"],
    ["Waiting for the debugger to disconnect...", "debugger-disconnect-wait"],
  ]);
  const seenStderrStages = new Set<ProcessStage>();
  let stderrLine = "";
  let discardStderrLine = false;
  const onStderr = (chunk: Buffer): void => {
    for (const byte of chunk) {
      if (byte === 10) {
        const stage = discardStderrLine ? undefined : stderrStages.get(stderrLine.replace(/\r$/u, ""));
        if (stage && !seenStderrStages.has(stage)) { seenStderrStages.add(stage); record(stage); }
        stderrLine = ""; discardStderrLine = false;
      } else if (!discardStderrLine) {
        if (stderrLine.length < 128) stderrLine += String.fromCharCode(byte);
        else { stderrLine = ""; discardStderrLine = true; }
      }
    }
  };
  const onExit = (): void => { launcherExitObserved = true; record("launcher-exit"); };
  const onClose = (): void => { launcherCloseObserved = true; record("launcher-close"); };
  child.once("exit", onExit);
  child.once("close", onClose);
  const evidence: ElectronProcessEvidence = {
    record,
    observeMainPresence: (probe = (pid) => { process.kill(pid, 0); }) => {
      // The captured PID may have been reused. This is advisory presence only,
      // never process identity, exit confirmation, or permission to terminate.
      if (mainIdentity !== "captured" || mainPid === null) {
        record("main-pid-advisory-unknown"); return;
      }
      try { probe(mainPid); record("main-pid-advisory-present"); }
      catch (error) {
        record((error as NodeJS.ErrnoException)?.code === "ESRCH"
          ? "main-pid-advisory-absent" : "main-pid-advisory-unknown");
      }
    },
    captureMainPid: (readPid) => {
      if (mainIdentity !== "unavailable") return;
      mainIdentity = "pending";
      identityTimer = setTimeout(() => { mainIdentity = "timed-out"; }, 1_000);
      identityTimer.unref();
      // A late result cannot replace a timeout or a stopped fixture identity.
      void Promise.resolve().then(readPid).then((pid) => {
        if (mainIdentity !== "pending") return;
        mainPid = validPid(pid) ? pid : null;
        mainIdentity = mainPid === null ? "unavailable" : "captured";
        clearTimeout(identityTimer);
      }, () => {
        if (mainIdentity !== "pending") return;
        mainIdentity = "unavailable";
        clearTimeout(identityTimer);
      });
    },
    snapshot: () => ({ launcherPid, mainPid, mainIdentity, launcherExitObserved,
      launcherCloseObserved,
      launcherExitCode: Number.isSafeInteger(child.exitCode) ? child.exitCode : null,
      stages: stages.map((stage) => ({ ...stage })),
    }),
    stop: () => {
      child.off("exit", onExit);
      child.off("close", onClose);
      child.stderr?.off("data", onStderr);
      stderrLine = "";
      clearTimeout(identityTimer);
      if (mainIdentity === "pending") mainIdentity = "unavailable";
    },
  };
  records.set(child, evidence);
  return evidence;
}

export function observeElectronIdentity(current: ElectronApplication, child: ChildProcess): void {
  electronProcessEvidence(child).captureMainPid(async () => await current.evaluate(() => process.pid));
}
