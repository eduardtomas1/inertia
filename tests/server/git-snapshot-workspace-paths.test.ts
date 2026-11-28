import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCheckpoint } from "../../src/server/checkpoints";
import { compareGitSnapshots } from "../../src/server/git";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("historical comparisons in a subdirectory project", { timeout: 30_000 }, () => {
  it("validates selected paths against the project workspace the checkpoint trees are rooted at", async () => {
    const parent = mkdtempSync(join(tmpdir(), "inertia-snapshot-workspace-"));
    roots.push(parent);
    const root = join(parent, "repo");
    const outside = join(parent, "outside");
    const app = join(root, "packages", "app");
    mkdirSync(join(app, "docs"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "notes.md"), "outside\n");
    symlinkSync(outside, join(root, "docs"), process.platform === "win32" ? "junction" : "dir");
    git(root, "init", "-q", "--initial-branch=main");
    git(root, "config", "core.autocrlf", "false");
    git(root, "config", "user.email", "tests@inertia.invalid");
    git(root, "config", "user.name", "Inertia Tests");
    writeFileSync(join(app, "docs", "notes.md"), "one\n");
    git(root, "add", "--", "packages");
    git(root, "commit", "-q", "-m", "Initial");

    const conversationId = randomUUID();
    const storage = join(parent, "indexes");
    const before = await createCheckpoint(app, storage, conversationId, { phase: "other" });
    writeFileSync(join(app, "docs", "notes.md"), "one\ntwo\n");
    const after = await createCheckpoint(app, storage, conversationId, { phase: "other" });

    const comparison = await compareGitSnapshots(app, before.ref, after.ref, { paths: ["docs/notes.md"] });
    expect(comparison.files.map(({ path }) => path)).toEqual(["docs/notes.md"]);
  });
});
