export type TestPrivilegedCleanupPhase =
  | "idle"
  | "privileged-cleanup"
  | "privileged-cleanup-complete"
  | "privileged-cleanup-failed"
  | "exit-requested";

export interface TestPrivilegedCleanupReceipt {
  phase: TestPrivilegedCleanupPhase;
  runtimePid: number | null;
  cleanupConfirmed: boolean | null;
  errorMessage: string | null;
}

interface TestPrivilegedCleanupDependencies {
  runtimePid: () => number | null;
  cleanup: () => Promise<boolean>;
  exit: () => void;
}

export function createTestPrivilegedCleanupController(
  dependencies: TestPrivilegedCleanupDependencies,
): {
    preparePrivilegedCleanup: () => Promise<TestPrivilegedCleanupReceipt>;
    privilegedCleanupSnapshot: () => TestPrivilegedCleanupReceipt;
    finishPreparedQuit: () => TestPrivilegedCleanupReceipt;
  } {
  let receipt: TestPrivilegedCleanupReceipt = {
    phase: "idle",
    runtimePid: null,
    cleanupConfirmed: null,
    errorMessage: null,
  };
  let cleanup: Promise<TestPrivilegedCleanupReceipt> | null = null;
  const snapshot = (): TestPrivilegedCleanupReceipt => ({ ...receipt });

  const prepare = (): Promise<TestPrivilegedCleanupReceipt> => {
    if (cleanup) return cleanup;
    const runtimePid = dependencies.runtimePid();
    receipt = {
      phase: "privileged-cleanup",
      runtimePid,
      cleanupConfirmed: null,
      errorMessage: null,
    };
    cleanup = dependencies.cleanup().then(
      (cleanupConfirmed) => {
        receipt = {
          phase: "privileged-cleanup-complete",
          runtimePid,
          cleanupConfirmed,
          errorMessage: null,
        };
        return snapshot();
      },
      (error: unknown) => {
        receipt = {
          phase: "privileged-cleanup-failed",
          runtimePid,
          cleanupConfirmed: false,
          errorMessage: error instanceof Error
            ? error.message
            : "Privileged cleanup failed with a non-Error value.",
        };
        throw error;
      },
    );
    return cleanup;
  };

  const finish = (): TestPrivilegedCleanupReceipt => {
    if (
      receipt.phase !== "privileged-cleanup-complete"
      || receipt.cleanupConfirmed !== true
    ) {
      throw new Error(
        `Cannot finish the test quit without confirmed privileged cleanup (phase=${receipt.phase}, cleanupConfirmed=${String(receipt.cleanupConfirmed)}).`,
      );
    }
    receipt = { ...receipt, phase: "exit-requested" };
    setTimeout(dependencies.exit, 0);
    return snapshot();
  };

  return {
    preparePrivilegedCleanup: prepare,
    privilegedCleanupSnapshot: snapshot,
    finishPreparedQuit: finish,
  };
}
