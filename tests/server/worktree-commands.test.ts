import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import type { RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import { startTestRuntime } from "../support/test-runtime";
import { createWorktreeWithOwnershipReceipt } from "../../src/server/git";
import { GitError } from "../../src/server/git/types";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import {
  createWorktreeCommandHandler,
  type WorktreeCommandDependencies,
} from "../../src/server/runtime/commands/worktree-commands";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import type { WorktreeActionOutcome, WorktreeList } from "../../src/shared/worktrees";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

type CommandInput = ClientCommand extends infer Command
  ? Command extends { requestId: string } ? Omit<Command, "requestId"> : never
  : never;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

interface Fixture {
  root: string;
  data: string;
  workspace: string;
  store: RuntimeStore;
  projectId: string;
  terminalResumes: Set<string>;
  tracked: string[];
  run(command: CommandInput): Promise<ServerEvent>;
  list(): Promise<WorktreeList>;
  remove(path: string): Promise<WorktreeActionOutcome>;
  owned(title: string): Promise<{ conversationId: string; path: string; branch: string }>;
  ownershipRow(conversationId: string): unknown;
}

const directories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
});

async function fixture(
  overrides: Pick<WorktreeCommandDependencies, "removeRegisteredWorktree"> = {},
): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inertia-worktree-commands-")));
  directories.push(root);
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(data);
  mkdirSync(workspace);
  git(workspace, "init", "--initial-branch=main");
  git(workspace, "config", "user.email", "runtime@example.invalid");
  git(workspace, "config", "user.name", "Runtime Test");
  writeFileSync(join(workspace, ".gitignore"), "*.log\n");
  writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-m", "initial");

  const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
  stores.push(store);
  const project = store.createProject(
    "Worktrees",
    workspace,
    await inspectProjectIdentity(workspace),
  );
  const terminalResumes = new Set<string>();
  const tracked: string[] = [];
  const events: ServerEvent[] = [];
  const dependencies: WorktreeCommandDependencies = {
    store,
    dataDirectory: data,
    providerTerminalResumes: { isActive: (id) => terminalResumes.has(id) },
    workspaceRuns: {
      trackSourceControl: async (label, _projectId, _conversationId, _checkout, _requestId, operation) => {
        tracked.push(label);
        return await operation();
      },
    },
    broadcastSnapshot: () => undefined,
    send: (_socket, event) => events.push(event),
    ...overrides,
  };
  const handler = createWorktreeCommandHandler(dependencies);
  const run = async (command: CommandInput): Promise<ServerEvent> => {
    const requestId = randomUUID();
    await handler({} as WebSocket, { ...command, requestId } as ClientCommand);
    const event = events.find((candidate) =>
      "requestId" in candidate && candidate.requestId === requestId);
    if (!event) throw new Error("No worktree command response.");
    return event;
  };
  const result = (event: ServerEvent) => {
    if (event.type !== "request.result") throw new Error("Expected a result.");
    return event.result;
  };
  return {
    root,
    data,
    workspace,
    store,
    projectId: project.id,
    terminalResumes,
    tracked,
    run,
    list: async () => {
      const value = result(await run({ type: "worktree.list", payload: { projectId: project.id } }));
      if (value.kind !== "worktree.list") throw new Error("Expected a worktree list.");
      return value.list;
    },
    remove: async (path) => {
      const value = result(await run({ type: "worktree.remove", payload: { projectId: project.id, path } }));
      if (value.kind !== "worktree.action") throw new Error("Expected a worktree action.");
      return value.outcome;
    },
    owned: async (title) => {
      const conversation = store.createConversation(project.id, title);
      const branch = `inertia/${conversation.id.slice(0, 8)}`;
      const target = join(data, "worktrees", conversation.id);
      mkdirSync(join(data, "worktrees"), { recursive: true, mode: 0o700 });
      const status = await createWorktreeWithOwnershipReceipt(
        workspace,
        target,
        { branch, createBranch: true, startPoint: "main" },
        {
          beforeAdd: (token) => store.conversationWorktrees.beginCreation(conversation.id, target, branch, token),
          notAdded: () => store.conversationWorktrees.rejectCreation(conversation.id),
          added: (identity) => store.conversationWorktrees.recordCreation(conversation.id, target, branch, identity),
        },
      );
      return { conversationId: conversation.id, path: status.root, branch };
    },
    ownershipRow: (conversationId) => (store as unknown as {
      database: { prepare(sql: string): { get(id: string): unknown } };
    }).database.prepare(`
      SELECT owns_worktree, creation_state, ownership_token
      FROM conversation_worktree_ownership WHERE conversation_id = ?
    `).get(conversationId),
  };
}

