import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { shouldMarkStableReleaseLatest } from "../../scripts/stable-release-latest.mjs";

const release = (tag_name: string) => ({ tag_name, draft: false, prerelease: false });

it.each([
  ["v1.0.0", [], true],
  ["v1.0.10", [release("v1.0.9")], true],
  ["v1.0.9", [release("v1.0.10")], false],
  ["v1.0.10", [release("v1.0.10")], false],
  ["v2.0.0", [release("v1.99.99")], true],
  ["v9007199254740993.0.0", [release("v9007199254740992.0.0")], true],
  ["v1.0.1", [{ ...release("v2.0.0"), draft: true }], true],
  ["v1.0.1", [{ ...release("canary-v2.0.0"), prerelease: true }], true],
] as const)("chooses latest for %s according to published stable versions", (tag, releases, expected) => {
  expect(shouldMarkStableReleaseLatest(tag, releases)).toBe(expected);
});

it("does not let a late older build roll back a newer publication", () => {
  const published = [release("v0.0.55")];
  expect(shouldMarkStableReleaseLatest("v0.0.57", published)).toBe(true);
  published.push(release("v0.0.57"));
  expect(shouldMarkStableReleaseLatest("v0.0.56", published)).toBe(false);
});

it.each([null, [{ tag_name: "v1.0.0", draft: false }], [release("v01.0.0")],
  [release("v1.0.0"), release("unexpected")]])("rejects ambiguous published metadata %j", (releases) => {
  expect(() => shouldMarkStableReleaseLatest("v1.0.0", releases)).toThrow();
});

it("emits a literal boolean for the workflow and stops on malformed input", () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-stable-release-"));
  const file = join(root, "releases.json");
  const invoke = (tag: string) => spawnSync(process.execPath,
    ["scripts/stable-release-latest.mjs", tag, file], { encoding: "utf8", timeout: 5_000 });
  try {
    writeFileSync(file, JSON.stringify([release("v1.0.2")]));
    expect(invoke("v1.0.1")).toMatchObject({ status: 0, stdout: "false\n", stderr: "" });
    expect(invoke("v1.0.3")).toMatchObject({ status: 0, stdout: "true\n", stderr: "" });
    writeFileSync(file, "{");
    expect(invoke("v1.0.3")).toMatchObject({ status: 1, stdout: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("serializes publication across tags and uses the checked decision after asset verification", () => {
  const workflow = parse(readFileSync(".github/workflows/release-platforms.yml", "utf8"));
  const upload = workflow.jobs.upload;
  expect(upload.concurrency).toEqual({
    group: "release-publication-${{ startsWith(inputs.release_tag || github.ref_name, 'canary-v') && 'canary' || 'stable' }}",
    "cancel-in-progress": false,
    queue: "max",
  });
  const publish = upload.steps.find((step: { name: string }) => step.name === "Upload without replacing existing assets").run;
  const check = publish.indexOf("node scripts/stable-release-latest.mjs");
  expect(check).toBeGreaterThan(publish.indexOf("Final draft release verification failed"));
  expect(publish.slice(check)).toContain('--latest="$mark_latest"');
  expect(publish).not.toContain("--draft=false --latest\n");
});
