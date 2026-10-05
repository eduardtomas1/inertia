import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const gitCalls = vi.hoisted(() => [] as string[][]);
const gitOutputBytes = vi.hoisted(() => new Map<string, number>());

vi.mock("../../src/server/git/runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/git/runner")>();
  return {
    ...original,
    runGit: async (...parameters: Parameters<typeof original.runGit>) => {
      gitCalls.push([...parameters[1]]);
      const result = await original.runGit(...parameters);
      gitOutputBytes.set(parameters[1].join(" "), result.stdout.length);
      return result;
    },
  };
});

import { createCheckpoint } from "../../src/server/checkpoints";
import { assertCheckpointPreservesIgnoredFiles } from "../../src/server/git/checkpoint-ignored-paths";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function subcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-c") index += 1;
    else if (!args[index]!.startsWith("-")) return args[index];
  }
  return undefined;
}

describe("checkpoint Git invocations", () => {
  const roots: string[] = [];

  afterEach(() => {
    gitCalls.splice(0);
    gitOutputBytes.clear();
    roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true }));
  });

  function repository(): { root: string; indexes: string } {
    const root = mkdtempSync(join(tmpdir(), "inertia-checkpoint-invocations-"));
    const indexes = mkdtempSync(join(tmpdir(), "inertia-checkpoint-indexes-"));
    roots.push(root, indexes);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Inertia Test");
    git(root, "config", "user.email", "test@inertia.local");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "base");
    return { root, indexes };
  }

  it("flushes checkpoint objects and the checkpoint reference before publishing", async () => {
    const { root, indexes } = repository();
    writeFileSync(join(root, "tracked.txt"), "edit\n");
    writeFileSync(join(root, "untracked.txt"), "new\n");

    const checkpoint = await createCheckpoint(root, indexes, randomUUID());

    const writes = gitCalls.filter((args) =>
      ["add", "write-tree", "commit-tree", "update-ref"].includes(subcommand(args) ?? ""));
    expect(writes.map(subcommand)).toEqual([
      "add", "add", "write-tree", "commit-tree", "update-ref",
    ]);
    for (const args of writes) {
      expect(args).toEqual(expect.arrayContaining([
        "core.fsync=objects,reference",
        "core.fsyncMethod=batch",
      ]));
    }
    expect(git(root, "show", `${checkpoint.ref}:untracked.txt`)).toBe("new");
  });

  it("lists a wholly ignored directory once when checking a restore", async () => {
    const { root, indexes } = repository();
    const checkpoint = await createCheckpoint(root, indexes, randomUUID());
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    for (let index = 0; index < 400; index += 1) {
      mkdirSync(join(root, "node_modules", `package-${index}`), { recursive: true });
      writeFileSync(join(root, "node_modules", `package-${index}`, "index.js"), "ignored\n");
    }

    await assertCheckpointPreservesIgnoredFiles(root, checkpoint.ref, Date.now() + 30_000);

    const listing = [...gitOutputBytes].find(([command]) => command.includes("--ignored"));
    expect(listing?.[1]).toBe(Buffer.byteLength("node_modules/\0"));
  });
});
