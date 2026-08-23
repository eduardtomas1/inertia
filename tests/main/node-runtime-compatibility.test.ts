import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

async function source(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

describe("minimum Node runtime compatibility", () => {
  it("pins declarations to the supported Node 22.13 API line", async () => {
    const packageJson = JSON.parse(await source("package.json")) as {
      engines: { node: string };
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.engines.node).toBe(">=22.13 <23");
    expect(packageJson.devDependencies["@types/node"]).toMatch(/^22\.13\.\d+$/u);
    expect(packageJson.scripts["check:node-runtime"]).toContain(
      "node scripts/check-node-runtime-compatibility.mjs",
    );
  });

  it("installs, compiles, and executes the real CLI on exact Node 22.13", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    const start = workflow.indexOf("  node-22-minimum:");
    const end = workflow.indexOf("\n  test:", start);
    const job = workflow.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(job).toContain("node-version: 22.13.0");
    expect(job).toContain("run: npm ci --engine-strict");
    expect(job).toContain("run: npm run check:node-runtime");

    const compatibilityCheck = await source(
      "scripts/check-node-runtime-compatibility.mjs",
    );
    expect(compatibilityCheck).toContain(
      "spawnSync(process.execPath, [runtimeStatusCli, ...arguments_]",
    );
    expect(compatibilityCheck).toContain('const readiness = run(["--cwd", projectRoot])');
    expect(compatibilityCheck).toContain("timeout: 30_000");
    expect(compatibilityCheck).toContain("maxBuffer: 4 * 1024 * 1024");
  });
});
