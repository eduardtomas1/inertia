// @inertia-test-suite portable
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readOnlyCommandPathProblem } from "../../src/server/runtime/watcher/read-only-command-paths";
import { portableFixtureRoot } from "../helpers/portable-provider-fixture";

const OUTSIDE = "The command reads outside the workspace.";
const TOO_MANY = "The command names more paths than watchers can check.";
const fileLinks = process.platform !== "win32";

let root: string;
let workspace: string;

beforeAll(() => {
  root = portableFixtureRoot("read-only command paths");
  workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, "real.txt"), "inside\n");
  writeFileSync(join(workspace, "src", "parser.ts"), "export {};\n");
  writeFileSync(join(outside, "secret.txt"), "outside\n");
  symlinkSync(outside, join(workspace, "linkdir"), "junction");
  symlinkSync(workspace, join(root, "workspace-link"), "junction");
  if (fileLinks) {
    symlinkSync(join(outside, "secret.txt"), join(workspace, "link"));
    symlinkSync(join(workspace, "real.txt"), join(workspace, "src", "inner-link"));
    symlinkSync(join(workspace, "loop"), join(workspace, "loop"));
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const problem = (command: string, options: { cwd?: string; powershell?: boolean } = {}) =>
  readOnlyCommandPathProblem(command, {
    cwd: options.cwd ?? workspace,
    windows: process.platform === "win32",
    ...(options.powershell ? { powershell: true } : {}),
  });

describe("readOnlyCommandPathProblem", () => {
  it.each([
    "cat real.txt",
    "cat src/parser.ts",
    "cat missing.txt",
    "ls src",
    "rg -n parse src",
    "git log --oneline",
    "jq '.name' package.json",
    "cat ./*.txt",
    "cat src/*.ts | head -5",
    `jq '.${"a".repeat(400)}' real.txt`,
  ])("allows %s, which stays inside the workspace", async (command) => {
    await expect(problem(command)).resolves.toBeNull();
  });

  it.each([
    "ls linkdir",
    "cat linkdir/secret.txt",
    "cat ./linkdir/*.txt",
    "cat ./lin*/secret.txt",
    "git -C linkdir log",
    "cat real.txt | cat linkdir/secret.txt",
    "rg parse --ignore-file=linkdir/secret.txt",
  ])("refuses %s, which follows a linked directory out of the workspace", async (command) => {
    await expect(problem(command)).resolves.toBe(OUTSIDE);
  });

  it.skipIf(!fileLinks).each([
    "cat link",
    "cat ./l*",
    "cat ./*",
    "grep -nflink real.txt",
    "head -5 src/../link",
    "cat loop",
  ])("refuses %s, which reaches a file linked from outside the workspace", async (command) => {
    await expect(problem(command)).resolves.toBe(OUTSIDE);
  });

  it.skipIf(!fileLinks)("allows a link that stays inside the workspace", async () => {
    await expect(problem("cat src/inner-link")).resolves.toBeNull();
  });

  it("compares against the workspace's real path when the workspace itself is reached through a link", async () => {
    const cwd = join(root, "workspace-link");
    await expect(problem("cat real.txt", { cwd })).resolves.toBeNull();
    await expect(problem(`cat ${join(cwd, "src", "parser.ts").replaceAll("\\", "/")}`, { cwd })).resolves.toBeNull();
    await expect(problem("cat linkdir/secret.txt", { cwd })).resolves.toBe(OUTSIDE);
  });

  it.skipIf(!fileLinks)("treats quoted wildcards as patterns where the shell may be PowerShell", async () => {
    await expect(problem("cat 'l*'")).resolves.toBeNull();
    await expect(problem("cat 'l*'", { powershell: true })).resolves.toBe(OUTSIDE);
  });

  it("checks Windows paths by the Windows rules", async () => {
    const real = new Map([
      ["C:\\work\\repo", "C:\\work\\repo"],
      ["C:\\work\\repo\\src\\parser.ts", "c:\\WORK\\Repo\\src\\parser.ts"],
      ["C:\\work\\repo\\link", "D:\\secret.txt"],
      ["C:\\work\\repo\\src", "C:\\work\\repo\\src"],
    ]);
    const files = {
      realpath: async (path: string) => {
        const resolved = real.get(path);
        if (resolved === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return resolved;
      },
      readdir: async (path: string) => {
        if (path === "C:\\work\\repo") return ["link", "src"];
        if (path === "C:\\work\\repo\\src") return ["parser.ts"];
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    };
    const windows = (command: string) =>
      readOnlyCommandPathProblem(command, { cwd: "C:\\work\\repo", windows: true }, files);
    await expect(windows("cat src/parser.ts")).resolves.toBeNull();
    await expect(windows("cat C:/work/repo/src/parser.ts")).resolves.toBeNull();
    await expect(windows("cat missing.txt")).resolves.toBeNull();
    await expect(windows("cat src/*.ts")).resolves.toBeNull();
    await expect(windows("cat link")).resolves.toBe(OUTSIDE);
    await expect(windows("cat ./l*")).resolves.toBe(OUTSIDE);
  });

  it("refuses a command whose wildcards reach more paths than it can check", async () => {
    const real = async (path: string) => path;
    const names = Array.from({ length: 5_000 }, (_, index) => `file-${index}.txt`);
    const files = { realpath: real, readdir: async () => names };
    await expect(readOnlyCommandPathProblem("cat ./*.txt", { cwd: "/work/repo", windows: false }, files)).resolves.toBe(TOO_MANY);
    await expect(readOnlyCommandPathProblem("cat ./file-1.txt", { cwd: "/work/repo", windows: false }, files)).resolves.toBeNull();
  });
});
