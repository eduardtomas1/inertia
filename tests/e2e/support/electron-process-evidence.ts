import type { ElectronApplication } from "@playwright/test";
import type { ChildProcess } from "node:child_process";

type ProcessStage = "launcher-exit" | "launcher-close" | "main-window-page-closed" | "cleanup-prepared"
  | "quit-requested" | "quit-request-fulfilled" | "quit-request-rejected"
  | "graceful-exit" | "abnormal-exit" | "force-stop-started"
  | "force-stop-confirmed" | "force-stop-unconfirmed"
  | "transport-started" | "transport-settled" | "transport-timed-out"
  | "directory-remove-started" | "directory-remove-fulfilled"
  | "directory-remove-rejected" | "directory-remove-timed-out";

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
  const record = (stage: ProcessStage): void => {
    if (stages.length < 24) stages.push({ stage, elapsedMs: Math.max(0, Date.now() - startedAt) });
  };
  const onExit = (): void => { launcherExitObserved = true; record("launcher-exit"); };
  const onClose = (): void => { launcherCloseObserved = true; record("launcher-close"); };
  child.once("exit", onExit);
  child.once("close", onClose);
  const evidence: ElectronProcessEvidence = {
    record,
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
