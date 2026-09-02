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
import { Worker } from "node:worker_threads";

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
  GIT_SCAN_MAX_CONCURRENT_KEYS,
  GIT_SCAN_GUARDED_DESCENDANT_BUDGET_PER_KEY,
  GIT_SCAN_PROCESS_BUDGET_PER_KEY,
  GitScanCoordinator,
  validatedGitScanIdentity,
  type GitScanRequest,
} from "../../src/server/git/scan-coordinator";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const linuxIt = process.platform === "linux" ? it : it.skip;
const roots: string[] = [];
const STATUS_INSPECTION_CEILING = 6;
const CONTROL_HELPERS_PER_ACTIVE_INSPECTION = 1;
const LINUX_FORKS_PER_INSPECTION = 5;

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

interface LinuxProcessMetrics {
  durationMs: number;
  finalDescendants: number[];
  forkRatePerSecond: number;
  peakControlHelpers: number;
  peakDescendants: number;
  peakGuardedTreeDescendants: number;
  peakDescendantRssKb: number;
  peakDescendantThreads: number;
  settlementMs: number;
  uniqueDescendants: number;
  zombiesAtSettlement: number;
}

async function observeDescendants(repositoryRoots: readonly string[]): Promise<{
  finish: () => Promise<LinuxProcessMetrics>;
}> {
  const worker = new Worker(new URL(
    "../helpers/linux-git-scan-process-observer.mjs",
    import.meta.url,
  ), {
    workerData: { parentPid: process.pid, repositoryRoots },
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    worker.once("error", failed);
    worker.on("message", (message: { type?: string }) => {
      if (message.type !== "ready") return;
      worker.removeListener("error", failed);
      resolve();
    });
  });
  let metricsPromise: Promise<LinuxProcessMetrics> | null = null;
  return {
    finish: () => {
      metricsPromise ??= new Promise<LinuxProcessMetrics>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        worker.once("error", fail);
        worker.once("exit", (code) => {
          if (!settled) {
            fail(new Error(`The Linux process observer exited with code ${code}.`));
          }
        });
        worker.on("message", (message: {
          type?: string;
          value?: LinuxProcessMetrics;
        }) => {
          if (settled || message.type !== "metrics" || !message.value) return;
          settled = true;
          resolve(message.value);
        });
        worker.postMessage("finish");
      });
      return metricsPromise;
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
    const observer = await observeDescendants([repositoryRoot]);
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

      // The independent observer requires two bounded empty /proc samples, so
      // a persistent orphan fails while the kernel/libuv reap boundary can
      // complete after the registry's durable cleanup settles.
      const metrics = await observer.finish();
      const forkBudget = 2
        * STATUS_INSPECTION_CEILING
        * LINUX_FORKS_PER_INSPECTION;
      console.info("issue-220 Linux burst trace", JSON.stringify(metrics));
      expect(metrics).toMatchObject({
        finalDescendants: [],
        zombiesAtSettlement: 0,
      });
      expect(metrics.peakGuardedTreeDescendants).toBeLessThanOrEqual(
        GIT_SCAN_GUARDED_DESCENDANT_BUDGET_PER_KEY,
      );
      expect(metrics.peakControlHelpers).toBeLessThanOrEqual(
        GIT_SCAN_PROCESS_BUDGET_PER_KEY
          * CONTROL_HELPERS_PER_ACTIVE_INSPECTION,
      );
      expect(metrics.peakDescendants).toBeLessThanOrEqual(
        GIT_SCAN_GUARDED_DESCENDANT_BUDGET_PER_KEY
          + GIT_SCAN_PROCESS_BUDGET_PER_KEY
            * CONTROL_HELPERS_PER_ACTIVE_INSPECTION,
      );
      expect(metrics.uniqueDescendants).toBeLessThanOrEqual(forkBudget);
      expect(metrics.forkRatePerSecond).toBeGreaterThan(0);
      expect(metrics.peakControlHelpers).toBeGreaterThan(0);
      expect(metrics.peakDescendantRssKb).toBeGreaterThan(0);
      expect(metrics.peakDescendantThreads).toBeGreaterThan(0);
      expect(journal.records(generation)).toEqual([]);
      expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
      expect(restartRuntimeAfterTaint).not.toHaveBeenCalled();
    } finally {
      finishFirst();
      await observer.finish();
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
    const observer = await observeDescendants(repositoryRoots);
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

      const metrics = await observer.finish();
      const forkBudget = repositoryRoots.length
        * STATUS_INSPECTION_CEILING
        * LINUX_FORKS_PER_INSPECTION;
      console.info("issue-220 Linux global trace", JSON.stringify(metrics));
      expect(metrics).toMatchObject({
        finalDescendants: [],
        zombiesAtSettlement: 0,
      });
      expect(metrics.peakGuardedTreeDescendants).toBeLessThanOrEqual(
        GIT_SCAN_GLOBAL_GUARDED_DESCENDANT_BUDGET,
      );
      expect(metrics.peakControlHelpers).toBeLessThanOrEqual(
        GIT_SCAN_MAX_CONCURRENT_KEYS
          * GIT_SCAN_PROCESS_BUDGET_PER_KEY
          * CONTROL_HELPERS_PER_ACTIVE_INSPECTION,
      );
      expect(metrics.peakDescendants).toBeLessThanOrEqual(
        GIT_SCAN_GLOBAL_GUARDED_DESCENDANT_BUDGET
          + GIT_SCAN_MAX_CONCURRENT_KEYS
            * GIT_SCAN_PROCESS_BUDGET_PER_KEY
            * CONTROL_HELPERS_PER_ACTIVE_INSPECTION,
      );
      expect(metrics.uniqueDescendants).toBeLessThanOrEqual(forkBudget);
      expect(metrics.forkRatePerSecond).toBeGreaterThan(0);
      expect(metrics.peakControlHelpers).toBeGreaterThan(0);
      expect(metrics.peakDescendantRssKb).toBeGreaterThan(0);
      expect(metrics.peakDescendantThreads).toBeGreaterThan(0);
      expect(journal.records(generation)).toEqual([]);
      expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
      expect(restartRuntimeAfterTaint).not.toHaveBeenCalled();
    } finally {
      await observer.finish();
      deactivate?.();
    }
  }, 30_000);
});
