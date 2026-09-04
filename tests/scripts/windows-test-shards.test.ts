import { describe, expect, it } from "vitest";

import {
  createDurationAwareShards,
  discoverVitestFiles,
  loadWindowsDurationManifest,
  validateWindowsDurationManifest,
} from "../../scripts/ci/windows-test-shards.mjs";

const defaults = { perFileOverheadMs: 10, unknownTestDurationMs: 50 };

describe("duration-aware Windows test shards", () => {
  it("uses deterministic longest-processing-time partitioning", () => {
    const files = [
      "tests/d.test.ts",
      "tests/b.test.ts",
      "tests/a.test.ts",
      "tests/c.test.ts",
    ];
    const durations = {
      "tests/a.test.ts": 100,
      "tests/b.test.ts": 90,
      "tests/c.test.ts": 20,
      "tests/d.test.ts": 10,
    };
    const first = createDurationAwareShards(files, durations, 2, defaults);
    const second = createDurationAwareShards([...files].reverse(), durations, 2, defaults);
    expect(first).toEqual(second);
    expect(first.map((shard) => shard.files)).toEqual([
      ["tests/a.test.ts", "tests/d.test.ts"],
      ["tests/b.test.ts", "tests/c.test.ts"],
    ]);
  });

  it("is disjoint and exhaustive and gives unknown files a conservative weight", () => {
    const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/new.test.ts"];
    const shards = createDurationAwareShards(
      files,
      { "tests/a.test.ts": 1, "tests/b.test.ts": 2 },
      2,
      defaults,
    );
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual(files);
    expect(new Set(shards.flatMap((shard) => shard.files)).size).toBe(files.length);
    expect(shards.reduce((sum, shard) => sum + shard.unknownFiles, 0)).toBe(1);
    expect(shards.find((shard) => shard.files.includes("tests/new.test.ts"))?.weightMs)
      .toBeGreaterThanOrEqual(60);
  });

  it("rejects failed provenance, unsafe paths, and unbounded values", () => {
    const base = {
      schemaVersion: 1,
      platform: "windows-x64",
      source: {
        workflowRunId: 1,
        workflowUrl: "https://github.com/eduardtomas1/inertia/actions/runs/1",
        headSha: "a".repeat(40),
        conclusion: "success",
        jobIds: [2],
        observedShardTestDurationMs: [3],
        observedShardVitestDurationMs: [4],
      },
      defaults: { perFileOverheadMs: 1, unknownTestDurationMs: 2 },
      durationsMs: { "tests/a.test.ts": 3 },
    };
    expect(() => validateWindowsDurationManifest({
      ...base,
      source: { ...base.source, conclusion: "failure" },
    })).toThrow("successful-run provenance");
    expect(() => validateWindowsDurationManifest({
      ...base,
      durationsMs: { "../outside.test.ts": 3 },
    })).toThrow("unsafe test path");
    expect(() => validateWindowsDurationManifest({
      ...base,
      durationsMs: { "tests/a.test.ts": 15 * 60 * 1_000 + 1 },
    })).toThrow("Duration for");
    expect(() => validateWindowsDurationManifest({ ...base, surprise: true }))
      .toThrow("invalid shape");
  });

  it("keeps the checked successful-run manifest representative and balanced", async () => {
    const [files, manifest] = await Promise.all([
      discoverVitestFiles(),
      loadWindowsDurationManifest(),
    ]);
    expect(manifest.source).toMatchObject({
      workflowRunId: 33848742570,
      headSha: "68f5ea8cded5582a535e6014ae9a2ccf1d288bc7",
      conclusion: "success",
      jobIds: [100955752412, 100955788770, 100955752798, 100955753005],
    });
    expect(Object.keys(manifest.durationsMs).length).toBeGreaterThanOrEqual(590);
    const shards = createDurationAwareShards(files, manifest.durationsMs, 4, manifest.defaults);
    const allFiles = shards.flatMap((shard) => shard.files);
    expect(new Set(allFiles).size).toBe(files.length);
    expect([...allFiles].sort()).toEqual(files);
    const weights = shards.map((shard) => shard.weightMs);
    expect(Math.max(...weights) - Math.min(...weights)).toBeLessThan(10_000);
  });
});
