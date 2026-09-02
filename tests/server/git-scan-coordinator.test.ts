import { describe, expect, it, vi } from "vitest";

import {
  GIT_SCAN_MAX_CONCURRENT_KEYS,
  GitScanCoordinator,
  validatedGitScanIdentity,
  type GitScanExecution,
  type GitScanRequest,
} from "../../src/server/git/scan-coordinator";

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

  it("force-settles an execution that ignores cancellation", async () => {
    const coordinator = new GitScanCoordinator(20);
    const neverSettles = vi.fn(async () => await new Promise<never>(() => {}));

    await expect(coordinator.request(request(), neverSettles))
      .rejects.toMatchObject({ code: "timeout" });
    await expect(coordinator.request(
      request(),
      async ({ invalidation, scope }) => ({ invalidation, scope }),
    )).resolves.toEqual({ invalidation: 0, scope: "status" });
  });
});
