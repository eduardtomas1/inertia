import { describe, expect, it, vi } from "vitest";

import {
  inspectProjectIdentityWithDeadline,
  ProjectIdentityTimeout,
  type ProjectIdentity,
} from "../../src/server/project-identity";
import {
  PROJECT_IDENTITY_REFRESH_CONCURRENCY,
  ProjectIdentityRefresher,
  projectIdentityIsUsable,
} from "../../src/server/project-identity-refresh";
import {
  assertProjectIdentityAuthority,
} from "../../src/server/project-path";

function identity(path: string): ProjectIdentity {
  return {
    normalizedPath: path,
    repositoryIdentity: `git:${path}`,
    repositoryRoot: path,
    repositoryRelativePath: ".",
  };
}

function targets(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `project-${index}`,
    path: `/projects/${index}`,
  }));
}

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

describe("project identity deadline", () => {
  it("rejects when inspection outlives its deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = inspectProjectIdentityWithDeadline(
        "/never/resolves",
        50,
      );
      const assertion = expect(pending).rejects.toBeInstanceOf(
        ProjectIdentityTimeout,
      );
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces pre-Git filesystem failures instead of hanging", async () => {
    await expect(inspectProjectIdentityWithDeadline(
      "/definitely/missing/inertia-test-path",
      5_000,
    )).rejects.toThrow();
  });

  it("bounds the whole inspection, including realpath", async () => {
    const refresher = new ProjectIdentityRefresher({
      deadlineMs: 40,
      inspect: () => never(),
      apply: () => undefined,
    });
    const state = await refresher.refresh({
      id: "hangs-in-realpath",
      path: "/mnt/disconnected",
    });
    expect(state.freshness).toBe("unavailable");
    expect(state.reason).toContain("did not respond");
  });
});

