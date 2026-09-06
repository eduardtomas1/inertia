import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import benchmarkConfig from "../../playwright.benchmark.config";

const require = createRequire(import.meta.url);
const runnerUrl = pathToFileURL(resolve("scripts/bounded-process-tree.mjs")).href;

test("keeps earlier lifecycle and E2E evidence when Playwright clears benchmark output", async () => {
  const { runBounded } = await import(runnerUrl) as {
    runBounded: (command: string, args: string[], options: {
      cwd: string; label: string; timeoutMs: number; maxOutputBytes: number;
    }) => Promise<string>;
  };
  const root = await mkdtemp(join(tmpdir(), "inertia benchmark output Ω-"));
  const output = resolve(root, benchmarkConfig.outputDir ?? "test-results");
  const containedOutput = relative(root, output);
  expect(containedOutput && !isAbsolute(containedOutput)
    && containedOutput !== ".." && !containedOutput.startsWith(`..${sep}`)).toBe(true);
  const lifecycle = join(root, "test-results", "nightly-lifecycle", "attempt.log");
  const e2e = join(root, "test-results", "display-sensitive", "evidence.txt");
  try {
    await Promise.all([
      mkdir(join(root, "test-results", "nightly-lifecycle"), { recursive: true }),
      mkdir(join(root, "test-results", "display-sensitive"), { recursive: true }),
      mkdir(output, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(lifecycle, "retained lifecycle failure\n"),
      writeFile(e2e, "retained E2E failure\n"),
      writeFile(join(output, "stale.txt"), "previous benchmark run\n"),
      writeFile(join(root, "package.json"), '{"name":"benchmark-output-proof","private":true}'),
      writeFile(join(root, "playwright.config.cjs"), `module.exports = ${JSON.stringify({
        ...benchmarkConfig,
        testDir: ".",
        testMatch: "proof.spec.cjs",
      })};\n`),
      writeFile(join(root, "proof.spec.cjs"), `
const { test, expect } = require(${JSON.stringify(require.resolve("@playwright/test"))});
test("bounded output cleanup proof", () => expect(true).toBe(true));
`),
    ]);
    await runBounded(process.execPath, [
      require.resolve("@playwright/test/cli"),
      "test", "--config", join(root, "playwright.config.cjs"),
    ], { cwd: root, label: "Benchmark output cleanup proof", timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024 });
    await expect(readFile(join(output, "stale.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(lifecycle, "utf8")).resolves.toBe("retained lifecycle failure\n");
    await expect(readFile(e2e, "utf8")).resolves.toBe("retained E2E failure\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
