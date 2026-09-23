import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getUnifiedDiff, inspectDiffSelection, revertDiffSelection, undoDiffSelection } from "../../src/server/git";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const observation = vi.hoisted(() => ({ afterDiff: undefined as (() => void) | undefined }));
vi.mock("../../src/server/git/diff", async original => {
  const actual = await original<typeof import("../../src/server/git/diff")>();
  return { ...actual, getUnifiedDiff: async (...args: Parameters<typeof actual.getUnifiedDiff>) => {
    const result = await actual.getUnifiedDiff(...args);
    const after = observation.afterDiff;
    observation.afterDiff = undefined;
    after?.();
    return result;
  } };
});

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

async function fixture(options: { scoped?: boolean; ignoreWhitespace?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "inertia-reversal-capture-"));
  roots.push(root);
  const workspace = join(root, "app");
  mkdirSync(workspace);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Inertia Test");
  git(root, "config", "user.email", "test@inertia.invalid");
  const before = "first\nbefore\n";
  const changed = options.ignoreWhitespace ? "first  \nchanged\n" : "first\nchanged\n";
  writeFileSync(join(workspace, "selected.txt"), before);
  writeFileSync(join(root, "parent.txt"), "parent before\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  writeFileSync(join(workspace, "selected.txt"), changed);
  writeFileSync(join(root, "parent.txt"), "parent changed\n");
  git(root, "add", "app/selected.txt");
  const diff = parseUnifiedDiff((await getUnifiedDiff(root, {
    paths: options.scoped ? ["app/selected.txt"] : undefined,
    ignoreWhitespace: options.ignoreWhitespace,
  })).text);
  const hunk = diff.files.find(file => file.path === "app/selected.txt")!.hunks[0]!;
  const selection = { fingerprint: diff.fingerprint, filePath: "app/selected.txt", hunkId: hunk.id,
    lineIds: hunk.lines.filter(line => line.kind === "addition" || line.kind === "deletion").map(line => line.id),
    ignoreWhitespace: options.ignoreWhitespace };
  const broker = new SecureFileTestBroker();
  const repository = await broker.authorizeRoot(root);
  const workspaceRoot = await broker.authorizeRoot(workspace);
  const scope = { root: workspaceRoot, verifyContext: () => broker.verifyRoot(workspaceRoot) };
  return { root, workspace, broker, repository, scope, selection, before, changed };
}

afterEach(() => {
  observation.afterDiff = undefined;
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe("selective reversal captured-state freshness", () => {
  it("rejects a later change to another file even when the selected lines remain identical", async () => {
    const f = await fixture();
    const read = f.broker.read.bind(f.broker);
    let changed = false;
    vi.spyOn(f.broker, "read").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (!changed && args[0].root === f.scope.root.root && args[1] === "selected.txt") {
        changed = true;
        writeFileSync(join(f.root, "parent.txt"), "concurrent parent change\n");
      }
      return result;
    });
    await expect(inspectDiffSelection(f.root, f.selection, f.broker, f.repository, f.scope))
      .rejects.toThrow("The repository changed while the reversal was being inspected");
    expect(changed).toBe(true);
    expect(readFileSync(join(f.workspace, "selected.txt"), "utf8")).toBe(f.changed);
    expect(git(f.root, "show", ":app/selected.txt")).toBe(f.changed);
    expect(readFileSync(join(f.root, "parent.txt"), "utf8")).toBe("concurrent parent change\n");
  });

  it.each(["repository", "workspace"] as const)("rejects a replaced %s after capturing its complete diff", async kind => {
    const f = await fixture();
    const target = kind === "repository" ? f.root : f.workspace;
    const retained = `${target}-retained`;
    roots.push(retained);
    let captured = false, replaced = false;
    observation.afterDiff = () => { captured = true; };
    const verifyRoot = f.broker.verifyRoot.bind(f.broker);
    vi.spyOn(f.broker, "verifyRoot").mockImplementation(async (...args) => {
      // The next verification follows the joined capture reads, so no Git
      // child can still hold the directory being replaced on Windows.
      if (captured && !replaced) {
        replaced = true;
        renameSync(target, retained);
        mkdirSync(target);
        writeFileSync(join(target, "replacement.txt"), "replacement must survive\n");
      }
      return verifyRoot(...args);
    });
    await expect(inspectDiffSelection(f.root, f.selection, f.broker, f.repository, f.scope))
      .rejects.toMatchObject({ code: "unsafe" });
    expect(replaced).toBe(true);
    expect(readFileSync(join(target, "replacement.txt"), "utf8")).toBe("replacement must survive\n");
    const retainedWorkspace = kind === "repository" ? join(retained, "app") : retained;
    expect(readFileSync(join(retainedWorkspace, "selected.txt"), "utf8")).toBe(f.changed);
    expect(git(kind === "repository" ? retained : f.root, "show", ":app/selected.txt")).toBe(f.changed);
  });

  it.each([
    { scoped: true, ignoreWhitespace: false },
    { scoped: false, ignoreWhitespace: true },
  ])("retains fresh diff selection for scoped=$scoped and whitespace=$ignoreWhitespace", async options => {
    const f = await fixture(options);
    const plan = await inspectDiffSelection(f.root, f.selection, f.broker, f.repository, f.scope);
    const reversed = await revertDiffSelection(f.root, { ...f.selection, expected: plan.validation },
      f.broker, undefined, f.repository, f.scope);
    const expected = options.ignoreWhitespace ? "first  \nbefore\n" : f.before;
    expect(readFileSync(join(f.workspace, "selected.txt"), "utf8")).toBe(expected);
    expect(git(f.root, "show", ":app/selected.txt")).toBe(expected);
    await undoDiffSelection(f.root, reversed.operation.id, f.broker, f.repository, f.scope);
    expect(readFileSync(join(f.workspace, "selected.txt"), "utf8")).toBe(f.changed);
    expect(git(f.root, "show", ":app/selected.txt")).toBe(f.changed);
    expect(readFileSync(join(f.root, "parent.txt"), "utf8")).toBe("parent changed\n");
  });
});