describe("project identity refresher", () => {
  it("marks a project fresh and applies its identity", async () => {
    const applied: string[] = [];
    const refresher = new ProjectIdentityRefresher({
      inspect: async (path) => identity(path),
      apply: (projectId) => applied.push(projectId),
    });
    await refresher.refreshAll(targets(3));
    expect(applied.sort()).toEqual(["project-0", "project-1", "project-2"]);
    for (const target of targets(3)) {
      expect(refresher.state(target.id).freshness).toBe("fresh");
      expect(projectIdentityIsUsable(refresher.state(target.id))).toBe(true);
    }
  });

  it("reports a project as stale before it has ever been checked", () => {
    const refresher = new ProjectIdentityRefresher({
      inspect: async (path) => identity(path),
      apply: () => undefined,
    });
    const state = refresher.state("unknown");
    expect(state.freshness).toBe("stale");
    expect(state.checkedAt).toBeNull();
    expect(projectIdentityIsUsable(state)).toBe(false);
  });

  it("keeps working when one project never resolves", async () => {
    const applied: string[] = [];
    const refresher = new ProjectIdentityRefresher({
      concurrency: 2,
      deadlineMs: 100,
      inspect: async (path) => {
        if (path === "/projects/1") {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        return identity(path);
      },
      apply: (projectId) => applied.push(projectId),
    });
    const settled = refresher.refreshAll(targets(4));
    await settled;
    expect(applied).toContain("project-0");
    expect(applied).toContain("project-2");
    expect(applied).toContain("project-3");
    expect(applied).not.toContain("project-1");
    expect(refresher.state("project-1").freshness).toBe("unavailable");
    expect(refresher.state("project-1").reason).toContain("did not respond");
  }, 20_000);

  it("marks a disconnected or missing path unavailable without throwing", async () => {
    const refresher = new ProjectIdentityRefresher({
      inspect: async () => {
        throw new Error("ENOENT");
      },
      apply: () => undefined,
    });
    await refresher.refreshAll(targets(2));
    for (const target of targets(2)) {
      const state = refresher.state(target.id);
      expect(state.freshness).toBe("unavailable");
      expect(state.reason).toContain("could not be inspected");
    }
  });

  it("recovers a project that becomes available after startup", async () => {
    let available = false;
    const refresher = new ProjectIdentityRefresher({
      inspect: async (path) => {
        if (!available) throw new Error("ENOENT");
        return identity(path);
      },
      apply: () => undefined,
    });
    await refresher.refreshAll(targets(1));
    expect(refresher.state("project-0").freshness).toBe("unavailable");

    available = true;
    const state = await refresher.refresh({
      id: "project-0",
      path: "/projects/0",
    });
    expect(state.freshness).toBe("fresh");
  });

  it("never exceeds the configured concurrency across hundreds of projects", async () => {
    let active = 0;
    let peak = 0;
    const refresher = new ProjectIdentityRefresher({
      concurrency: 4,
      inspect: async (path) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return identity(path);
      },
      apply: () => undefined,
    });
    await refresher.refreshAll(targets(300));
    expect(peak).toBeLessThanOrEqual(4);
    expect(refresher.peakConcurrency()).toBeLessThanOrEqual(4);
  });

  it("keeps timed-out underlying inspections inside the concurrency cap", async () => {
    vi.useFakeTimers();
    try {
      let inspections = 0;
      const refresher = new ProjectIdentityRefresher({
        concurrency: 2,
        deadlineMs: 100,
        inspect: () => {
          inspections += 1;
          return never();
        },
        apply: () => undefined,
      });
      const refresh = refresher.refreshAll(targets(20));

      await vi.advanceTimersByTimeAsync(101);
      await refresh;

      expect(inspections).toBe(2);
      expect(refresher.peakConcurrency()).toBe(2);
      for (const target of targets(20)) {
        expect(refresher.state(target.id).freshness).toBe("unavailable");
      }
      refresher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares the concurrency limit with on-demand refreshes", async () => {
    let active = 0;
    let peak = 0;
    const inspected: string[] = [];
    const refresher = new ProjectIdentityRefresher({
      concurrency: 2,
      inspect: async (path) => {
        active += 1;
        peak = Math.max(peak, active);
        inspected.push(path);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return identity(path);
      },
      apply: () => undefined,
    });
    const startup = refresher.refreshAll(targets(20));
    const onDemand = refresher.refresh({
      id: "on-demand",
      path: "/projects/on-demand",
    });
    await Promise.all([startup, onDemand]);
    expect(inspected).toContain("/projects/on-demand");
    expect(peak).toBeLessThanOrEqual(2);
    expect(refresher.peakConcurrency()).toBeLessThanOrEqual(2);
  });

  it("clamps its concurrency into the reviewed range", async () => {
    let peak = 0;
    let active = 0;
    const refresher = new ProjectIdentityRefresher({
      concurrency: 500,
      inspect: async (path) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return identity(path);
      },
      apply: () => undefined,
    });
    await refresher.refreshAll(targets(64));
    expect(peak).toBeLessThanOrEqual(8);
    expect(PROJECT_IDENTITY_REFRESH_CONCURRENCY).toBeGreaterThanOrEqual(4);
    expect(PROJECT_IDENTITY_REFRESH_CONCURRENCY).toBeLessThanOrEqual(8);
  });

  it("coalesces concurrent refreshes of one project", async () => {
    let calls = 0;
    const refresher = new ProjectIdentityRefresher({
      inspect: async (path) => {
        calls += 1;
        await Promise.resolve();
        return identity(path);
      },
      apply: () => undefined,
    });
    const target = { id: "project-0", path: "/projects/0" };
    await Promise.all([
      refresher.refresh(target),
      refresher.refresh(target),
      refresher.refresh(target),
    ]);
    expect(calls).toBe(1);
  });

  it("stops applying identities and settles cleanly after dispose", async () => {
    const applied: string[] = [];
    const refresher = new ProjectIdentityRefresher({
      concurrency: 1,
      inspect: async (path) => {
        await Promise.resolve();
        return identity(path);
      },
      apply: (projectId) => applied.push(projectId),
    });
    const running = refresher.refreshAll(targets(50));
    refresher.dispose();
    await running;
    expect(applied.length).toBeLessThan(50);
  });

  it("settles an active inspection immediately after dispose", async () => {
    const refresher = new ProjectIdentityRefresher({
      inspect: () => never(),
      apply: () => undefined,
    });
    const running = refresher.refresh({
      id: "blocked-project",
      path: "/mnt/disconnected",
    });
    refresher.dispose();
    await expect(running).resolves.toMatchObject({
      freshness: "stale",
      checkedAt: null,
    });
  });

  it("does not apply an identity that resolves after dispose", async () => {
    const applied: string[] = [];
    let release = (): void => undefined;
    const refresher = new ProjectIdentityRefresher({
      inspect: async (path) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return identity(path);
      },
      apply: (projectId) => applied.push(projectId),
    });
    const running = refresher.refresh({ id: "project-0", path: "/projects/0" });
    refresher.dispose();
    release();
    await running;
    expect(applied).toEqual([]);
  });

  it("reports settled transitions for diagnostics", async () => {
    const settled: string[] = [];
    const refresher = new ProjectIdentityRefresher({
      inspect: async () => {
        throw new Error("ENOENT");
      },
      apply: () => undefined,
      onSettled: (projectId, state) =>
        settled.push(`${projectId}:${state.freshness}`),
    });
    await refresher.refreshAll(targets(1));
    expect(settled).toEqual(["project-0:unavailable"]);
  });
});

