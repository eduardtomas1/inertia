import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createCheckpoint, deleteCheckpoints } from "../../src/server/checkpoints";
import { createCheckpointBenchmarkRepository } from
  "../helpers/checkpoint-benchmark-repository";

const enforce = process.env.INERTIA_BENCHMARK_ENFORCE === "1";
const reportPath = resolve(
  dirname(
    process.env.INERTIA_BENCHMARK_REPORT
      ?? `performance-results/platform-${process.platform}-${process.arch}.json`,
  ),
  `checkpoint-${process.platform}-${process.arch}.json`,
);
const SMALL_REPOSITORY_FILES = 20;
const LARGE_REPOSITORY_FILES = 12_000;
const MAXIMUM_LARGE_TO_SMALL_RATIO = 6;
const CATASTROPHIC_LARGE_CHECKPOINT_MS = 10_000;
const SAMPLES = 5;
const execFileAsync = promisify(execFile);

async function checkpointMeasurement(
  root: string,
  files: number,
  environment: NodeJS.ProcessEnv,
): Promise<{ files: number; medianMs: number; samples: number[] }> {
  const repositoryPath = join(root, `repository-${files}`);
  const fixture = await createCheckpointBenchmarkRepository(repositoryPath, files, environment);
  expect(fixture.stderr).toBe("");
  const tracked = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repositoryPath, env: environment, maxBuffer: 4 * 1_048_576, timeout: 30_000,
  });
  expect(tracked.stdout.split("\0").filter(Boolean)).toHaveLength(files);
  const storage = join(root, `indexes-${files}`);
  const conversationId = randomUUID();
  try {
    await createCheckpoint(repositoryPath, storage, conversationId);
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const startedAt = performance.now();
      await createCheckpoint(repositoryPath, storage, conversationId);
      samples.push(Number((performance.now() - startedAt).toFixed(3)));
    }
    const ordered = [...samples].sort((left, right) => left - right);
    return {
      files,
      medianMs: ordered[Math.floor(ordered.length / 2)]!,
      samples,
    };
  } finally {
    await deleteCheckpoints(repositoryPath, conversationId);
  }
}

describe("checkpoint benchmark", () => {
  it("keeps repeated checkpoints from growing with unchanged tracked files", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-checkpoint-benchmark-"));
    try {
      const globalConfig = join(root, "gitconfig");
      await writeFile(globalConfig, "[core]\n\tautocrlf = true\n\tsafecrlf = warn\n");
      const environment = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" };
      const small = await checkpointMeasurement(root, SMALL_REPOSITORY_FILES, environment);
      const large = await checkpointMeasurement(root, LARGE_REPOSITORY_FILES, environment);
      const ratio = Number((large.medianMs / small.medianMs).toFixed(3));
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify({
        schemaVersion: 1,
        collectedAt: new Date().toISOString(),
        enforced: enforce,
        platform: process.platform,
        architecture: process.arch,
        small,
        large,
        largeToSmallRatio: ratio,
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

      expect(small.medianMs).toBeGreaterThan(0);
      expect(large.medianMs).toBeGreaterThan(0);
      if (enforce) {
        expect(ratio).toBeLessThan(MAXIMUM_LARGE_TO_SMALL_RATIO);
        expect(large.medianMs).toBeLessThan(CATASTROPHIC_LARGE_CHECKPOINT_MS);
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        ...(process.platform === "win32"
          ? { maxRetries: 8, retryDelay: 100 }
          : {}),
      });
    }
  });
});
