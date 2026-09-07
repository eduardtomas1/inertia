import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { comparisonPaths, selectMainBaseline, verificationContractAt } from "../../scripts/ci/validation-baseline.mjs";
import { classifyChangedPaths } from "../../scripts/ci/change-classifier.mjs";

const head = "a".repeat(40);
const older = "b".repeat(40);
const unproven = "c".repeat(40);
const repository = "test/ci";
const good = {
  id: 10, workflow_id: 2, path: ".github/workflows/ci.yml",
  repository: { full_name: repository }, head_repository: { full_name: repository },
  event: "push", head_branch: "main", status: "completed", conclusion: "success", head_sha: older,
};
function choose(runs: object[], options = {}) {
  return selectMainBaseline({
    runs, head, repository, workflowId: 2, currentRunId: 20,
    contractAt: () => "same-contract", isAncestor: () => true,
    hasSuccessfulGate: async () => true, ...options,
  });
}

it("retains the accumulated diff after failed and cancelled predecessors", async () => {
  const result = await choose([
    { ...good, id: 12, head_sha: unproven, conclusion: "cancelled" },
    { ...good, id: 11, head_sha: unproven, conclusion: "failure" },
    good,
  ]);
  expect(result).toEqual({ base: older, reason: "trusted-main-run:10" });
});

it.each([
  { conclusion: "failure" }, { conclusion: "cancelled" }, { status: "in_progress" },
  { event: "pull_request" }, { head_branch: "feature" }, { workflow_id: 3 },
  { path: ".github/workflows/other.yml" }, { repository: { full_name: "foreign/repo" } },
  { head_repository: { full_name: "foreign/repo" } }, { id: 20 }, { head_sha: "HEAD" },
])("rejects untrusted or unsuccessful baseline metadata %j", async (override) => {
  expect((await choose([{ ...good, ...override }])).base).toBeNull();
});

it("requires ancestry, compatible verifier, explicit aggregate and an available baseline", async () => {
  for (const options of [
    { isAncestor: () => false },
    { contractAt: (sha: string) => sha },
    { contractAt: () => null },
    { hasSuccessfulGate: async () => false },
  ]) expect((await choose([good], options)).base).toBeNull();
  expect((await choose([])).base).toBeNull();
});

it("reads accumulated real Git paths, preserves rename/deletion impact and detects contract replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "inertia-ci-baseline-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    await mkdir(join(root, "src/renderer"), { recursive: true });
    await mkdir(join(root, "tests"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "tests/contract.test.ts"), "initial verifier\n");
    await writeFile(join(root, "src/renderer/view.ts"), "original source\n");
    git("add", "."); git("commit", "--quiet", "-m", "trusted baseline");
    const baseline = git("rev-parse", "HEAD");
    await writeFile(join(root, "src/renderer/view.ts"), "unproven source\n");
    git("commit", "--quiet", "-am", "cancelled predecessor");
    await writeFile(join(root, "docs/note.md"), "latest docs\n");
    git("add", "."); git("commit", "--quiet", "-m", "latest push");
    const current = git("rev-parse", "HEAD");
    expect(comparisonPaths(baseline, current, root)).toEqual(["docs/note.md", "src/renderer/view.ts"]);
    expect(verificationContractAt(baseline, root)).toBe(verificationContractAt(current, root));
    git("mv", "tests/contract.test.ts", "docs/contract.md");
    git("commit", "--quiet", "-m", "move verifier into docs");
    const renamed = git("rev-parse", "HEAD");
    const paths = comparisonPaths(current, renamed, root)!;
    expect(paths).toEqual(["docs/contract.md", "tests/contract.test.ts"]);
    expect(classifyChangedPaths(paths).allEvidence).toBe(true);
    expect(verificationContractAt(renamed, root)).not.toBe(verificationContractAt(current, root));
    expect(comparisonPaths("missing", current, root)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
