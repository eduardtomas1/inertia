import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  compareCanaryVersions,
  parseCanaryFeedStatus,
  validateCanaryFeedAdvance,
} from "../../scripts/validate-canary-feed-advance.mjs";

const roots: string[] = [];
const version = "0.0.47";
const metadata = [
  `version: ${version}`,
  "files:",
  `  - url: Inertia-Canary-${version}.AppImage`,
  `    sha512: ${Buffer.alloc(64).toString("base64")}`,
  "    size: 100",
  `path: Inertia-Canary-${version}.AppImage`,
  `sha512: ${Buffer.alloc(64).toString("base64")}`,
  "releaseDate: 2030-01-01T00:00:00.000Z",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("Canary feed publication", () => {
  it("rewrites only package URLs to exact immutable prerelease assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-canary-feed-"));
    roots.push(root);
    const assets = join(root, "assets");
    const feed = join(root, "feed");
    await mkdir(assets);
    for (const name of [
      "canary-mac.yml",
      "canary.yml",
      "canary-linux.yml",
      "canary-linux-arm64.yml",
    ]) {
      await writeFile(join(assets, name), metadata);
    }
    const result = spawnSync(process.execPath, ["scripts/prepare-canary-feed.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_TAG: `canary-v${version}`,
        INERTIA_CANARY_ASSET_DIR: assets,
        INERTIA_CANARY_FEED_DIR: feed,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const parsed = parse(await readFile(join(feed, "canary-linux.yml"), "utf8")) as {
      files: Array<{ url: string }>;
      path: string;
    };
    expect(parsed.files[0]?.url).toBe(
      `https://github.com/eduardtomas1/inertia/releases/download/canary-v${version}/Inertia-Canary-${version}.AppImage`,
    );
    expect(parsed.path).toBe(`Inertia-Canary-${version}.AppImage`);
    expect(JSON.parse(await readFile(join(feed, "canary-status.json"), "utf8")))
      .toEqual({ version, tag: `canary-v${version}` });
  });

  it("allows manual desktop platforms to omit metadata while requiring both Linux architectures", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-canary-manual-feed-"));
    roots.push(root);
    const assets = join(root, "assets");
    const feed = join(root, "feed");
    await mkdir(assets);
    await writeFile(join(assets, "canary-linux.yml"), metadata);
    await writeFile(join(assets, "canary-linux-arm64.yml"), metadata);
    const run = (source: string, output: string) => spawnSync(
      process.execPath,
      ["scripts/prepare-canary-feed.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          RELEASE_TAG: `canary-v${version}`,
          INERTIA_CANARY_ASSET_DIR: source,
          INERTIA_CANARY_FEED_DIR: output,
        },
      },
    );

    const manualResult = run(assets, feed);
    expect(manualResult.status, manualResult.stderr).toBe(0);
    expect((await readdir(feed)).sort())
      .toEqual([
        "canary-linux-arm64.yml",
        "canary-linux.yml",
        "canary-status.json",
      ]);

    const invalidAssets = join(root, "invalid-assets");
    await mkdir(invalidAssets);
    await writeFile(join(invalidAssets, "canary-mac.yml"), metadata);
    const missingLinux = run(invalidAssets, join(root, "invalid-feed"));
    expect(missingLinux.status).toBe(1);
    expect(missingLinux.stderr).toContain("requires both Linux architecture metadata files");
  });

  it("keeps the highest version when release jobs finish out of order", () => {
    const status = (candidateVersion: string): string => JSON.stringify({
      version: candidateVersion,
      tag: `canary-v${candidateVersion}`,
    });
    const initiallyPublished = status("0.0.46");
    const newerWinner = status("0.0.48");
    const olderLateJob = status("0.0.47");

    expect(validateCanaryFeedAdvance(initiallyPublished, newerWinner))
      .toEqual({ version: "0.0.48", tag: "canary-v0.0.48" });
    expect(validateCanaryFeedAdvance(newerWinner, olderLateJob)).toBeNull();
    expect(validateCanaryFeedAdvance(newerWinner, newerWinner)).toBeNull();
    expect(compareCanaryVersions("10.0.0", "9.999.999")).toBe(1);
  });

  it("fails closed on malformed published or candidate feed status", () => {
    const valid = JSON.stringify({ version, tag: `canary-v${version}` });
    expect(() => validateCanaryFeedAdvance("{}", valid))
      .toThrow("Published Canary feed status");
    expect(() => parseCanaryFeedStatus(
      JSON.stringify({ version, tag: "canary-v0.0.40" }),
      "Fixture",
    )).toThrow("Fixture");
  });

  it("uses a compare-and-swap retry before every feed push", async () => {
    const workflow = await readFile(".github/workflows/release-platforms.yml", "utf8");
    expect(workflow).toContain("for attempt in 1 2 3 4 5");
    expect(workflow).toContain("validate-canary-feed-advance.mjs");
    expect(workflow).toContain("git -C \"$feed_worktree\" fetch --force --depth=1 origin canary-feed");
    expect(workflow).toContain("Canary feed head advanced concurrently; retrying");
    expect(workflow).not.toContain("git -C \"$feed_worktree\" push --force");
  });
});
