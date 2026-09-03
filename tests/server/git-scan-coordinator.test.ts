import { describe, expect, it, vi } from "vitest";

import {
  GIT_SCAN_MAX_CONCURRENT_KEYS,
  GitScanCoordinator,
  validatedGitScanIdentity,
  type GitScanExecution,
  type GitScanRequest,
} from "../../src/server/git/scan-coordinator";
import {
  GIT_PROCESS_TREE_TERMINATION_FAILURE,
  GitError,
} from "../../src/server/git/types";

const identity = validatedGitScanIdentity(
  "/validated/repository",
  "git-dir\0validated\0git-common-dir\0validated",
);

function request(
  update: Partial<GitScanRequest> = {},
): GitScanRequest {
  return {
    authorityGeneration: "project:conversation:generation-1",
    identity,
    invalidation: 0,
    optionsKey: "repository-status:v1",
    scope: "status",
    ...update,
  };
}

function controlledExecutions() {
  const releases: Array<() => void> = [];
  const execute = vi.fn(async (execution: GitScanExecution) => await new Promise<{
    invalidation: number;
    scope: GitScanExecution["scope"];
  }>((resolve) => {
    releases.push(() => resolve({
      invalidation: execution.invalidation,
      scope: execution.scope,
    }));
  }));
  return { execute, releases };
}

