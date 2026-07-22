import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCheckpoint, restoreCheckpoint } from "../../src/server/checkpoints";
import { getPullRequestCreateUrl } from "../../src/server/git";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("Git checkpoints", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), "inertia-checkpoint-"));
    roots.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "core.autocrlf", "false");
    git(root, "config", "user.name", "Inertia Test");
    git(root, "config", "user.email", "test@inertia.local");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "base");
    return root;
  }

  it("restores tracked and checkpointed files while preserving later untracked files", async () => {
    const root = repository();
    const indexes = mkdtempSync(join(tmpdir(), "inertia-indexes-"));
    roots.push(indexes);
    writeFileSync(join(root, "tracked.txt"), "before agent\n");
    writeFileSync(join(root, "existing-untracked.txt"), "included\n");
    const conversationId = randomUUID();
    const checkpoint = await createCheckpoint(root, indexes, conversationId);

    writeFileSync(join(root, "tracked.txt"), "after agent\n");
    writeFileSync(join(root, "existing-untracked.txt"), "changed\n");
    writeFileSync(join(root, "later-untracked.txt"), "keep me\n");
    await restoreCheckpoint(root, checkpoint.ref, conversationId);

    expect(readFileSync(join(root, "tracked.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("before agent\n");
    expect(readFileSync(join(root, "existing-untracked.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("included\n");
    expect(readFileSync(join(root, "later-untracked.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("keep me\n");
  });

  it("creates a provider-host pull request URL without network access", async () => {
    const root = repository();
    git(root, "remote", "add", "origin", "git@github.com:example/inertia.git");
    await expect(getPullRequestCreateUrl(root)).resolves.toBe("https://github.com/example/inertia/compare/main?expand=1");
  });
});
