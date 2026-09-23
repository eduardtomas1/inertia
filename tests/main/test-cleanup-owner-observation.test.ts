import { describe, expect, it, vi } from "vitest";
import { RetryablePrivilegedCleanup } from "../../src/main/privileged-shutdown";
import { createTestCleanupOwnerObserver, createTestPrivilegedCleanupController } from
  "../../src/main/test-privileged-cleanup-controller";
import { formatElectronPrivilegedCleanupPhase } from "../e2e/support/electron-runtime-shutdown";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("test-only cleanup owner observation", () => {
  it("keeps promise and error identity, including synchronous failure", async () => {
    const observer = createTestCleanupOwnerObserver(true);
    const pending = deferred<void>();
    expect(observer.observe("runtime", () => pending.promise)).toBe(pending.promise);
    expect(observer.snapshot()?.runtime).toBe("pending");
    const failure = new Error("original cleanup failure");
    pending.reject(failure);
    await expect(pending.promise).rejects.toBe(failure);
    expect(observer.snapshot()?.runtime).toBe("rejected");
    expect(() => observer.observe("privateConnect", () => { throw failure; })).toThrow(failure);
    expect(observer.snapshot()?.privateConnect).toBe("rejected");
  });

  it("does not track outside the test environment", async () => {
    const observer = createTestCleanupOwnerObserver(false);
    const pending = Promise.resolve(false);
    expect(observer.observe("runtime", () => pending)).toBe(pending);
    await pending;
    expect(observer.snapshot()).toBeUndefined();
  });

  it("does not let a late previous attempt overwrite a newer pending or failed attempt", async () => {
    const observer = createTestCleanupOwnerObserver(true);
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    void observer.observe("runtime", () => first.promise);
    void observer.observe("runtime", () => second.promise);
    first.resolve(true);
    await first.promise;
    expect(observer.snapshot()?.runtime).toBe("pending");
    const failure = new Error("new synchronous failure");
    expect(() => observer.observe("runtime", () => { throw failure; })).toThrow(failure);
    second.resolve(true);
    await second.promise;
    expect(observer.snapshot()?.runtime).toBe("rejected");
  });

  it("distinguishes a clean runtime root with a held join from temporary and durable cleanup", async () => {
    const observer = createTestCleanupOwnerObserver(true);
    const secureFiles = deferred<void>();
    const temporary = deferred<void>();
    const durable = deferred<void>();
    const temporaryStarted = deferred<void>();
    const durableStarted = deferred<void>();
    const rootStopped = Promise.resolve(true);
    const cleanup = new RetryablePrivilegedCleanup({
      runtime: { stop: () => observer.observe("runtime", () =>
        Promise.all([rootStopped, secureFiles.promise]).then(() => true)) },
      privateConnect: { shutdown: () => observer.observe("privateConnect", () => Promise.resolve()) },
      onRuntimeStopped: vi.fn(), onRuntimeError: vi.fn(),
      onPrivateConnectStopped: vi.fn(), onPrivateConnectError: vi.fn(),
      disposeTemporaryAttachments: () => observer.observe("temporaryAttachments", () => {
        temporaryStarted.resolve(); return temporary.promise;
      }),
      closeDurableAttachments: () => observer.observe("durableAttachments", () => {
        durableStarted.resolve(); return durable.promise;
      }),
      onDurableAttachmentsClosed: vi.fn(), onTemporaryAttachmentError: vi.fn(),
      onUnconfirmedRuntimeExit: vi.fn(),
    });
    const controller = createTestPrivilegedCleanupController({
      runtimePid: () => 123, cleanup: () => cleanup.cleanup(),
      owners: observer.snapshot, exit: vi.fn(),
    });
    const preparation = controller.preparePrivilegedCleanup();
    expect(controller.preparePrivilegedCleanup()).toBe(preparation);
    await rootStopped;
    expect(controller.privilegedCleanupSnapshot()).toMatchObject({
      phase: "privileged-cleanup", cleanupConfirmed: null, owners: {
        runtime: "pending", privateConnect: "fulfilled",
        temporaryAttachments: "not-started", durableAttachments: "not-started",
      },
    });
    secureFiles.resolve();
    await temporaryStarted.promise;
    expect(observer.snapshot()).toMatchObject({ runtime: "fulfilled", temporaryAttachments: "pending" });
    temporary.resolve();
    await durableStarted.promise;
    expect(observer.snapshot()).toMatchObject({ temporaryAttachments: "fulfilled", durableAttachments: "pending" });
    durable.resolve();
    await expect(preparation).resolves.toMatchObject({ cleanupConfirmed: true, owners: {
      runtime: "fulfilled", privateConnect: "fulfilled",
      temporaryAttachments: "fulfilled", durableAttachments: "fulfilled",
    } });
  });

  it("does not turn fulfillment of false into cleanup authority or retry a cached preparation", async () => {
    const observer = createTestCleanupOwnerObserver(true);
    const cleanup = vi.fn(() => observer.observe("runtime", () => Promise.resolve(false)));
    const controller = createTestPrivilegedCleanupController({ runtimePid: () => 1,
      cleanup, owners: observer.snapshot, exit: vi.fn() });
    const preparation = controller.preparePrivilegedCleanup();
    await expect(preparation).resolves.toMatchObject({ cleanupConfirmed: false, owners: { runtime: "fulfilled" } });
    expect(controller.preparePrivilegedCleanup()).toBe(preparation);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(() => controller.finishPreparedQuit()).toThrow("cleanupConfirmed=false");
  });

  it("keeps the cleanup failure when the advisory snapshot throws", async () => {
    const failure = new Error("original");
    const controller = createTestPrivilegedCleanupController({ runtimePid: () => 1,
      cleanup: () => Promise.reject(failure), exit: vi.fn(),
      owners: () => { throw new Error("observer unavailable"); } });
    await expect(controller.preparePrivilegedCleanup()).rejects.toBe(failure);
    expect(controller.privilegedCleanupSnapshot()).toEqual({ phase: "privileged-cleanup-failed",
      cleanupConfirmed: false, runtimePid: 1, errorMessage: "original" });
  });

  it("formats only fixed owner states in failure evidence, retaining the actual phase", () => {
    const receipt = { phase: "privileged-cleanup", runtimePid: 1, cleanupConfirmed: null, errorMessage: null };
    expect(formatElectronPrivilegedCleanupPhase(null)).toBe("controller-unavailable");
    expect(formatElectronPrivilegedCleanupPhase(receipt)).toBe("privileged-cleanup");
    const owners = { runtime: "pending", privateConnect: "fulfilled",
      temporaryAttachments: "not-started", durableAttachments: "rejected", secret: "PRIVATE" };
    expect(formatElectronPrivilegedCleanupPhase({ ...receipt, owners })).toBe(
      "privileged-cleanup;owners=runtime:pending,privateConnect:fulfilled,temporaryAttachments:not-started,durableAttachments:rejected",
    );
    expect(formatElectronPrivilegedCleanupPhase({ ...receipt, owners: { ...owners, runtime: "PRIVATE" } }))
      .toBe("privileged-cleanup;owners=unavailable");
    expect(formatElectronPrivilegedCleanupPhase({ ...receipt,
      get owners() { throw new Error("PRIVATE"); } })).toBe("privileged-cleanup;owners=unavailable");
    expect(receipt.phase).toBe("privileged-cleanup");
  });
});