describe("Git scan coordinator", () => {
  it("runs one active scan and exactly one newest merged trailing invalidation", async () => {
    const coordinator = new GitScanCoordinator();
    const { execute, releases } = controlledExecutions();

    const active = coordinator.request(request(), execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const invalidationOne = coordinator.request(request({ invalidation: 1 }), execute);
    const invalidationTwo = coordinator.request(request({
      invalidation: 2,
      scope: "workspace",
    }), execute);
    const newest = coordinator.request(request({ invalidation: 3 }), execute);

    expect(execute).toHaveBeenCalledOnce();
    releases.shift()?.();
    await expect(active).resolves.toEqual({ invalidation: 0, scope: "status" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      invalidation: 3,
      scope: "workspace",
    });
    releases.shift()?.();

    const expected = { invalidation: 3, scope: "workspace" };
    await expect(invalidationOne).resolves.toEqual(expected);
    await expect(invalidationTwo).resolves.toEqual(expected);
    await expect(newest).resolves.toEqual(expected);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("lets workspace scope supersede an active status-only scan", async () => {
    const coordinator = new GitScanCoordinator();
    const { execute, releases } = controlledExecutions();
    const status = coordinator.request(request(), execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const workspace = coordinator.request(request({ scope: "workspace" }), execute);

    releases.shift()?.();
    await expect(status).resolves.toEqual({ invalidation: 0, scope: "status" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls[1]?.[0].scope).toBe("workspace");
    releases.shift()?.();
    await expect(workspace).resolves.toEqual({
      invalidation: 0,
      scope: "workspace",
    });
  });

  it("never coalesces incompatible authority generations or status options", async () => {
    const coordinator = new GitScanCoordinator();
    const { execute, releases } = controlledExecutions();
    const first = coordinator.request(request(), execute);
    const otherAuthority = coordinator.request(request({
      authorityGeneration: "project:conversation:generation-2",
    }), execute);
    const otherOptions = coordinator.request(request({
      optionsKey: "repository-status:without-untracked:v1",
    }), execute);

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    for (const release of releases.splice(0)) release();
    await Promise.all([first, otherAuthority, otherOptions]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("shares compatible active results and bounds globally active repository keys", async () => {
    const coordinator = new GitScanCoordinator();
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const execute = vi.fn(async () => await new Promise<number>((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      releases.push(() => {
        active -= 1;
        resolve(active);
      });
    }));
    const duplicateA = coordinator.request(request(), execute);
    const duplicateB = coordinator.request(request(), execute);
    const distinct = Array.from({ length: GIT_SCAN_MAX_CONCURRENT_KEYS + 2 },
      (_, index) => {
        const nextIdentity = validatedGitScanIdentity(
          `/validated/repository-${index}`,
          `marker-${index}`,
        );
        return coordinator.request(request({ identity: nextIdentity }), execute);
      });

    await vi.waitFor(() => expect(active).toBe(GIT_SCAN_MAX_CONCURRENT_KEYS));
    while (releases.length > 0 || active > 0) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all([duplicateA, duplicateB, ...distinct]);
    expect(peak).toBe(GIT_SCAN_MAX_CONCURRENT_KEYS);
    expect(execute).toHaveBeenCalledTimes(distinct.length + 1);
  });

  it("does not let one caller deadline cancel shared work", async () => {
    const coordinator = new GitScanCoordinator();
    const { execute, releases } = controlledExecutions();
    const durableCaller = coordinator.request(request(), execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const impatientCaller = coordinator.request(request({
      deadlineAt: Date.now() + 5,
    }), execute);

    await expect(impatientCaller).rejects.toMatchObject({ code: "timeout" });
    releases.shift()?.();
    await expect(durableCaller).resolves.toEqual({
      invalidation: 0,
      scope: "status",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not admit scans for callers already cancelled or expired", async () => {
    const coordinator = new GitScanCoordinator();
    const cancelled = new AbortController();
    cancelled.abort();
    const unreachable = vi.fn(async () => ({ unreachable: true }));

    await expect(coordinator.request(request({
      signal: cancelled.signal,
    }), unreachable)).rejects.toMatchObject({ code: "timeout" });
    await expect(coordinator.request(request({
      deadlineAt: Date.now() - 1,
    }), unreachable)).rejects.toMatchObject({ code: "timeout" });
    expect(unreachable).not.toHaveBeenCalled();

    const { execute, releases } = controlledExecutions();
    const active = coordinator.request(request(), execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await expect(coordinator.request(request({
      invalidation: 1,
      signal: cancelled.signal,
    }), execute)).rejects.toMatchObject({ code: "timeout" });

    releases.shift()?.();
    await expect(active).resolves.toEqual({
      invalidation: 0,
      scope: "status",
    });
    await coordinator.cancelAndDrain();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("observes admitted work when a deadline crosses during request setup", async () => {
    const coordinator = new GitScanCoordinator();
    const execute = vi.fn(async ({ signal }: GitScanExecution) =>
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new GitError(
          "timeout",
          "Injected scan cancellation.",
        )), { once: true });
      }));
    const active = coordinator.request(request(), execute);
    const activeRejected = expect(active).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValueOnce(2);
    const expired = coordinator.request(request({
      deadlineAt: 1,
      invalidation: 1,
    }), execute);
    now.mockRestore();

    await expect(expired).rejects.toMatchObject({ code: "timeout" });
    await Promise.all([activeRejected, coordinator.cancelAndDrain()]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("retains ownership after timeout until cancellation cleanup settles", async () => {
    const reportLateFailure = vi.fn();
    const coordinator = new GitScanCoordinator(20, reportLateFailure);
    let rejectCleanup!: (error: Error) => void;
    const cleanupStarted = vi.fn();
    const firstExecution = vi.fn(async ({ signal }: GitScanExecution) =>
      await new Promise<never>((_resolve, reject) => {
        rejectCleanup = reject;
        signal.addEventListener("abort", cleanupStarted, { once: true });
      }));
    const successor = vi.fn(async ({ invalidation, scope }: GitScanExecution) => ({
      invalidation,
      scope,
    }));

    await expect(coordinator.request(request(), firstExecution))
      .rejects.toMatchObject({ code: "timeout" });
    expect(cleanupStarted).toHaveBeenCalledOnce();

    const trailing = coordinator.request(
      request({ invalidation: 1 }),
      successor,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(successor).not.toHaveBeenCalled();

    const cleanupFailure = new Error("Injected process-tree cleanup failure.");
    rejectCleanup(cleanupFailure);
    await expect(trailing).resolves.toEqual({
      invalidation: 1,
      scope: "status",
    });
    expect(successor).toHaveBeenCalledOnce();
    expect(reportLateFailure).toHaveBeenCalledWith(cleanupFailure);
  });

  it("cancels and drains shared scans before runtime shutdown continues", async () => {
    const coordinator = new GitScanCoordinator();
    let releaseCleanup!: () => void;
    const cleanupStarted = vi.fn();
    const activeExecution = vi.fn(async ({ signal }: GitScanExecution) =>
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          cleanupStarted();
          void new Promise<void>((resolve) => {
            releaseCleanup = resolve;
          }).then(() => reject(new Error("Cancellation cleanup settled.")));
        }, { once: true });
      }));
    const trailingExecution = vi.fn(async () => ({ unreachable: true }));
    const active = coordinator.request(request(), activeExecution);
    const activeRejected = expect(active).rejects.toThrow(
      "Cancellation cleanup settled.",
    );
    await vi.waitFor(() => expect(activeExecution).toHaveBeenCalledOnce());
    const trailing = coordinator.request(
      request({ invalidation: 1 }),
      trailingExecution,
    );
    const trailingRejected = expect(trailing).rejects.toMatchObject({
      code: "timeout",
    });

    let drained = false;
    const drain = coordinator.cancelAndDrain().then(() => { drained = true; });
    await vi.waitFor(() => expect(cleanupStarted).toHaveBeenCalledOnce());
    expect(drained).toBe(false);
    expect(trailingExecution).not.toHaveBeenCalled();

    releaseCleanup();
    await Promise.all([activeRejected, trailingRejected, drain]);
    expect(drained).toBe(true);
    await expect(coordinator.request(
      request({ invalidation: 2 }),
      async () => ({ reusable: true }),
    )).resolves.toEqual({ reusable: true });
  });

  it("keeps admission closed while already-admitted runtime work drains", async () => {
    const coordinator = new GitScanCoordinator();
    let releaseRuntimeWork!: () => void;
    const runtimeWork = new Promise<void>((resolve) => {
      releaseRuntimeWork = resolve;
    });

    const drain = coordinator.cancelAndDrainWhile(async () => {
      await runtimeWork;
    });
    await expect(coordinator.request(
      request(),
      async () => ({ unreachable: true }),
    )).rejects.toMatchObject({ code: "timeout" });

    releaseRuntimeWork();
    await drain;
    await expect(coordinator.request(
      request({ invalidation: 1 }),
      async () => ({ reusable: true }),
    )).resolves.toEqual({ reusable: true });
  });

  it("cancels scans waiting for the active-key budget without executing them", async () => {
    const coordinator = new GitScanCoordinator();
    const execute = vi.fn(async ({ signal }: GitScanExecution) =>
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new GitError(
          "timeout",
          "Injected scan cancellation.",
        )), { once: true });
      }));
    const scans = Array.from(
      { length: GIT_SCAN_MAX_CONCURRENT_KEYS + 1 },
      (_, index) => coordinator.request(request({
        identity: validatedGitScanIdentity(
          `/validated/drain-${index}`,
          `drain-marker-${index}`,
        ),
      }), execute),
    );
    const rejectedScans = scans.map((scan) => expect(scan).rejects.toMatchObject({
      code: "timeout",
    }));
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(GIT_SCAN_MAX_CONCURRENT_KEYS);
    });

    await coordinator.cancelAndDrain();
    await Promise.all(rejectedScans);
    expect(execute).toHaveBeenCalledTimes(GIT_SCAN_MAX_CONCURRENT_KEYS);
  });

  it("fails the drain closed when Git process-tree cleanup is unconfirmed", async () => {
    const coordinator = new GitScanCoordinator();
    const cleanupFailure = new GitError(
      "operation-failed",
      GIT_PROCESS_TREE_TERMINATION_FAILURE,
    );
    const execute = vi.fn(
      async ({ signal }: GitScanExecution) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(cleanupFailure), {
            once: true,
          });
        }),
    );
    const active = coordinator.request(
      request(),
      execute,
    );
    const activeRejected = expect(active).rejects.toBe(cleanupFailure);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const drainRejected = expect(coordinator.cancelAndDrain())
      .rejects.toBe(cleanupFailure);
    await Promise.all([activeRejected, drainRejected]);
    await expect(coordinator.request(
      request({ invalidation: 1 }),
      async () => ({ reusable: true }),
    )).resolves.toEqual({ reusable: true });
  });
});
