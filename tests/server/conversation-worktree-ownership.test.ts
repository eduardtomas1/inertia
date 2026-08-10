import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import {
  createWorktreeWithOwnershipReceipt,
  removeOwnedWorktree,
} from "../../src/server/git";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import type { ConversationShell, ServerEvent } from "../../src/shared/contracts";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

class EventQueue {
  private readonly events: ServerEvent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      this.events.push(event.type === "runtime.event" ? event.event : event);
      for (const listener of this.listeners) listener();
    });
  }

  async next<T extends ServerEvent>(
    predicate: (event: ServerEvent) => event is T,
  ): Promise<T> {
    const take = (): T | undefined => {
      const index = this.events.findIndex(predicate);
      return index < 0 ? undefined : this.events.splice(index, 1)[0] as T;
    };
    const existing = take();
    if (existing) return existing;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        const pending = this.events.map((event) => event.type === "request.error"
          ? `${event.type}:${event.message}`
          : event.type);
        reject(new Error(
          `Timed out waiting for the worktree ownership event: ${pending.join(", ")}`,
        ));
      }, 8_000);
      const check = (): void => {
        const event = take();
        if (!event) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolve(event);
      };
      this.listeners.add(check);
    });
  }
}

async function connect(
  url: string,
): Promise<{ socket: WebSocket; events: EventQueue }> {
  const socket = new WebSocket(url, { origin: "http://localhost:5173" });
  const events = new EventQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, events };
}

function expectOwnedReceipt(
  databasePath: string,
  conversationId: string,
  state: "creating" | "created",
): void {
  const database = new Database(databasePath, { readonly: true });
  try {
    expect(database.prepare(`
      SELECT owns_worktree, creation_state
      FROM conversation_worktree_ownership
      WHERE conversation_id = ?
    `).get(conversationId)).toEqual({
      owns_worktree: 1,
      creation_state: state,
    });
  } finally {
    database.close();
  }
}

