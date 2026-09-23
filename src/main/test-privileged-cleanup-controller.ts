export type TestCleanupOwner =
  | "runtime" | "privateConnect" | "temporaryAttachments" | "durableAttachments";
export type TestCleanupOwnerState = "not-started" | "pending" | "fulfilled" | "rejected";
export type TestCleanupOwners = Record<TestCleanupOwner, TestCleanupOwnerState>;

/** Observes settlement only; fulfilled does not mean cleanup was confirmed. */
export function createTestCleanupOwnerObserver(enabled: boolean): {
  observe<T>(owner: TestCleanupOwner, operation: () => Promise<T>): Promise<T>;
  snapshot(): TestCleanupOwners | undefined;
} {
  const states: TestCleanupOwners = {
    runtime: "not-started", privateConnect: "not-started",
    temporaryAttachments: "not-started", durableAttachments: "not-started",
  };
  const attempts = new Map<TestCleanupOwner, object>();
  return {
    observe<T>(owner: TestCleanupOwner, operation: () => Promise<T>): Promise<T> {
      if (!enabled) return operation();
      const attempt = {};
      attempts.set(owner, attempt);
      states[owner] = "pending";
      let pending: Promise<T>;
      try { pending = operation(); }
      catch (error) {
        if (attempts.get(owner) === attempt) states[owner] = "rejected";
        throw error;
      }
      void pending.then(
        () => { if (attempts.get(owner) === attempt) states[owner] = "fulfilled"; },
        () => { if (attempts.get(owner) === attempt) states[owner] = "rejected"; },
      );
      // Cleanup keeps the original promise, rejection and await ordering.
      return pending;
    },
    snapshot: () => enabled ? { ...states } : undefined,
  };
}

export const testCleanupOwners = createTestCleanupOwnerObserver(process.env.NODE_ENV === "test");

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
  owners?: TestCleanupOwners;
}

interface TestPrivilegedCleanupDependencies {
  runtimePid: () => number | null;
  cleanup: () => Promise<boolean>;
  unconfirmedMessage?: () => string | null;
  exit: () => void;
  owners?: () => TestCleanupOwners | undefined;
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
  const snapshot = (): TestPrivilegedCleanupReceipt => {
    // Advisory observation must never replace the actual cleanup result.
    try {
      const owners = dependencies.owners?.();
      return owners ? { ...receipt, owners } : { ...receipt };
    } catch { return { ...receipt }; }
  };

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
          errorMessage: cleanupConfirmed
            ? null
            : dependencies.unconfirmedMessage?.()
              ?? "Privileged cleanup completed without confirming every owner stopped.",
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
