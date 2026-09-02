import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  awaitRuntimeOwnedProcessCleanupConfirmed,
  runtimeOwnedProcessOwnershipIsTainted,
  RuntimeOwnedProcessJournal,
} from "../../src/node/runtime-owned-processes";
import { getRepositoryStatus } from "../../src/server/git";
import { repositoryMetadataMarkerIdentity } from "../../src/server/git/paths";
import {
  GIT_SCAN_GLOBAL_GUARDED_DESCENDANT_BUDGET,
  GIT_SCAN_GUARDED_DESCENDANT_BUDGET_PER_KEY,
  GIT_SCAN_MAX_CONCURRENT_KEYS,
  GitScanCoordinator,
  validatedGitScanIdentity,
  type GitScanRequest,
} from "../../src/server/git/scan-coordinator";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const linuxIt = process.platform === "linux" ? it : it.skip;
const roots: string[] = [];
const STATUS_INSPECTION_CEILING = 6;
const GUARDED_PROCESSES_PER_INSPECTION = 2;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "inertia@example.invalid",
      GIT_AUTHOR_NAME: "Inertia Test",
      GIT_COMMITTER_EMAIL: "inertia@example.invalid",
      GIT_COMMITTER_NAME: "Inertia Test",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function repository(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root);
  git(root, "init", "-b", "main");
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "Initial");
  return root;
}

function procChildren(pid: number): number[] {
  try {
    const children = readFileSync(
      `/proc/${pid}/task/${pid}/children`,
      "utf8",
    ).trim();
    return children ? children.split(/\s+/u).map(Number) : [];
  } catch {
    return [];
  }
}

function descendants(pid: number): number[] {
  const found: number[] = [];
  const pending = [...procChildren(pid)];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const child = pending.pop();
    if (!child || visited.has(child)) continue;
    visited.add(child);
    found.push(child);
    pending.push(...procChildren(child));
  }
  return found;
}

function procState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd < 0 ? null : stat.slice(commandEnd + 2, commandEnd + 3);
  } catch {
    return null;
  }
}

function procResourceUsage(pid: number): { rssKb: number; threads: number } {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return {
      rssKb: Number(/^VmRSS:\s+(\d+)/mu.exec(status)?.[1] ?? 0),
      threads: Number(/^Threads:\s+(\d+)/mu.exec(status)?.[1] ?? 0),
    };
  } catch {
    return { rssKb: 0, threads: 0 };
  }
}