describe("ordinary conversation worktree ownership", () => {
  const directories: string[] = [];
  const runtimes: RunningRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });

  it("requires manual removal for exact receipts and preserves ABA replacements", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-owned-worktree-"));
    directories.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(data);
    mkdirSync(workspace);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "runtime@example.invalid"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Runtime Test"], {
      cwd: workspace,
    });
    writeFileSync(
      join(workspace, ".git", "info", "exclude"),
      "ignored-sentinel.bin\n",
    );
    writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

    const seeded = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const project = seeded.createProject(
      "Owned worktrees",
      workspace,
      await inspectProjectIdentity(workspace),
    );
    seeded.close();
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );

    const createIsolated = async (title: string): Promise<ConversationShell> => {
      const requestId = randomUUID();
      client.socket.send(JSON.stringify({
        type: "conversation.create",
        requestId,
        payload: { projectId: project.id, title, useWorktree: true },
      }));
      await client.events.next(
        (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
          event.type === "request.ok" && event.requestId === requestId,
      );
      const update = await client.events.next(
        (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
          event.type === "snapshot.updated"
          && event.snapshot.conversations.some((conversation) =>
            conversation.title === title && conversation.worktreePath !== null),
      );
      return update.snapshot.conversations.find(
        (conversation) => conversation.title === title,
      )!;
    };
    const deleteConversation = async (conversationId: string) => {
      const requestId = randomUUID();
      client.socket.send(JSON.stringify({
        type: "conversation.delete",
        requestId,
        payload: { conversationId },
      }));
      return await client.events.next(
        (event): event is Extract<ServerEvent, {
          type: "request.ok" | "request.error";
        }> => (event.type === "request.ok" || event.type === "request.error")
          && event.requestId === requestId,
      );
    };

    const exact = await createIsolated("Exact owned checkout");
    const exactSentinel = join(exact.worktreePath!, "ignored-sentinel.bin");
    writeFileSync(exactSentinel, "valuable exact owned data\n");
    expect(await deleteConversation(exact.id)).toMatchObject({
      type: "request.error",
      message: expect.stringMatching(/registered.*remove.*manually/iu),
    });
    expect(existsSync(exactSentinel)).toBe(true);
    expectOwnedReceipt(join(data, "inertia.sqlite"), exact.id, "created");
    execFileSync(
      "git",
      ["worktree", "remove", "--force", "--", exact.worktreePath!],
      { cwd: workspace },
    );
    const pathVerifier = new RuntimeStore(
      join(data, "inertia.sqlite"),
      workspace,
      { recoverInterruptedRuns: false },
    );
    const exactOwnership = pathVerifier.conversationWorktrees.get(exact.id);
    if (
      !exactOwnership?.ownsWorktree
      || exactOwnership.creationState !== "created"
    ) {
      throw new Error("Expected the exact owned receipt to remain.");
    }
    await expect(removeOwnedWorktree(
      pathVerifier.projectPath(project.id),
      exactOwnership.path,
      exactOwnership.branch,
      exactOwnership.branchHead,
      exactOwnership.worktreeId,
      exactOwnership.repositoryIdentity,
      exactOwnership.ownershipToken,
      exactOwnership.filesystemReceipt,
    )).resolves.toBe("absent");
    pathVerifier.close();
    expect(await deleteConversation(exact.id)).toMatchObject({
      type: "request.ok",
    });
    expect(existsSync(exact.worktreePath!)).toBe(false);

    const replaced = await createIsolated("Replaced owned checkout");
    const replacedPath = replaced.worktreePath!;
    execFileSync(
      "git",
      ["worktree", "remove", "--force", "--", replacedPath],
      { cwd: workspace },
    );
    const stagingReplacement = join(data, "replacement-stage");
    execFileSync(
      "git",
      ["worktree", "add", "--", stagingReplacement, replaced.branch!],
      { cwd: workspace },
    );
    execFileSync(
      "git",
      ["worktree", "move", "--", stagingReplacement, replacedPath],
      { cwd: workspace },
    );
    const sentinel = join(replacedPath, "ignored-sentinel.bin");
    writeFileSync(sentinel, "valuable ignored replacement data\n");
    expect(execFileSync(
      "git",
      ["status", "--porcelain"],
      { cwd: replacedPath, encoding: "utf8" },
    )).toBe("");

    expect(await deleteConversation(replaced.id)).toMatchObject({
      type: "request.error",
      message: expect.stringMatching(/replaced|changed ownership/iu),
    });
    expect(existsSync(sentinel)).toBe(true);
    expectOwnedReceipt(join(data, "inertia.sqlite"), replaced.id, "created");
    const detailRequestId = randomUUID();
    client.socket.send(JSON.stringify({
      type: "conversation.detail.load",
      requestId: detailRequestId,
      payload: { conversationId: replaced.id },
    }));
    expect(await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === detailRequestId
        && event.result.kind === "conversation.detail",
    )).toMatchObject({
      result: { kind: "conversation.detail", state: "ready" },
    });
    client.socket.close();
  });

  it("blocks project removal until every owned chat worktree is resolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-project-owned-worktree-"));
    directories.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(data);
    mkdirSync(workspace);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "runtime@example.invalid"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Runtime Test"], {
      cwd: workspace,
    });
    writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

    const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const identity = await inspectProjectIdentity(workspace);
    const createOwned = async (
      projectId: string,
      title: string,
      suffix: string,
    ) => {
      const conversation = store.createConversation(projectId, title);
      const path = join(data, "worktrees", suffix);
      mkdirSync(join(data, "worktrees"), { recursive: true });
      const branch = `inertia/${suffix}`;
      await createWorktreeWithOwnershipReceipt(
        workspace,
        path,
        { branch, createBranch: true, startPoint: "main" },
        {
          beforeAdd: (ownershipToken) => {
            store.conversationWorktrees.beginCreation(
              conversation.id,
              path,
              branch,
              ownershipToken,
            );
          },
          notAdded: () => {
            store.conversationWorktrees.rejectCreation(conversation.id);
          },
          added: (receipt) => {
            store.conversationWorktrees.recordCreation(
              conversation.id,
              path,
              branch,
              receipt,
            );
          },
        },
      );
      return { conversation, path, branch };
    };
    const expectBlocked = (projectId: string): void => {
      expect(() => store.removeProject(projectId)).toThrow(
        /isolated chat worktrees.*Delete each affected chat.*manually/isu,
      );
      expect(store.snapshot().projects.some(({ id }) => id === projectId))
        .toBe(true);
    };

    try {
      const createdProject = store.createProject("Created", workspace, identity);
      const created = await createOwned(
        createdProject.id,
        "Created owned checkout",
        "project-created",
      );
      expectBlocked(createdProject.id);
      expect(store.conversationWorktrees.get(created.conversation.id))
        .toMatchObject({ ownsWorktree: true, creationState: "created" });
      expect(existsSync(created.path)).toBe(true);

      const interruptedProject = store.createProject(
        "Interrupted",
        workspace,
        identity,
      );
      const interrupted = store.createConversation(
        interruptedProject.id,
        "Interrupted creation",
      );
      const interruptedPath = join(data, "worktrees", "project-interrupted");
      store.conversationWorktrees.beginCreation(
        interrupted.id,
        interruptedPath,
        "inertia/project-interrupted",
        randomUUID(),
      );
      expectBlocked(interruptedProject.id);
      expect(store.conversationWorktrees.get(interrupted.id)).toMatchObject({
        ownsWorktree: true,
        creationState: "creating",
        path: interruptedPath,
      });

      const movedProject = store.createProject("Moved", workspace, identity);
      const moved = await createOwned(
        movedProject.id,
        "Moved owned checkout",
        "project-moved",
      );
      const movedPath = join(data, "worktrees", "project-moved-by-user");
      execFileSync("git", ["worktree", "move", "--", moved.path, movedPath], {
        cwd: workspace,
      });
      const movedSentinel = join(movedPath, "valuable-moved.bin");
      writeFileSync(movedSentinel, "valuable moved project data\n");
      expectBlocked(movedProject.id);
      expect(existsSync(movedSentinel)).toBe(true);
      expect(store.conversationWorktrees.get(moved.conversation.id))
        .toMatchObject({
          ownsWorktree: true,
          creationState: "created",
          path: expect.stringContaining("project-moved"),
        });

      const conflictingProject = store.createProject(
        "Conflicting",
        workspace,
        identity,
      );
      const conflicting = await createOwned(
        conflictingProject.id,
        "Conflicting owned checkout",
        "project-conflicting",
      );
      execFileSync(
        "git",
        ["worktree", "remove", "--force", "--", conflicting.path],
        { cwd: workspace },
      );
      const replacementStage = join(data, "worktrees", "replacement-stage");
      execFileSync(
        "git",
        ["worktree", "add", "--", replacementStage, conflicting.branch],
        { cwd: workspace },
      );
      execFileSync(
        "git",
        ["worktree", "move", "--", replacementStage, conflicting.path],
        { cwd: workspace },
      );
      const conflictingSentinel = join(conflicting.path, "valuable-conflict.bin");
      writeFileSync(conflictingSentinel, "valuable conflicting project data\n");
      expectBlocked(conflictingProject.id);
      expect(existsSync(conflictingSentinel)).toBe(true);
      expect(store.conversationWorktrees.get(conflicting.conversation.id))
        .toMatchObject({
          ownsWorktree: true,
          creationState: "created",
          path: expect.stringContaining("project-conflicting"),
        });

      const externalPath = join(data, "worktrees", "project-external");
      execFileSync(
        "git",
        ["worktree", "add", "-b", "external/project", "--", externalPath, "main"],
        { cwd: workspace },
      );
      const externalSentinel = join(externalPath, "valuable-external.bin");
      writeFileSync(externalSentinel, "valuable external project data\n");
      const externalProject = store.createProject("External", workspace, identity);
      const external = store.createConversation(
        externalProject.id,
        "External checkout",
        { branch: "external/project", worktreePath: externalPath },
      );
      expect(store.conversationWorktrees.get(external.id)).toMatchObject({
        ownsWorktree: false,
        creationState: "external",
      });
      expect(() => store.removeProject(externalProject.id)).not.toThrow();
      expect(store.snapshot().projects.some(({ id }) => id === externalProject.id))
        .toBe(false);
      expect(existsSync(externalSentinel)).toBe(true);
      expect(execFileSync(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: workspace, encoding: "utf8" },
      )).toContain(externalPath);
    } finally {
      store.close();
    }
  });

  it("blocks direct SQL project deletion atomically for every owned receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-owned-project-trigger-"));
    directories.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    const databasePath = join(data, "inertia.sqlite");
    mkdirSync(data);
    mkdirSync(workspace);
    const store = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    const records = (["creating", "created", "external"] as const).map(
      (state) => {
        const project = store.createProject(`Direct ${state}`, workspace);
        const conversation = store.createConversation(
          project.id,
          `Direct ${state} chat`,
        );
        const path = join(root, `${state}-artifact`);
        mkdirSync(path);
        const sentinel = join(path, "valuable.bin");
        writeFileSync(sentinel, `valuable ${state} data\n`);
        return { state, project, conversation, path, sentinel };
      },
    );
    store.close();

    const seeded = new Database(databasePath);
    seeded.pragma("foreign_keys = ON");
    const insert = seeded.prepare(`
      INSERT INTO conversation_worktree_ownership (
        conversation_id, path, branch, owns_worktree, creation_state,
        ownership_token, worktree_id, repository_identity,
        filesystem_identity_json, branch_head
      ) VALUES (
        @conversationId, @path, @branch, @ownsWorktree, @creationState,
        @ownershipToken, @worktreeId, @repositoryIdentity,
        @filesystemIdentity, @branchHead
      )
    `);
    for (const record of records) {
      const owned = record.state !== "external";
      const created = record.state === "created";
      insert.run({
        conversationId: record.conversation.id,
        path: record.path,
        branch: owned ? `inertia/direct-${record.state}` : "external/direct",
        ownsWorktree: owned ? 1 : 0,
        creationState: record.state,
        ownershipToken: owned ? randomUUID() : null,
        worktreeId: created ? `direct-${record.state}` : null,
        repositoryIdentity: created ? "a".repeat(64) : null,
        filesystemIdentity: created
          ? JSON.stringify({
              version: 1,
              worktreesDirectory: {
                device: "1",
                inode: "2",
                birthtimeNs: "3",
              },
              adminDirectory: {
                device: "1",
                inode: "4",
                birthtimeNs: "5",
              },
            })
          : null,
        branchHead: created ? "b".repeat(40) : null,
      });
    }
    seeded.close();

    for (const record of records.filter(({ state }) => state !== "external")) {
      const deletion = new Database(databasePath);
      deletion.pragma("foreign_keys = ON");
      expect(() => deletion.prepare("DELETE FROM projects WHERE id = ?").run(
        record.project.id,
      )).toThrow(/isolated chat worktrees.*Delete each affected chat/isu);
      deletion.close();

      const reopened = new RuntimeStore(databasePath, workspace, {
        recoverInterruptedRuns: false,
      });
      expect(reopened.project(record.project.id)).toMatchObject({
        id: record.project.id,
      });
      expect(reopened.conversationWorktrees.get(record.conversation.id))
        .toMatchObject({
          ownsWorktree: true,
          creationState: record.state,
        });
      reopened.close();
      expect(existsSync(record.sentinel)).toBe(true);
    }

    const external = records.find(({ state }) => state === "external")!;
    const deletion = new Database(databasePath);
    deletion.pragma("foreign_keys = ON");
    expect(deletion.prepare("DELETE FROM projects WHERE id = ?").run(
      external.project.id,
    ).changes).toBe(1);
    deletion.close();
    const reopened = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    expect(reopened.snapshot().projects.some(
      ({ id }) => id === external.project.id,
    )).toBe(false);
    reopened.close();
    expect(existsSync(external.sentinel)).toBe(true);
  });

  it("never auto-deletes an externally attached worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-external-worktree-"));
    directories.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    const externalPath = join(root, "external-worktree");
    mkdirSync(data);
    mkdirSync(workspace);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "runtime@example.invalid"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Runtime Test"], {
      cwd: workspace,
    });
    writeFileSync(
      join(workspace, ".git", "info", "exclude"),
      "external-sentinel.bin\n",
    );
    writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
    execFileSync(
      "git",
      ["worktree", "add", "-b", "external/topic", "--", externalPath, "main"],
      { cwd: workspace },
    );
    const sentinel = join(externalPath, "external-sentinel.bin");
    writeFileSync(sentinel, "valuable external data\n");

    const seeded = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const project = seeded.createProject(
      "External worktree",
      workspace,
      await inspectProjectIdentity(workspace),
    );
    const conversation = seeded.createConversation(
      project.id,
      "External checkout",
      { branch: "external/topic", worktreePath: externalPath },
    );
    seeded.close();
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const requestId = randomUUID();
    client.socket.send(JSON.stringify({
      type: "conversation.delete",
      requestId,
      payload: { conversationId: conversation.id },
    }));
    expect(await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === requestId,
    )).toMatchObject({ type: "request.ok" });
    expect(existsSync(sentinel)).toBe(true);
    expect(execFileSync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: workspace, encoding: "utf8" },
    )).toContain(externalPath);
    client.socket.close();
  });

  it("reconciles interrupted creation without deleting ambiguous Git artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-interrupted-worktree-"));
    directories.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(data);
    mkdirSync(workspace);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "runtime@example.invalid"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Runtime Test"], {
      cwd: workspace,
    });
    writeFileSync(
      join(workspace, ".git", "info", "exclude"),
      "interrupted-sentinel.bin\n",
    );
    writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

    const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const project = store.createProject(
      "Interrupted worktrees",
      workspace,
      await inspectProjectIdentity(workspace),
    );
    const absent = store.createConversation(project.id, "Not added");
    const retained = store.createConversation(project.id, "Ambiguous add");
    const absentPath = join(data, "worktrees", absent.id);
    const retainedPath = join(data, "worktrees", retained.id);
    mkdirSync(join(data, "worktrees"));
    store.conversationWorktrees.beginCreation(
      absent.id,
      absentPath,
      "inertia/not-added",
      randomUUID(),
    );
    store.conversationWorktrees.beginCreation(
      retained.id,
      retainedPath,
      "inertia/interrupted",
      randomUUID(),
    );
    store.close();
    execFileSync(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "inertia/interrupted",
        "--",
        retainedPath,
        "main",
      ],
      { cwd: workspace },
    );
    const sentinel = join(retainedPath, "interrupted-sentinel.bin");
    writeFileSync(sentinel, "ambiguous worktree data\n");

    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const deleteConversation = async (conversationId: string) => {
      const requestId = randomUUID();
      client.socket.send(JSON.stringify({
        type: "conversation.delete",
        requestId,
        payload: { conversationId },
      }));
      return await client.events.next(
        (event): event is Extract<ServerEvent, {
          type: "request.ok" | "request.error";
        }> => (event.type === "request.ok" || event.type === "request.error")
          && event.requestId === requestId,
      );
    };

    await expect(deleteConversation(absent.id)).resolves.toMatchObject({
      type: "request.ok",
    });
    expect(existsSync(absentPath)).toBe(false);
    await expect(deleteConversation(retained.id)).resolves.toMatchObject({
      type: "request.error",
      message: expect.stringMatching(
        /interrupted.*preserved.*worktree.*branch.*manually/isu,
      ),
    });
    expect(existsSync(sentinel)).toBe(true);
    expectOwnedReceipt(join(data, "inertia.sqlite"), retained.id, "creating");
    expect(execFileSync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: workspace, encoding: "utf8" },
    )).toContain(retainedPath);
    execFileSync(
      "git",
      ["worktree", "remove", "--force", "--", retainedPath],
      { cwd: workspace },
    );
    await expect(deleteConversation(retained.id)).resolves.toMatchObject({
      type: "request.error",
      message: expect.stringMatching(/branch.*manually/isu),
    });
    expectOwnedReceipt(join(data, "inertia.sqlite"), retained.id, "creating");
    execFileSync(
      "git",
      ["branch", "-D", "--", "inertia/interrupted"],
      { cwd: workspace },
    );
    await expect(deleteConversation(retained.id)).resolves.toMatchObject({
      type: "request.ok",
    });
    expect(existsSync(retainedPath)).toBe(false);
    client.socket.close();
  });
});
