import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointError,
  createCheckpoint,
  restoreCheckpoint,
} from "../../src/server/checkpoints";
import { getPullRequestCreateUrl } from "../../src/server/git";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function nodeFilterCommand(path: string): string {
  const executable = process.execPath.replaceAll("\\", "/");
  const script = path.replaceAll("\\", "/");
  return `"${executable}" "${script}"`;
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

  it("does not run repository clean filters while creating an automatic checkpoint", async () => {
    const root = repository();
    const indexes = mkdtempSync(join(tmpdir(), "inertia-indexes-"));
    roots.push(indexes);
    const marker = join(root, "clean-filter-invoked");
    const filter = join(root, "hostile-clean-filter.cjs");
    writeFileSync(
      filter,
      [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(marker)}, "invoked");`,
        'process.stdin.pipe(process.stdout);',
        "",
      ].join("\n"),
    );
    if (process.platform !== "win32") chmodSync(filter, 0o755);
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=hostile\n");
    git(root, "add", ".gitattributes");
    git(root, "commit", "-m", "attributes");
    git(root, "config", "filter.hostile.clean", nodeFilterCommand(filter));
    git(root, "config", "filter.hostile.required", "true");
    writeFileSync(join(root, "tracked.txt"), "checkpoint bytes\n");

    git(root, "hash-object", "--path=tracked.txt", "tracked.txt");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const checkpoint = await createCheckpoint(
      root,
      indexes,
      randomUUID(),
    );

    expect(existsSync(marker)).toBe(false);
    expect(
      git(root, "show", `${checkpoint.ref}:tracked.txt`),
    ).toBe("checkpoint bytes");
  });

  it("does not run a repository process filter during checkpoint creation", async () => {
    const root = repository();
    const indexes = mkdtempSync(join(tmpdir(), "inertia-indexes-"));
    roots.push(indexes);
    const marker = join(root, "process-filter-invoked");
    const filter = join(root, "hostile-process-filter.cjs");
    writeFileSync(
      filter,
      [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(marker)}, "invoked");`,
        "",
      ].join("\n"),
    );
    if (process.platform !== "win32") chmodSync(filter, 0o755);
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=hostile\n");
    git(root, "add", ".gitattributes");
    git(root, "commit", "-m", "attributes");
    git(root, "config", "filter.hostile.process", nodeFilterCommand(filter));
    git(root, "config", "filter.hostile.required", "true");
    writeFileSync(join(root, "tracked.txt"), "checkpoint bytes\n");

    const checkpoint = await createCheckpoint(
      root,
      indexes,
      randomUUID(),
    );
    expect(existsSync(marker)).toBe(false);
    expect(
      git(root, "show", `${checkpoint.ref}:tracked.txt`),
    ).toBe("checkpoint bytes");
  });

  it("creates a provider-host pull request URL without network access", async () => {
    const root = repository();
    git(root, "remote", "add", "origin", "git@github.com:example/inertia.git");
    await expect(getPullRequestCreateUrl(root)).resolves.toBe("https://github.com/example/inertia/compare/main?expand=1");
  });

  it("classifies a non-repository independently of the parent locale", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-not-repository-"));
    const indexes = mkdtempSync(join(tmpdir(), "inertia-indexes-"));
    roots.push(root, indexes);
    const previousLang = process.env.LANG;
    const previousLocale = process.env.LC_ALL;
    process.env.LANG = "es_ES.UTF-8";
    process.env.LC_ALL = "es_ES.UTF-8";
    try {
      await expect(
        createCheckpoint(root, indexes, randomUUID()),
      ).rejects.toEqual(new CheckpointError("not-repository"));
    } finally {
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
    }
  });
});