async function awaitDescendantSettlement(timeoutMs = 5_000): Promise<number> {
  const startedAt = performance.now();
  const deadlineAt = startedAt + timeoutMs;
  let consecutiveEmptySamples = 0;
  while (performance.now() < deadlineAt) {
    if (descendants(process.pid).length === 0) {
      consecutiveEmptySamples += 1;
      if (consecutiveEmptySamples === 2) {
        return performance.now() - startedAt;
      }
    } else {
      consecutiveEmptySamples = 0;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return performance.now() - startedAt;
}

function observeDescendants(): {
  finish: (settlementMs?: number) => {
    durationMs: number;
    finalDescendants: number[];
    forkRatePerSecond: number;
    peakDescendants: number;
    peakDescendantRssKb: number;
    peakDescendantThreads: number;
    settlementMs: number;
    uniqueDescendants: number;
    zombiesAtSettlement: number;
  };
} {
  const startedAt = performance.now();
  const observed = new Set<number>();
  let peakDescendants = 0;
  let peakDescendantRssKb = 0;
  let peakDescendantThreads = 0;
  const sample = (): void => {
    const current = descendants(process.pid);
    peakDescendants = Math.max(peakDescendants, current.length);
    const usage = current.map(procResourceUsage);
    peakDescendantRssKb = Math.max(
      peakDescendantRssKb,
      usage.reduce((sum, entry) => sum + entry.rssKb, 0),
    );
    peakDescendantThreads = Math.max(
      peakDescendantThreads,
      usage.reduce((sum, entry) => sum + entry.threads, 0),
    );
    current.forEach((pid) => observed.add(pid));
  };
  sample();
  const timer = setInterval(sample, 1);
  return {
    finish: (settlementMs = 0) => {
      clearInterval(timer);
      sample();
      const durationMs = Math.max(1, performance.now() - startedAt);
      const finalDescendants = descendants(process.pid);
      return {
        durationMs,
        finalDescendants,
        forkRatePerSecond: observed.size / (durationMs / 1_000),
        peakDescendants,
        peakDescendantRssKb,
        peakDescendantThreads,
        settlementMs,
        uniqueDescendants: observed.size,
        zombiesAtSettlement: finalDescendants.filter(
          (pid) => procState(pid) === "Z",
        ).length,
      };
    },
  };
}

async function scanRequest(
  coordinator: GitScanCoordinator,
  repositoryRoot: string,
  authorityGeneration: string,
): Promise<Omit<GitScanRequest, "deadlineAt" | "signal">> {
  const marker = await repositoryMetadataMarkerIdentity(repositoryRoot);
  const identity = validatedGitScanIdentity(repositoryRoot, marker);
  return {
    authorityGeneration,
    identity,
    invalidation: coordinator.currentInvalidation(identity),
    optionsKey: "linux-real-status:v1",
    scope: "workspace",
  };
}

describe("Git scan coordinator with the real Linux guardian", () => {
  linuxIt("coalesces a refresh/mutation burst into one newest trailing scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-git-scan-linux-burst-"));
    roots.push(root);
    const repositoryRoot = repository(root, "repository");
    const coordinator = new GitScanCoordinator();
    const baseRequest = await scanRequest(
      coordinator,
      repositoryRoot,
      "project:conversation:generation-1",
    );
    const generation = `${randomUUID()}:1`;
    const boot = `test:${randomUUID()}`;
    const restartRuntimeAfterTaint = vi.fn();
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      root,
      generation,
      boot,
      {
        darwinGuardianPath: join(
          process.cwd(),
          "resources/generated/runtime-process-guardian/runtime-process-guardian",
        ),
        onTainted: restartRuntimeAfterTaint,
        platform: "linux",
      },
    );
    const journal = new RuntimeOwnedProcessJournal(root, { platform: "linux" });
    const observer = observeDescendants();
    let finishFirst!: () => void;
    let firstCaptured!: () => void;
    const firstCapturedPromise = new Promise<void>((resolve) => {
      firstCaptured = resolve;
    });
    const finishFirstPromise = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let executions = 0;
    const execute = vi.fn(async (execution: { invalidation: number }) => {
      executions += 1;
      const status = await getRepositoryStatus(repositoryRoot);
      const contents = readFileSync(join(repositoryRoot, "tracked.txt"), "utf8");
      if (executions === 1) {
        firstCaptured();
        await finishFirstPromise;
      }
      return { contents, invalidation: execution.invalidation, status };
    });

    try {
      const active = coordinator.request(baseRequest, execute);
      await firstCapturedPromise;
      const pending = Array.from({ length: 32 }, (_, index) => {
        const invalidation = coordinator.invalidate(baseRequest.identity);
        if (index === 31) {
          writeFileSync(join(repositoryRoot, "tracked.txt"), "newest mutation\n");
        }
        return coordinator.request({
          ...baseRequest,
          invalidation,
        }, execute);
      });
      finishFirst();

      await expect(active).resolves.toMatchObject({
        contents: "initial\n",
        invalidation: 0,
      });
      const results = await Promise.all(pending);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(32);
      expect(results.every((result) => (
        result.contents === "newest mutation\n"
        && result.invalidation === 32
        && result.status.files.some((file) => file.path === "tracked.txt")
      ))).toBe(true);
      expect(await awaitRuntimeOwnedProcessCleanupConfirmed()).toBe(true);

      // A ChildProcess close and the registry's durable cleanup can settle in
      // the same event-loop turn that Linux still exposes the just-exited PID
      // as a zombie. Require two bounded empty /proc samples so a persistent
      // orphan still fails while the kernel/libuv reap boundary can complete.
      const settlementMs = await awaitDescendantSettlement();
      const metrics = observer.finish(settlementMs);
      const forkBudget = 2
        * STATUS_INSPECTION_CEILING
        * GUARDED_PROCESSES_PER_INSPECTION;
      expect(metrics).toMatchObject({
        finalDescendants: [],
        zombiesAtSettlement: 0,
      });
      expect(metrics.peakDescendants)
        .toBeLessThanOrEqual(GIT_SCAN_GUARDED_DESCENDANT_BUDGET_PER_KEY);
      expect(metrics.uniqueDescendants).toBeLessThanOrEqual(forkBudget);
      expect(metrics.forkRatePerSecond).toBeGreaterThan(0);
      expect(metrics.peakDescendantRssKb).toBeGreaterThan(0);
      expect(metrics.peakDescendantThreads).toBeGreaterThan(0);
      expect(journal.records(generation)).toEqual([]);
      expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
      expect(restartRuntimeAfterTaint).not.toHaveBeenCalled();
      console.info("issue-220 Linux burst trace", JSON.stringify(metrics));
    } finally {
      finishFirst();
      observer.finish();
      deactivate?.();
    }
  }, 30_000);

  linuxIt("bounds concurrent repository scans and guarded descendants globally", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-git-scan-linux-global-"));
    roots.push(root);
    const repositoryRoots = Array.from({ length: 6 }, (_, index) => (
      repository(root, `repository-${index}`)
    ));
    const coordinator = new GitScanCoordinator();
    const requests = await Promise.all(repositoryRoots.map(
      async (repositoryRoot, index) => await scanRequest(
        coordinator,
        repositoryRoot,
        `project-${index}:conversation:generation-1`,
      ),
    ));
    const generation = `${randomUUID()}:1`;
    const boot = `test:${randomUUID()}`;
    const restartRuntimeAfterTaint = vi.fn();
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      root,
      generation,
      boot,
      {
        darwinGuardianPath: join(
          process.cwd(),
          "resources/generated/runtime-process-guardian/runtime-process-guardian",
        ),
        onTainted: restartRuntimeAfterTaint,
        platform: "linux",
      },
    );
    const journal = new RuntimeOwnedProcessJournal(root, { platform: "linux" });
    const observer = observeDescendants();
    let activeKeys = 0;
    let peakActiveKeys = 0;

    try {
      const statuses = await Promise.all(requests.map((request, index) => (
        coordinator.request(request, async () => {
          activeKeys += 1;
          peakActiveKeys = Math.max(peakActiveKeys, activeKeys);
          try {
            return await getRepositoryStatus(repositoryRoots[index]!);
          } finally {
            activeKeys -= 1;
          }
        })
      )));
      expect(statuses).toHaveLength(repositoryRoots.length);
      expect(peakActiveKeys).toBe(GIT_SCAN_MAX_CONCURRENT_KEYS);
      expect(await awaitRuntimeOwnedProcessCleanupConfirmed()).toBe(true);

      const settlementMs = await awaitDescendantSettlement();
      const metrics = observer.finish(settlementMs);
      const forkBudget = repositoryRoots.length
        * STATUS_INSPECTION_CEILING
        * GUARDED_PROCESSES_PER_INSPECTION;
      expect(metrics).toMatchObject({
        finalDescendants: [],
        zombiesAtSettlement: 0,
      });
      expect(metrics.peakDescendants)
        .toBeLessThanOrEqual(GIT_SCAN_GLOBAL_GUARDED_DESCENDANT_BUDGET);
      expect(metrics.uniqueDescendants).toBeLessThanOrEqual(forkBudget);
      expect(metrics.forkRatePerSecond).toBeGreaterThan(0);
      expect(metrics.peakDescendantRssKb).toBeGreaterThan(0);
      expect(metrics.peakDescendantThreads).toBeGreaterThan(0);
      expect(journal.records(generation)).toEqual([]);
      expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
      expect(restartRuntimeAfterTaint).not.toHaveBeenCalled();
      console.info("issue-220 Linux global trace", JSON.stringify(metrics));
    } finally {
      observer.finish();
      deactivate?.();
    }
  }, 30_000);
});
