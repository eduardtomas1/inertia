import { readFileSync } from "node:fs";
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
  it("compares every commit in a pushed range from the event's prior SHA", () => {
    const workflow = readFileSync(
      ".github/workflows/database-migration-lineage.yml",
      "utf8",
    );
    expect(workflow).toContain("BEFORE_SHA: ${{ github.event.before }}");
    expect(workflow).toContain('comparison="$BEFORE_SHA"');
    expect(workflow).not.toContain("git rev-parse HEAD^");
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
