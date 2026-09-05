import type { ChildProcess } from "node:child_process";

import type { DarwinProcessIdentity } from "./runtime-owned-process-darwin.js";
import type {
  LinuxProcessIdentity,
  RuntimeOwnedProcessPlatform,
  RuntimeOwnedProcessSessionCapability,
  RuntimeOwnedProcessJournal,
} from "./runtime-owned-process-journal.js";
import type { LinuxGuardianExecutableIdentity } from "./runtime-owned-process-linux.js";

export interface ActiveRuntimeOwnedProcessRegistry {
  readonly journal: RuntimeOwnedProcessJournal;
  readonly platform: RuntimeOwnedProcessPlatform;
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
  readonly sessionCapability: RuntimeOwnedProcessSessionCapability;
  readonly darwinGuardianPath: string | null;
  readonly linuxGuardianExecutable: LinuxGuardianExecutableIdentity | null;
  readonly readDarwinIdentity: (pid: number) => DarwinProcessIdentity | null;
  readonly readDarwinGuardianReady: (pid: number) => DarwinProcessIdentity | null;
  readonly readDarwinIdentityAsync: (
    pid: number,
    abortSignal?: AbortSignal,
  ) => Promise<DarwinProcessIdentity | null>;
  readonly readDarwinGuardianReadyAsync: (
    pid: number,
    abortSignal?: AbortSignal,
  ) => Promise<DarwinProcessIdentity | null>;
  readonly readDarwinSessionEmptyAsync: (
    sessionId: number,
    abortSignal?: AbortSignal,
  ) => Promise<boolean | null>;
  readonly claims: WeakMap<ChildProcess, ActiveRuntimeOwnedProcessClaim>;
  readonly activeLinuxMonitors: Set<() => void>;
  readonly admissionController: AbortController;
  readonly pendingAdmissions: Set<Promise<boolean>>;
  readonly pendingReleaseConfirmations: Set<Promise<boolean>>;
  readonly onTainted: () => void;
  tainted: boolean;
}

export interface ActiveRuntimeOwnedProcessClaim {
  readonly ownershipId: string;
  released: boolean;
  stopRequested: boolean;
  readonly waitForStopRequest: Promise<void>;
  readonly settleStopRequest: () => void;
  authorizationObserved: boolean;
  admissionSucceeded: boolean;
  groupExitReleaseAttempts: number;
  admission: Promise<boolean> | null;
  releaseConfirmation: Promise<boolean> | null;
  settleReleaseConfirmation: ((confirmed: boolean) => void) | null;
  linuxIdentity?: LinuxProcessIdentity;
  darwinIdentity?: DarwinProcessIdentity;
  darwinStopSignalSent?: boolean;
  darwinStopBarrier?: Promise<boolean>;
  settleLinuxMonitorConfirmation?: (confirmed: boolean) => void;
  stopLinuxMonitor?: () => void;
}
