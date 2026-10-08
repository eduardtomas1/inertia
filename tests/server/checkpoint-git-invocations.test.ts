import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const gitCalls = vi.hoisted(() => [] as string[][]);
const gitOutputBytes = vi.hoisted(() => new Map<string, number>());
const gitEvents = vi.hoisted(() => [] as string[]);
const gitGate = vi.hoisted(() => ({
  hold: null as null | ((args: readonly string[]) => Promise<void> | null),
}));

vi.mock("../../src/server/git/runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/git/runner")>();
  return {
    ...original,
    runGit: async (...parameters: Parameters<typeof original.runGit>) => {
      gitCalls.push([...parameters[1]]);
      gitEvents.push(`start:${parameters[1].filter((arg) => !arg.startsWith("-") && !arg.includes("=")).join(" ")}`);
      const result = await original.runGit(...parameters);
      gitOutputBytes.set(parameters[1].join(" "), result.stdout.length);
      return result;
    },
    runGitInspection: async (...parameters: Parameters<typeof original.runGitInspection>) => {
      gitCalls.push([...parameters[1]]);
      gitEvents.push(`start:${parameters[1].join(" ")}`);
      await gitGate.hold?.(parameters[1]);
      const result = await original.runGitInspection(...parameters);
      gitEvents.push(`end:${parameters[1].join(" ")}`);
      return result;
    },
  };
});

import { createCheckpoint } from "../../src/server/checkpoints";
import { RuntimeStore } from "../../src/server/database";
import { assertCheckpointPreservesIgnoredFiles } from "../../src/server/git/checkpoint-ignored-paths";
import { GitError } from "../../src/server/git/types";
import { TurnGitArtifactManager } from "../../src/server/turn-git-artifacts";

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
    gitGate.hold = null;
    gitEvents.splice(0);
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

  function turnInRepository(root: string, indexes: string) {
    const store = new RuntimeStore(join(indexes, "inertia.sqlite"), root);
    const project = store.createProject("Invocation project", root);
    const conversation = store.createConversation(project.id, "Invocation chat");
    const { turn } = store.beginAgentTurn({
      conversationId: conversation.id,
      runId: randomUUID(),
      content: "Edit the file.",
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    return { store, conversation, turn };
  }

  it("reads the turn checkpoint's change counts while the checkpoint is being written", async () => {
    const { root, indexes } = repository();
    writeFileSync(join(root, "tracked.txt"), "edit\n");
    const { store, conversation, turn } = turnInRepository(root, indexes);
    try {
      let releaseStatus!: () => void;
      const statusReleased = new Promise<void>((resolve) => { releaseStatus = resolve; });
      gitGate.hold = (args) => args[0] === "status" ? statusReleased : null;
      const checkpointWritten = vi.waitFor(() => {
        expect(gitEvents.some((event) => event.startsWith("start:update-ref"))).toBe(true);
      }, { timeout: 5_000 }).then(() => true, () => false);
      void checkpointWritten.finally(releaseStatus);
      gitEvents.splice(0);
      gitCalls.splice(0);

      const result = await new TurnGitArtifactManager(store, indexes)
        .captureBefore({ turn, checkpointId: null, turnCheckpoint: true });

      expect(await checkpointWritten).toBe(true);
      const statusStart = gitEvents.findIndex((event) => event.startsWith("start:status"));
      const statusEnd = gitEvents.findIndex((event) => event.startsWith("end:status"));
      const checkpointRef = gitEvents.findIndex((event) => event.startsWith("start:update-ref"));
      expect(statusStart).toBeGreaterThanOrEqual(0);
      expect(statusStart).toBeLessThan(checkpointRef);
      expect(checkpointRef).toBeLessThan(statusEnd);
      expect(gitCalls.map(subcommand)).not.toContain("remote");
      expect(result?.failure).toBeNull();
      expect(store.conversationDetail(conversation.id)!.checkpoints).toEqual([
        expect.objectContaining({ id: result?.checkpointId, filesChanged: 1, insertions: 1, deletions: 1 }),
      ]);
    } finally {
      store.close();
    }
  });

  it("deletes a written turn checkpoint when its change counts cannot be read", async () => {
    const { root, indexes } = repository();
    writeFileSync(join(root, "tracked.txt"), "edit\n");
    const { store, conversation, turn } = turnInRepository(root, indexes);
    try {
      gitGate.hold = (args) => args[0] === "status"
        ? Promise.reject(new GitError("operation-failed", "Unable to read the repository status."))
        : null;

      const result = await new TurnGitArtifactManager(store, indexes)
        .captureBefore({ turn, checkpointId: null, turnCheckpoint: true });

      expect(result).toEqual({ checkpointId: null, failure: "Unable to read the repository status." });
      expect(store.conversationDetail(conversation.id)!.checkpoints).toEqual([]);
      const refs = git(root, "for-each-ref", "--format=%(refname)", `refs/inertia/checkpoints/${conversation.id}/`);
      expect(refs.split("\n").filter(Boolean)).toEqual([store.turnGitArtifactStorage(turn.id).beforeRef]);
    } finally {
      store.close();
    }
  });
});
