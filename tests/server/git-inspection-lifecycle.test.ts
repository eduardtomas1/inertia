import { describe, expect, it, vi } from "vitest";

import { gitInspectionLifecycle } from "../../src/server/git/inspection-lifecycle";
import { withGitScanProcessSlot } from "../../src/server/git/scan-coordinator";
import {
  GIT_PROCESS_TREE_TERMINATION_FAILURE,
  GitError,
} from "../../src/server/git/types";

describe("Git inspection lifecycle", () => {
  it("cancels raw inspections and holds admission through shutdown drains", async () => {
    let releaseCleanup!: () => void;
    const cleanupStarted = vi.fn();
    const operationStarted = vi.fn();
    const active = withGitScanProcessSlot({}, async (signal) =>
      await new Promise<never>((_resolve, reject) => {
        operationStarted();
        signal.addEventListener("abort", () => {
          cleanupStarted();
          void new Promise<void>((resolve) => {
            releaseCleanup = resolve;
          }).then(() => reject(new GitError("timeout", "Cancelled.")));
        }, { once: true });
      }));
    const activeError = active.catch((error: unknown) => error);
    await vi.waitFor(() => expect(operationStarted).toHaveBeenCalledOnce());

    let releaseRuntimeWork!: () => void;
    const runtimeWork = new Promise<void>((resolve) => {
      releaseRuntimeWork = resolve;
    });
    const drain = gitInspectionLifecycle.cancelAndDrainWhile(async () => {
      await expect(withGitScanProcessSlot(
        {},
        async () => "unreachable",
      )).rejects.toMatchObject({ code: "timeout" });
      await runtimeWork;
    });
    await vi.waitFor(() => expect(cleanupStarted).toHaveBeenCalledOnce());
    releaseCleanup();
    releaseRuntimeWork();
    await drain;
    expect(await activeError).toMatchObject({ code: "timeout" });

    await expect(withGitScanProcessSlot(
      {},
      async () => "reopened",
    )).resolves.toBe("reopened");
  });

  it("fails shutdown closed when raw process-tree cleanup is unconfirmed", async () => {
    const cleanupFailure = new GitError(
      "operation-failed",
      GIT_PROCESS_TREE_TERMINATION_FAILURE,
    );
    const operationStarted = vi.fn();
    const active = withGitScanProcessSlot({}, async (signal) =>
      await new Promise<never>((_resolve, reject) => {
        operationStarted();
        signal.addEventListener("abort", () => reject(cleanupFailure), {
          once: true,
        });
      }));
    const activeError = active.catch((error: unknown) => error);
    await vi.waitFor(() => expect(operationStarted).toHaveBeenCalledOnce());
    await expect(gitInspectionLifecycle.cancelAndDrainWhile(
      async () => undefined,
    )).rejects.toBe(cleanupFailure);
    expect(await activeError).toBe(cleanupFailure);
  });
});
