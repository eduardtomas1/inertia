import {
  verifyLinuxRuntimeOwnedGuardianSandbox,
  type LinuxGuardianExecutableIdentity,
} from "../node/runtime-owned-process-linux.js";

export class RuntimeWorkerStartupPreflightError extends Error {
  readonly code = "linux-guardian-sandbox-selftest-failed";

  constructor() {
    super("The Linux runtime process guardian sandbox self-test failed.");
    this.name = "RuntimeWorkerStartupPreflightError";
  }
}

export function activateAfterRuntimeWorkerStartupPreflight<T>(
  options: {
    readonly platform: NodeJS.Platform;
    readonly guardianPath?: string;
    readonly verifyLinuxGuardian?: (
      guardianPath: string,
    ) => LinuxGuardianExecutableIdentity | null;
  },
  activate: (linuxGuardianExecutable: LinuxGuardianExecutableIdentity | null) => T,
): T {
  let linuxGuardianExecutable: LinuxGuardianExecutableIdentity | null = null;
  if (options.platform === "linux") {
    if (!options.guardianPath) throw new RuntimeWorkerStartupPreflightError();
    const verify = options.verifyLinuxGuardian
      ?? verifyLinuxRuntimeOwnedGuardianSandbox;
    linuxGuardianExecutable = verify(options.guardianPath);
    if (!linuxGuardianExecutable) {
      throw new RuntimeWorkerStartupPreflightError();
    }
  }
  return activate(linuxGuardianExecutable);
}
