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

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
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

describe("ordinary conversation worktree ownership", () => {
  const directories: string[] = [];
  const runtimes: RunningRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });

  it("deletes the exact receipt and preserves a same-path, same-branch ABA replacement", async () => {
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
    const manuallyIsolated = seeded.createConversation(
      project.id,
      "Manual isolated checkout",
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
    expect((await deleteConversation(exact.id)).type).toBe("request.ok");
    expect(existsSync(exact.worktreePath!)).toBe(false);

    const manualRequestId = randomUUID();
    client.socket.send(JSON.stringify({
      type: "git.worktree.create",
      requestId: manualRequestId,
      payload: {
        projectId: project.id,
        conversationId: manuallyIsolated.id,
        baseBranch: "main",
        branch: "inertia/manual-owned",
      },
    }));
    const manualResult = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === manualRequestId
        && event.result.kind === "worktree.created",
    );
    if (manualResult.result.kind !== "worktree.created") {
      throw new Error("Expected a worktree creation result.");
    }
    expect(existsSync(manualResult.result.path)).toBe(true);
    expect((await deleteConversation(manuallyIsolated.id)).type).toBe(
      "request.ok",
    );
    expect(existsSync(manualResult.result.path)).toBe(false);

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
        (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
          event.type === "request.ok" && event.requestId === requestId,
      );
    };

    await expect(deleteConversation(absent.id)).resolves.toMatchObject({
      type: "request.ok",
    });
    expect(existsSync(absentPath)).toBe(false);
    await expect(deleteConversation(retained.id)).resolves.toMatchObject({
      type: "request.ok",
    });
    expect(existsSync(sentinel)).toBe(true);
    expect(execFileSync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: workspace, encoding: "utf8" },
    )).toContain(retainedPath);
    client.socket.close();
  });
});