describe("sensitive operation boundaries", () => {
  it("allows an operation when identity is fresh", async () => {
    const refresher = new ProjectIdentityRefresher({
      inspect: async (path) => identity(path),
      apply: () => undefined,
    });
    await refresher.refreshAll(targets(1));
    await expect(assertProjectIdentityAuthority({
      revalidate: async (projectId) =>
        projectIdentityIsUsable(refresher.state(projectId)),
    }, "project-0", "/projects/0")).resolves.toBeUndefined();
  });

  it("refuses an operation on stale or unavailable authority", async () => {
    const refresher = new ProjectIdentityRefresher({
      inspect: async () => {
        throw new Error("ENOENT");
      },
      apply: () => undefined,
    });
    await refresher.refreshAll(targets(1));
    await expect(assertProjectIdentityAuthority({
      revalidate: async (projectId) =>
        projectIdentityIsUsable(refresher.state(projectId)),
    }, "project-0", "/projects/0")).rejects.toThrow(
      "cannot verify its identity",
    );
    await expect(assertProjectIdentityAuthority({
      revalidate: async (projectId) =>
        projectIdentityIsUsable(refresher.state(projectId)),
    }, "never-checked", "/projects/x")).rejects.toThrow(
      "cannot verify its identity",
    );
  });

  it("stays permissive when no authority is wired", async () => {
    await expect(assertProjectIdentityAuthority(
      undefined,
      "project-0",
      "/projects/0",
    )).resolves.toBeUndefined();
  });

  it("revalidates a recovered project at the boundary", async () => {
    let available = false;
    const refresher = new ProjectIdentityRefresher({
      inspect: async (path) => {
        if (!available) throw new Error("ENOENT");
        return identity(path);
      },
      apply: () => undefined,
    });
    const authority = {
      revalidate: async (projectId: string, projectPath: string) => {
        if (projectIdentityIsUsable(refresher.state(projectId))) return true;
        return projectIdentityIsUsable(
          await refresher.refresh({ id: projectId, path: projectPath }),
        );
      },
    };
    await expect(assertProjectIdentityAuthority(
      authority,
      "project-0",
      "/projects/0",
    )).rejects.toThrow();

    available = true;
    await expect(assertProjectIdentityAuthority(
      authority,
      "project-0",
      "/projects/0",
    )).resolves.toBeUndefined();
  });
});

describe("runtime readiness is independent of project identity", () => {
  it("resolves refreshAll even when every project is unavailable", async () => {
    const refresher = new ProjectIdentityRefresher({
      concurrency: 4,
      deadlineMs: 50,
      inspect: () => never(),
      apply: () => undefined,
    });
    await refresher.refreshAll(targets(8));
    for (const target of targets(8)) {
      expect(refresher.state(target.id).freshness).toBe("unavailable");
    }
  }, 20_000);
});
