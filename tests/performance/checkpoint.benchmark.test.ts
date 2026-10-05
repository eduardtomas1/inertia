import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createCheckpoint, deleteCheckpoints } from "../../src/server/checkpoints";

const execFileAsync = promisify(execFile);
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

async function repository(root: string, files: number): Promise<void> {
  await mkdir(root);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  for (let start = 0; start < files; start += 500) {
    await Promise.all(Array.from(
      { length: Math.min(500, files - start) },
      async (_, offset) => {
        const index = start + offset;
        const directory = join(root, `module-${Math.floor(index / 100)}`);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `file-${index}.ts`),
          `export const value${index} = ${index};\n`,
        );
      },
    ));
  }
  await execFileAsync("git", ["-c", "gc.auto=0", "add", "-A"], { cwd: root });
  await execFileAsync("git", [
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "user.name=Inertia Benchmark",
    "-c",
    "user.email=benchmark@inertia.local",
    "commit",
    "-qm",
    "fixture",
  ], { cwd: root });
  await writeFile(join(root, "module-0", "file-0.ts"), "export const value0 = -1;\n");
  await writeFile(join(root, "untracked.ts"), "export const untracked = true;\n");
}

async function checkpointMeasurement(
  root: string,
  files: number,
): Promise<{ files: number; medianMs: number; samples: number[] }> {
  const repositoryPath = join(root, `repository-${files}`);
  await repository(repositoryPath, files);
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
      const small = await checkpointMeasurement(root, SMALL_REPOSITORY_FILES);
      const large = await checkpointMeasurement(root, LARGE_REPOSITORY_FILES);
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
