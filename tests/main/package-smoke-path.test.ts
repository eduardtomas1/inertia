import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it } from "vitest";

const moduleUrl = pathToFileURL(resolve("scripts/package-smoke-path.mjs")).href;
const roots: string[] = [];
async function smokePathModule() {
  return await import(moduleUrl) as {
    packageSmokePath: (directory: string, options?: {
      environment?: NodeJS.ProcessEnv; includeGit?: boolean;
    }) => Promise<string>;
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("preserves only the synthetic provider and real Git directory for installed history", async () => {
  const { packageSmokePath } = await smokePathModule();
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-smoke-path-")));
  roots.push(root);
  const fixture = join(root, "codex fixture");
  const unrelated = join(root, "unrelated provider");
  const git = join(root, "Git Ω (installation)");
  await Promise.all([fixture, unrelated, git].map((directory) => mkdir(directory)));
  const executable = process.platform === "win32" ? "git.exe" : "git";
  // An existing directory named git is not an executable installation.
  await mkdir(join(unrelated, executable));
  await writeFile(join(git, executable), "fixture executable", { mode: 0o700 });
  const quotedGit = process.platform === "win32" ? `"${git}"` : git;
  const inherited = ["", "relative-provider", unrelated, quotedGit, fixture].join(delimiter);
  expect(await packageSmokePath(fixture, {
    environment: { Path: inherited }, includeGit: true,
  })).toBe([fixture, git].join(delimiter));
});

it("keeps ordinary package smoke independent of the host Git installation", async () => {
  const { packageSmokePath } = await smokePathModule();
  expect(await packageSmokePath("fixture", { environment: {} })).toBe("fixture");
  expect(await packageSmokePath("fixture", {
    environment: { PATH: "\0" }, includeGit: false,
  })).toBe("fixture");
  await expect(packageSmokePath("fixture", { environment: {}, includeGit: true }))
    .rejects.toThrow("requires Git on the host PATH");
});

it("bounds inherited Git lookup and follows Node's Windows PATH alias precedence", async () => {
  const { packageSmokePath } = await smokePathModule();
  for (const value of ["x".repeat(32_768), "bad\0path", delimiter.repeat(256)]) {
    await expect(packageSmokePath("fixture", {
      environment: { PATH: value }, includeGit: true,
    })).rejects.toThrow(/bounded host Git PATH|too many host Git PATH entries/u);
  }
  await expect(packageSmokePath("fixture", {
    environment: { PATH: "", Path: process.env.PATH }, includeGit: true,
  })).rejects.toThrow("requires Git on the host PATH");
});
