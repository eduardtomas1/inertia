import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, describe, expect, it } from "vitest";

import { prepareGitExecutable, runGitInspection } from "../../src/server/git/runner";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";

const SAMPLES = Number.parseInt(process.env.INERTIA_GIT_SPAWN_SAMPLES ?? "30", 10);
const guardianPath = resolve("resources/generated/runtime-process-guardian/runtime-process-guardian");
const roots: string[] = [];

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
  return {
    n: sorted.length,
    median: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    min: Number(sorted[0]!.toFixed(1)),
    max: Number(sorted[sorted.length - 1]!.toFixed(1)),
  };
}

async function sample(repository: string): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    await runGitInspection(repository, ["rev-parse", "--show-toplevel"], {
      failureMessage: "The benchmark repository could not be inspected.",
    });
    values.push(performance.now() - started);
  }
  return values;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "darwin" || process.platform === "linux")("runtime-owned Git spawn cost", () => {
  it("measures one Git inspection with and without the runtime process guardian", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-git-spawn-"));
    roots.push(root);
    const repository = join(root, "repository");
    const runtimeDirectory = join(root, "runtime");
    mkdirSync(repository);
    mkdirSync(runtimeDirectory, { mode: 0o700 });
    writeFileSync(join(repository, "README.md"), "fixture\n");
    execFileSync("git", ["init", "-q"], { cwd: repository });
    await prepareGitExecutable();
    await sample(repository);
    const plain = await sample(repository);
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      runtimeDirectory,
      `${randomUUID()}:1`,
      `test:${randomUUID()}`,
      { platform: process.platform, darwinGuardianPath: guardianPath },
    );
    let owned: number[];
    try {
      owned = await sample(repository);
    } finally {
      deactivate?.();
    }
    const report = {
      platform: process.platform,
      arch: process.arch,
      samples: SAMPLES,
      plainMs: distribution(plain),
      guardianOwnedMs: distribution(owned),
      rawPlainMs: plain.map((value) => Number(value.toFixed(1))),
      rawGuardianOwnedMs: owned.map((value) => Number(value.toFixed(1))),
    };
    const output = resolve(process.env.INERTIA_GIT_SPAWN_REPORT ?? "performance-results/git-spawn.json");
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ plainMs: report.plainMs, guardianOwnedMs: report.guardianOwnedMs }));
    expect(owned).toHaveLength(SAMPLES);
  });
});
