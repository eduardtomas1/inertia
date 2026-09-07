import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseLineage,
  validateLineageExtension,
} from "../../scripts/verify-database-lineage.mjs";

const entry = (version: number, name: string, digest = "a".repeat(64)) => ({
  version,
  name,
  digest,
});

describe("database lineage merge-base gate", () => {
  it("uses the trusted accumulated comparison, or verifies complete manifest history", () => {
    const workflow = readFileSync(
      ".github/workflows/database-migration-lineage.yml",
      "utf8",
    );
    expect(workflow).toContain("COMPARISON_BASE: ${{ inputs.comparison-base }}");
    expect(workflow).toContain('git merge-base --is-ancestor "$COMPARISON_BASE" HEAD');
    expect(workflow).toContain('comparison="$COMPARISON_BASE"');
    expect(workflow).toContain('node scripts/verify-database-lineage.mjs --base-ref "$COMPARISON_BASE"');
    expect(workflow).toContain("node scripts/verify-database-lineage.mjs --all-history");
    expect(workflow).not.toContain("github.event.before");
    expect(workflow).not.toContain("--max-parents=0");
    expect(workflow).not.toContain("git rev-parse HEAD^");
  });

  it("rejects an unproven predecessor's migration tamper after a docs-only push, even when root predates lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-lineage-history-"));
    const script = resolve("scripts/verify-database-lineage.mjs");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const verify = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
      cwd: root, encoding: "utf8", timeout: 15_000,
    });
    const writeManifest = (migrations: ReturnType<typeof entry>[], format = 2) => writeFile(
      join(root, "database-migration-lineage.json"), JSON.stringify({ format, migrations }),
    );
    try {
      git("init", "--quiet");
      git("config", "user.name", "Lineage fixture");
      git("config", "user.email", "lineage@example.invalid");
      await writeFile(join(root, "README.md"), "before the lineage manifest\n");
      git("add", "."); git("commit", "--quiet", "-m", "repository root");
      const beforeManifest = git("rev-parse", "HEAD");
      await writeManifest([entry(1, "One")]);
      git("add", "."); git("commit", "--quiet", "-m", "released lineage");
      await writeManifest([entry(1, "One"), entry(2, "Two")]);
      git("commit", "--quiet", "-am", "append migration");
      expect(verify("--all-history").status).toBe(0);

      await writeManifest([entry(1, "One", "b".repeat(64)), entry(2, "Two")]);
      git("commit", "--quiet", "-am", "unproven predecessor tampers migration");
      const unproven = git("rev-parse", "HEAD");
      await writeFile(join(root, "README.md"), "latest push only changes documentation\n");
      git("commit", "--quiet", "-am", "latest docs push");
      // Both tempting fallback comparisons miss the older released digest.
      expect(verify("--base-ref", beforeManifest).status).toBe(0);
      expect(verify("--base-ref", unproven).status).toBe(0);
      const rejected = verify("--all-history");
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("was edited, removed, or reordered");

      await writeManifest([entry(1, "One")], 3);
      git("commit", "--quiet", "-am", "unknown historical format");
      await writeManifest([entry(1, "One"), entry(2, "Two")]);
      const unknownHistory = verify("--all-history");
      expect(unknownHistory.status).toBe(1);
      expect(unknownHistory.stderr).toContain("has an invalid shape");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts append-only lineage", () => {
    const base = { format: 2 as const, migrations: [entry(1, "One")] };
    const current = { format: 2 as const, migrations: [entry(1, "One"), entry(2, "Two")] };
    expect(() => validateLineageExtension(base, current)).not.toThrow();
  });

  it.each([
    ["edited", [entry(1, "One", "b".repeat(64)), entry(2, "Two")]],
    ["removed", []],
    ["reordered", [entry(1, "Two"), entry(2, "One")]],
  ])("rejects %s released migrations", (_label, migrations) => {
    const base = { format: 2 as const, migrations: [entry(1, "One"), entry(2, "Two")] };
    expect(() => validateLineageExtension(base, { format: 2 as const, migrations }))
      .toThrow(/edited, removed, or reordered|were removed/u);
  });

  it("rejects edits to a released migration's helper implementation lineage", () => {
    const released = {
      ...entry(1, "One"),
      sources: [{
        path: "src/server/persistence/migrations/helper.ts",
        symbols: ["migrationHelper"],
        digest: "b".repeat(64),
      }],
    };
    const base = { format: 2 as const, migrations: [released] };
    const current = {
      format: 2 as const,
      migrations: [{
        ...released,
        sources: [{ ...released.sources[0]!, digest: "c".repeat(64) }],
      }],
    };
    expect(() => validateLineageExtension(base, current))
      .toThrow(/edited, removed, or reordered/u);
  });

  it("rejects malformed or non-contiguous manifests", () => {
    expect(() => parseLineage(JSON.stringify({
      format: 2,
      migrations: [entry(2, "Two")],
    }), "Fixture")).toThrow("version 1");
  });
});