/** The administrative folder a linked worktree's `.git` file points at. */
function adminDirectory(worktreePath: string): string {
  return readFileSync(join(worktreePath, ".git"), "utf8").replace(/^gitdir:\s*/u, "").trim();
}

function branches(workspace: string): string[] {
  return git(workspace, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    .split("\n").filter(Boolean);
}

describe("worktree commands", () => {
  it("lists main, owned and foreign worktrees without leaking foreign paths", async () => {
    const test = await fixture();
    const owned = await test.owned("Owned chat");
    const foreignPath = join(test.root, "elsewhere", "foreign-checkout");
    git(test.workspace, "worktree", "add", "-b", "foreign", "--", foreignPath);

    const list = await test.list();
    expect(list.projectId).toBe(test.projectId);
    expect(list.truncated).toBe(false);
    expect(list.worktrees).toHaveLength(3);
    const [main, ...linked] = list.worktrees;
    expect(main).toMatchObject({
      path: ".", location: "repository", branch: "main", isMain: true, owned: false,
      dirty: false, changeCount: 0, removal: { allowed: false, reason: expect.stringMatching(/main checkout/u) },
    });
    expect(main!.head).toMatch(/^[0-9a-f]{40,64}$/u);
    const ownedEntry = linked.find(({ owned: isOwned }) => isOwned)!;
    expect(ownedEntry).toEqual({
      path: owned.path,
      location: "inertia",
      branch: owned.branch,
      head: main!.head,
      isMain: false,
      owned: true,
      conversationId: owned.conversationId,
      title: "Owned chat",
      chatStatus: "idle",
      sharedChatCount: 0,
      dirty: false,
      changeCount: 0,
      changeCountTruncated: false,
      ignoredFiles: false,
      locked: false,
      prunable: false,
      removal: { allowed: true },
    });
    const foreign = linked.find(({ owned: isOwned }) => !isOwned)!;
    expect(foreign).toMatchObject({
      path: "…/foreign-checkout",
      location: "external",
      branch: "foreign",
      owned: false,
      conversationId: null,
      title: null,
      chatStatus: null,
      removal: { allowed: false, reason: expect.stringMatching(/did not create/u) },
    });
    expect(JSON.stringify(list)).not.toContain(join(test.root, "elsewhere"));
    await expect(test.remove(foreignPath)).rejects.toThrow(/inside Inertia's worktree folder/u);
    expect(existsSync(foreignPath)).toBe(true);
  });

  it("refuses the main checkout and paths outside the managed folder", async () => {
    const test = await fixture();
    await expect(test.remove(test.workspace)).rejects.toThrow(/inside Inertia's worktree folder/u);
    await expect(test.remove("relative/path")).rejects.toThrow(/inside Inertia's worktree folder/u);
    expect(existsSync(join(test.workspace, "tracked.txt"))).toBe(true);
  });

  it("refuses untracked, modified, staged and ignored files and changes nothing", async () => {
    const test = await fixture();
    const owned = await test.owned("Dirty chat");
    const check = async (pattern: RegExp, dirty: boolean | null) => {
      const entry = (await test.list()).worktrees.find(({ owned: isOwned }) => isOwned)!;
      expect(entry.dirty).toBe(dirty);
      expect(entry.removal).toEqual({ allowed: false, reason: expect.stringMatching(pattern) });
      await expect(test.remove(owned.path)).rejects.toThrow(pattern);
      expect(existsSync(owned.path)).toBe(true);
      expect(branches(test.workspace)).toContain(owned.branch);
      expect(test.ownershipRow(owned.conversationId)).toMatchObject({ owns_worktree: 1 });
    };

    writeFileSync(join(owned.path, "draft.txt"), "valuable\n");
    await check(/1 uncommitted change\b/u, true);
    rmSync(join(owned.path, "draft.txt"));

    writeFileSync(join(owned.path, "tracked.txt"), "edited\n");
    await check(/uncommitted/u, true);
    git(owned.path, "add", "tracked.txt");
    await check(/uncommitted/u, true);
    git(owned.path, "reset", "--hard", "--quiet");

    writeFileSync(join(owned.path, "local.log"), "ignored but valuable\n");
    const entry = (await test.list()).worktrees.find(({ owned: isOwned }) => isOwned)!;
    expect(entry).toMatchObject({ dirty: false, ignoredFiles: true });
    await check(/ignored files/u, false);
    expect(test.tracked).toEqual([]);
  });

  it("refuses while the owning chat is running or resumed in a terminal", async () => {
    const test = await fixture();
    const owned = await test.owned("Busy chat");
    test.store.updateConversation(owned.conversationId, { status: "running" });
    await expect(test.remove(owned.path)).rejects.toThrow(/Stop the chat “Busy chat”/u);
    expect((await test.list()).worktrees.find(({ owned: isOwned }) => isOwned))
      .toMatchObject({ chatStatus: "running", removal: { allowed: false } });
    test.store.updateConversation(owned.conversationId, { status: "completed" });
    test.terminalResumes.add(owned.conversationId);
    await expect(test.remove(owned.path)).rejects.toThrow(/Stop the chat/u);
    expect(existsSync(owned.path)).toBe(true);
  });

  it("refuses a worktree another chat also uses", async () => {
    const test = await fixture();
    const owned = await test.owned("Owner");
    const other = test.store.createConversation(test.projectId, "Borrower");
    test.store.updateConversation(other.id, { worktreePath: owned.path });
    const entry = (await test.list()).worktrees.find(({ owned: isOwned }) => isOwned)!;
    expect(entry.sharedChatCount).toBe(1);
    await expect(test.remove(owned.path)).rejects.toThrow(/Another chat also uses/u);
    expect(existsSync(owned.path)).toBe(true);
  });

  it("refuses a worktree Git has locked", async () => {
    const test = await fixture();
    const owned = await test.owned("Locked chat");
    git(test.workspace, "worktree", "lock", "--", owned.path);
    await expect(test.remove(owned.path)).rejects.toThrow(/locked/u);
    expect(existsSync(owned.path)).toBe(true);
  });

  it("removes clean owned worktrees and deletes only merged generated branches", async () => {
    const test = await fixture();
    const unchanged = await test.owned("Unchanged");
    const unmerged = await test.owned("Unmerged");
    const merged = await test.owned("Merged");
    for (const [owned, file] of [[unmerged, "unmerged.txt"], [merged, "merged.txt"]] as const) {
      writeFileSync(join(owned.path, file), `${file}\n`);
      git(owned.path, "add", file);
      git(owned.path, "commit", "-m", file);
    }
    git(test.workspace, "merge", "--ff-only", merged.branch);

    const first = await test.remove(unchanged.path);
    expect(first).toMatchObject({ action: "remove", branchDeleted: true });
    expect(first.message).toContain(`Deleted branch ${unchanged.branch}`);
    const second = await test.remove(unmerged.path);
    expect(second).toMatchObject({ action: "remove", branchDeleted: false });
    expect(second.message).toContain(`Kept branch ${unmerged.branch}`);
    const third = await test.remove(merged.path);
    expect(third).toMatchObject({ action: "remove", branchDeleted: true });
    expect(test.tracked).toEqual(["Remove worktree", "Remove worktree", "Remove worktree"]);

    for (const owned of [unchanged, unmerged, merged]) {
      expect(existsSync(owned.path)).toBe(false);
      expect(test.ownershipRow(owned.conversationId)).toEqual({
        owns_worktree: 0, creation_state: "external", ownership_token: null,
      });
      // The chat keeps its historical checkout so it never falls back to the main checkout.
      expect(test.store.conversation(owned.conversationId).worktreePath).toBe(owned.path);
    }
    expect(branches(test.workspace).sort()).toEqual([unmerged.branch, "main"].sort());
    expect(git(test.workspace, "worktree", "list", "--porcelain")).not.toContain("worktrees");
    expect((await test.list()).worktrees).toHaveLength(1);
    await expect(test.remove(unchanged.path)).rejects.toThrow(/does not list this worktree/u);
  });

  it("prunes only stale entries inside Inertia's worktree folder, one at a time", async () => {
    const test = await fixture();
    const owned = await test.owned("Kept chat");
    const missingChat = await test.owned("Missing folder");
    const orphan = join(test.data, "worktrees", "orphan-checkout");
    git(test.workspace, "worktree", "add", "-b", "orphan", "--", orphan);
    const external = join(test.root, "stale-checkout");
    git(test.workspace, "worktree", "add", "-b", "stale", "--", external);
    const externalAdmin = adminDirectory(external);
    for (const path of [missingChat.path, orphan, external]) rmSync(path, { recursive: true, force: true });
    const before = (await test.list()).worktrees.find(({ path }) => path === "…/stale-checkout")!;
    expect(before).toMatchObject({ prunable: true, dirty: null });

    const event = await test.run({ type: "worktree.prune", payload: { projectId: test.projectId } });
    expect(event).toMatchObject({
      type: "request.result",
      result: {
        kind: "worktree.action",
        outcome: { action: "prune", branchDeleted: false },
      },
    });
    const message = event.type === "request.result" && event.result.kind === "worktree.action"
      ? event.result.outcome.message
      : "";
    expect(message).toMatch(/Cleared 2 stale worktree entries from Inertia's worktree folder\./u);
    expect(message).toMatch(/Kept 1 stale entry outside Inertia's worktree folder/u);
    expect(message).toMatch(/No files were changed\.$/u);
    expect(test.tracked).toEqual(["Prune worktrees"]);

    // The external entry, on what may be a disconnected drive, keeps its
    // registration and administrative folder (including its index).
    const after = await test.list();
    expect(after.worktrees.map(({ path }) => path)).toEqual([".", owned.path, "…/stale-checkout"]);
    expect(existsSync(externalAdmin)).toBe(true);
    expect(existsSync(join(owned.path, "tracked.txt"))).toBe(true);
    expect(branches(test.workspace)).toEqual(expect.arrayContaining(["stale", "orphan", missingChat.branch]));
    expect(test.ownershipRow(missingChat.conversationId)).toEqual({
      owns_worktree: 0, creation_state: "external", ownership_token: null,
    });
    expect(test.ownershipRow(owned.conversationId)).toMatchObject({ owns_worktree: 1, creation_state: "created" });
  }, 30_000);

  it("refuses edits hidden by assume-unchanged or skip-worktree marks", async () => {
    const test = await fixture();
    const owned = await test.owned("Hidden edits");
    const refuse = async () => {
      const entry = (await test.list()).worktrees.find(({ owned: isOwned }) => isOwned)!;
      expect(entry).toMatchObject({ dirty: false, ignoredFiles: false });
      expect(entry.removal).toEqual({ allowed: false, reason: expect.stringMatching(/assume-unchanged or skip-worktree/u) });
      await expect(test.remove(owned.path)).rejects.toThrow(/assume-unchanged or skip-worktree/u);
      expect(readFileSync(join(owned.path, "tracked.txt"), "utf8")).toBe("hidden edit\n");
      expect(test.ownershipRow(owned.conversationId)).toMatchObject({ owns_worktree: 1 });
    };

    git(owned.path, "update-index", "--assume-unchanged", "tracked.txt");
    writeFileSync(join(owned.path, "tracked.txt"), "hidden edit\n");
    expect(git(owned.path, "status", "--porcelain")).toBe("");
    await refuse();

    git(owned.path, "update-index", "--no-assume-unchanged", "tracked.txt");
    git(owned.path, "update-index", "--skip-worktree", "tracked.txt");
    expect(git(owned.path, "status", "--porcelain")).toBe("");
    await refuse();

    // A skip-worktree entry that is absent from disk holds no edits.
    rmSync(join(owned.path, "tracked.txt"));
    expect(git(owned.path, "status", "--porcelain")).toBe("");
    const entry = (await test.list()).worktrees.find(({ owned: isOwned }) => isOwned)!;
    expect(entry.removal).toEqual({ allowed: true });
  }, 30_000);

  it("reports a partial removal truthfully and releases the receipt when Git unregistered the worktree", async () => {
    let attempted = "";
    const test = await fixture({
      // Reproduces Git for Windows with a file held open: the folder is partly
      // deleted, the administrative entry is removed, and Git exits non-zero.
      removeRegisteredWorktree: async (_root, registeredPath) => {
        attempted = registeredPath;
        const admin = adminDirectory(registeredPath);
        rmSync(join(registeredPath, "tracked.txt"));
        rmSync(join(registeredPath, ".git"));
        rmSync(admin, { recursive: true, force: true });
        throw new GitError("operation-failed", "Git could not remove the worktree.", 255);
      },
    });
    const owned = await test.owned("Held open");

    const outcome = await test.remove(owned.path);

    expect(realpathSync(attempted)).toBe(owned.path);
    expect(outcome).toMatchObject({ action: "remove", partial: true, branchDeleted: true });
    expect(outcome.message).toContain(`What is left is in ${owned.path}`);
    expect(outcome.message).toMatch(/delete the folder by hand/u);
    expect(outcome.message).not.toMatch(/files were kept/u);
    expect(existsSync(join(owned.path, ".gitignore"))).toBe(true);
    expect(git(test.workspace, "worktree", "list", "--porcelain")).not.toContain(owned.conversationId);
    expect(test.ownershipRow(owned.conversationId)).toEqual({
      owns_worktree: 0, creation_state: "external", ownership_token: null,
    });
    expect(test.store.conversation(owned.conversationId).worktreePath).toBe(owned.path);
  }, 30_000);

  it("says the files were kept only after confirming a refused worktree is intact", async () => {
    let damage = false;
    const test = await fixture({
      removeRegisteredWorktree: async (_root, registeredPath) => {
        if (damage) rmSync(join(registeredPath, "tracked.txt"));
        throw new GitError("operation-failed", "Git could not remove the worktree.", 128);
      },
    });
    const owned = await test.owned("Refused");

    await expect(test.remove(owned.path)).rejects.toThrow("Git refused to remove the worktree. Its files were kept.");
    expect(existsSync(join(owned.path, "tracked.txt"))).toBe(true);
    expect(test.ownershipRow(owned.conversationId)).toMatchObject({ owns_worktree: 1, creation_state: "created" });

    damage = true;
    await expect(test.remove(owned.path)).rejects.toThrow(/some of its files may already be deleted/u);
    expect(test.ownershipRow(owned.conversationId)).toMatchObject({ owns_worktree: 1, creation_state: "created" });
  }, 30_000);

  it("releases a removed worktree only for the receipt's current ownership token", async () => {
    const test = await fixture();
    const owned = await test.owned("Receipt");
    const row = test.ownershipRow(owned.conversationId) as { ownership_token: string };
    expect(() => test.store.conversationWorktrees.releaseRemovedWorktree(owned.conversationId, randomUUID()))
      .toThrow(/no longer matches its ownership receipt/u);
    expect(test.ownershipRow(owned.conversationId)).toMatchObject({ owns_worktree: 1, creation_state: "created" });
    test.store.conversationWorktrees.releaseRemovedWorktree(owned.conversationId, row.ownership_token);
    expect(test.ownershipRow(owned.conversationId)).toEqual({
      owns_worktree: 0, creation_state: "external", ownership_token: null,
    });
    expect(() => test.store.conversationWorktrees.releaseRemovedWorktree(owned.conversationId, row.ownership_token))
      .toThrow(/no longer matches its ownership receipt/u);
  });

  it("rejects projects that are not Git repositories", async () => {
    const test = await fixture();
    const plain = join(test.root, "plain");
    mkdirSync(plain);
    const project = test.store.createProject("Plain", plain, await inspectProjectIdentity(plain));
    const handler = createWorktreeCommandHandler({
      store: test.store,
      dataDirectory: test.data,
      providerTerminalResumes: { isActive: () => false },
      workspaceRuns: { trackSourceControl: async (...args) => await args[5]() },
      broadcastSnapshot: () => undefined,
      send: () => undefined,
    });
    await expect(handler({} as WebSocket, {
      type: "worktree.list", requestId: randomUUID(), payload: { projectId: project.id },
    })).rejects.toThrow(/not a Git repository/u);
  });
});

describe("worktree commands through the runtime", () => {
  const runtimes: RunningRuntime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("lists and removes an isolated chat worktree over the main-window socket", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "inertia-worktree-runtime-")));
    directories.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(data);
    mkdirSync(workspace);
    git(workspace, "init", "--initial-branch=main");
    git(workspace, "config", "user.email", "runtime@example.invalid");
    git(workspace, "config", "user.name", "Runtime Test");
    writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-m", "initial");
    const seeded = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const project = seeded.createProject("Runtime worktrees", workspace, await inspectProjectIdentity(workspace));
    seeded.close();
    const runtime = await startTestRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
    });
    runtimes.push(runtime);
    const socket = new WebSocket(runtime.websocketUrl, { origin: "http://localhost:5173" });
    const events: ServerEvent[] = [];
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      events.push(event.type === "runtime.event" ? event.event : event);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const request = async (command: CommandInput): Promise<ServerEvent> => {
      const requestId = randomUUID();
      socket.send(JSON.stringify({ ...command, requestId }));
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const match = events.find((event) => "requestId" in event && event.requestId === requestId
          && (event.type === "request.result" || event.type === "request.error" || event.type === "request.ok"));
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${command.type}.`);
    };
    try {
      expect(await request({
        type: "conversation.create",
        payload: { projectId: project.id, title: "Isolated", useWorktree: true },
      })).toMatchObject({ type: "request.ok" });
      const listed = await request({ type: "worktree.list", payload: { projectId: project.id } });
      if (listed.type !== "request.result" || listed.result.kind !== "worktree.list") {
        throw new Error(`Unexpected list response: ${JSON.stringify(listed)}`);
      }
      const owned = listed.result.list.worktrees.find(({ owned: isOwned }) => isOwned)!;
      expect(owned).toMatchObject({ location: "inertia", title: "Isolated", removal: { allowed: true } });
      expect(await request({
        type: "worktree.remove",
        payload: { projectId: project.id, path: owned.path },
      })).toMatchObject({
        type: "request.result",
        result: { kind: "worktree.action", outcome: { action: "remove", branchDeleted: true } },
      });
      expect(existsSync(owned.path)).toBe(false);
      expect(await request({
        type: "conversation.delete",
        payload: { conversationId: owned.conversationId! },
      })).toMatchObject({ type: "request.ok" });
    } finally {
      socket.close();
    }
  });
});
