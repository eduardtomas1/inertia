import { execFileSync } from "node:child_process";
import { deleteCheckpoints } from "../../src/server/checkpoints";
import { RuntimeStore } from "../../src/server/database";
import { readDatabaseRecoveryExportFile } from "../../src/server/persistence/database-export-file";
import type { RunRecoveryImportWorkerOptions } from "../../src/server/persistence/database-recovery-import-worker-client";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { startTestRuntime } from "../support/test-runtime";
import { connectRuntime } from "../support/runtime-event-queue";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

vi.mock("../../src/server/persistence/database-recovery-import-worker-client", () => ({
  runRecoveryImportWorker: async (input: RunRecoveryImportWorkerOptions) => {
    const store = new RuntimeStore(input.databasePath, input.defaultWorkspacePath, { recoverInterruptedRuns: false });
    try {
      return await store.importRecoveryData(
        await readDatabaseRecoveryExportFile(input.recoveryPath),
        input.targetDirectory,
        { operationId: input.operationId },
      );
    } finally {
      store.close();
    }
  },
}));

vi.mock("../../src/server/checkpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/checkpoints")>();
  return { ...actual, deleteCheckpoints: vi.fn(actual.deleteCheckpoints) };
});

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends ClientCommand ? Omit<Command, "requestId"> : never : never;

async function connectScratchRuntime(root: string, dataDirectory: string, generation = 1) {
  const runtime = await startTestRuntime({ dataDirectory, defaultWorkspacePath: join(root, "workspace"),
    enableProviders: false, runtimeGenerationId: `00000000-0000-4000-8000-00000000000${generation}:1`,
    systemBootId: "test:00000000-0000-4000-8000-000000000001", secureFiles: new SecureFileTestBroker() });
  const client = await connectRuntime(runtime.websocketUrl);
  const send = (command: CommandWithoutId): string => {
    const requestId = randomUUID();
    client.socket.send(JSON.stringify({ ...command, requestId }));
    return requestId;
  };
  const request = async (command: CommandWithoutId) => client.events.nextForRequest(send(command),
    (event): event is Extract<ServerEvent, { type: "request.result" }> => event.type === "request.result", Date.now() + 10_000);
  const mutate = async (command: CommandWithoutId) => client.events.nextForRequest(send(command),
    (event): event is Extract<ServerEvent, { type: "request.ok" }> => event.type === "request.ok", Date.now() + 10_000);
  const settle = async (command: CommandWithoutId) => client.events.nextForRequest(send(command),
    (event): event is Extract<ServerEvent, { type: "request.result" | "request.ok" }> => (
      event.type === "request.result" || event.type === "request.ok"
    ), Date.now() + 10_000);
  const stop = async (): Promise<void> => {
    client.socket.close();
    await runtime.close();
  };
  return { runtime, client, request, mutate, settle, stop };
}

async function startScratchRuntime(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "workspace"));
  const connection = await connectScratchRuntime(root, join(root, "data"));
  const close = async (): Promise<void> => {
    await connection.stop();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, ...connection, close };
}

async function createScratchChat(connection: Awaited<ReturnType<typeof connectScratchRuntime>>, title: string) {
  const created = await connection.request({ type: "project.ensure-scratch", payload: {} });
  if (created.result.kind !== "project.created") throw new Error("Missing project");
  const projectId = created.result.projectId;
  const chat = await connection.request({ type: "conversation.create", payload: { projectId, title, activate: false } });
  if (chat.result.kind !== "conversation.created") throw new Error("Missing chat");
  const conversationId = chat.result.conversationId;
  const snapshot = await connection.client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated" && event.snapshot.conversations.some(({ id }) => id === conversationId));
  return { projectId, chat: snapshot.snapshot.conversations.find(({ id }) => id === conversationId)! };
}

it("gives concurrent requests from several windows exactly one managed folder", async () => {
  const context = await startScratchRuntime("inertia-scratch-concurrent-");
  try {
    const results = await Promise.all([1, 2, 3].map(() => context.request({ type: "project.ensure-scratch", payload: {} })));
    const ids = new Set(results.map(({ result }) => result.kind === "project.created" ? result.projectId : null));
    expect(ids.size).toBe(1);
    const [first, second] = await Promise.all([createScratchChat(context, "One"), createScratchChat(context, "One")]);
    expect(first.chat.worktreePath).not.toBe(second.chat.worktreePath);
    expect(new Set([first.projectId, second.projectId, ...ids])).toEqual(new Set([first.projectId]));
  } finally {
    await context.close();
  }
});

it("refuses every root-level workspace route for the managed folder without a chat", async () => {
  const context = await startScratchRuntime("inertia-scratch-routes-");
  try {
    const { projectId } = await createScratchChat(context, "Chat A");
    const terminalId = randomUUID();
    const commands: CommandWithoutId[] = [
      { type: "workspace.entries", payload: { projectId, query: "a" } },
      { type: "workspace.file.read", payload: { projectId, path: "x.txt" } },
      { type: "project.actions", payload: { projectId } },
      { type: "project.action.run", payload: { projectId, actionId: "x", terminalId, cols: 80, rows: 24 } },
      { type: "terminal.create", payload: { projectId, cols: 80, rows: 24 } },
      { type: "terminal.attach", payload: { projectId, terminalId, cols: 80, rows: 24 } },
      { type: "git.refresh", payload: { projectId } },
      { type: "git.workspace.refresh", payload: { projectId } },
      { type: "git.fetch", payload: { projectId } },
      { type: "git.pull", payload: { projectId } },
      { type: "git.push", payload: { projectId } },
      { type: "git.branch.create", payload: { projectId, name: "x" } },
      { type: "git.pr.open", payload: { projectId } },
    ];
    for (const command of commands) {
      await expect(context.settle(command), command.type).rejects.toThrow(/Choose a chat|Refresh repository status/u);
    }
  } finally {
    await context.close();
  }
});

it("never crosses chat and project identities", async () => {
  const context = await startScratchRuntime("inertia-scratch-identity-");
  try {
    const { projectId, chat: scratchChat } = await createScratchChat(context, "Scratch chat");
    const userFolder = join(context.root, "user");
    mkdirSync(userFolder);
    const user = await context.request({ type: "project.create", payload: { name: "User", path: userFolder } });
    if (user.result.kind !== "project.created") throw new Error("Missing user project");
    const userProjectId = user.result.projectId;
    const created = await context.request({ type: "conversation.create", payload: { projectId: userProjectId, title: "User chat", activate: false } });
    if (created.result.kind !== "conversation.created") throw new Error("Missing user chat");
    const userChatId = created.result.conversationId;
    await expect(context.request({ type: "workspace.entries", payload: { projectId, conversationId: userChatId } })).rejects.toThrow("does not belong");
    await expect(context.request({ type: "workspace.entries", payload: { projectId: userProjectId, conversationId: scratchChat.id } })).rejects.toThrow("does not belong");
    await expect(context.request({ type: "conversation.create", payload: {
      projectId: userProjectId, title: "Reuse scratch", worktreePath: scratchChat.worktreePath!, activate: false,
    } })).rejects.toThrow();
  } finally {
    await context.close();
  }
});

it("re-enrolls existing chats at startup after the data directory moved", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-scratch-moved-"));
  mkdirSync(join(root, "workspace"));
  try {
    const first = await connectScratchRuntime(root, join(root, "data"));
    const { projectId, chat } = await createScratchChat(first, "Before the move");
    writeFileSync(join(chat.worktreePath!, "notes.txt"), "moved notes");
    await first.stop();
    mkdirSync(join(root, "moved"));
    for (const name of readdirSync(join(root, "data")).filter((entry) => entry.startsWith("inertia.sqlite") || entry === "scratch")) {
      renameSync(join(root, "data", name), join(root, "moved", name));
    }
    const second = await connectScratchRuntime(root, join(root, "moved"), 2);
    try {
      const listed = await second.request({ type: "workspace.entries", payload: { projectId, conversationId: chat.id } });
      expect(JSON.stringify(listed.result)).toContain("notes.txt");
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("gives imported chats without a project their own folders after a runtime recovery import", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-scratch-import-"));
  mkdirSync(join(root, "workspace"));
  try {
    const source = await connectScratchRuntime(root, join(root, "source"));
    await createScratchChat(source, "Recovered chat");
    const recoveryPath = join(root, "recovery.json");
    await source.runtime.exportRecoveryData(recoveryPath);
    await source.stop();
    const target = await connectScratchRuntime(root, join(root, "target"), 2);
    try {
      const recoveryFolder = join(root, "recovered");
      mkdirSync(recoveryFolder);
      await createScratchChat(target, "Already here");
      const insideScratch = join(root, "target", "scratch");
      await expect(target.runtime.importRecoveryData(recoveryPath, insideScratch, new AbortController().signal, randomUUID()))
        .rejects.toThrow("Choose a recovery folder outside");
      await target.runtime.importRecoveryData(recoveryPath, recoveryFolder, new AbortController().signal, randomUUID());
      const snapshot = await target.client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => (
        event.type === "snapshot.updated" && event.snapshot.conversations.some(({ title, worktreePath }) => title === "Recovered chat" && worktreePath !== null)
      ));
      const chat = snapshot.snapshot.conversations.find(({ title }) => title === "Recovered chat")!;
      expect(chat.worktreePath!.startsWith(join(root, "target", "scratch"))).toBe(true);
      expect(snapshot.snapshot.projects.filter(({ workspaceKind }) => workspaceKind === "scratch")).toHaveLength(1);
      const listed = await target.request({ type: "workspace.entries", payload: { projectId: chat.projectId, conversationId: chat.id } });
      expect(listed.result.kind).toBe("workspace.entries");
    } finally {
      await target.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("creates a managed chat through the runtime boundary and only lists its own files", async () => {
  const { root, client, request, close } = await startScratchRuntime("inertia-scratch-runtime-");
  try {
    const created = await request({ type: "project.ensure-scratch", payload: {} });
    expect(created.result.kind).toBe("project.created");
    if (created.result.kind !== "project.created") throw new Error("Missing project");
    const projectId = created.result.projectId;
    const first = await request({ type: "conversation.create", payload: { projectId, title: "First scratch chat", activate: false, useWorktree: true } });
    if (first.result.kind !== "conversation.created") throw new Error("Missing chat");
    const conversationId = first.result.conversationId;
    const snapshot = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated" && event.snapshot.conversations.some(({ id }) => id === conversationId));
    const conversation = snapshot.snapshot.conversations.find(({ id }) => id === conversationId)!;
    expect(conversation.worktreePath).toContain(join("data", "scratch"));
    writeFileSync(join(conversation.worktreePath!, "own-notes.txt"), "my notes");
    writeFileSync(join(root, "data", "scratch", "not-this-chat.txt"), "container content");
    const files = await request({ type: "workspace.entries", payload: { projectId, conversationId: conversation.id } });
    expect(JSON.stringify(files.result)).toContain("own-notes.txt");
    expect(JSON.stringify(files.result)).not.toContain("not-this-chat.txt");
    await expect(request({ type: "workspace.entries", payload: { projectId } })).rejects.toThrow("Choose a chat");
    await expect(request({ type: "conversation.create", payload: { projectId, title: "Reuse", worktreePath: conversation.worktreePath, activate: false } })).rejects.toThrow("cannot reuse");
  } finally {
    await close();
  }
});

it("refuses project management commands that would remove, rename or duplicate the managed folder", async () => {
  const { root, client, request, mutate, close } = await startScratchRuntime("inertia-scratch-guards-");
  try {
    const created = await request({ type: "project.ensure-scratch", payload: {} });
    if (created.result.kind !== "project.created") throw new Error("Missing project");
    const projectId = created.result.projectId;
    const chat = await request({ type: "conversation.create", payload: { projectId, title: "Keep me", activate: false } });
    if (chat.result.kind !== "conversation.created") throw new Error("Missing chat");
    const conversationId = chat.result.conversationId;
    const snapshot = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated" && event.snapshot.conversations.some(({ id }) => id === conversationId));
    const folder = snapshot.snapshot.conversations.find(({ id }) => id === conversationId)!.worktreePath!;
    const scratchRoot = join(root, "data", "scratch");
    await expect(mutate({ type: "project.remove", payload: { projectId } })).rejects.toThrow("Delete chats without a project one at a time.");
    await expect(mutate({ type: "project.update", payload: { projectId, name: "Renamed" } })).rejects.toThrow("Chats without a project have no project settings.");
    const cased = join(root, "data", "SCRATCH");
    const spellings = existsSync(cased) ? [cased, join(cased, basename(folder).toUpperCase())] : [];
    for (const path of [scratchRoot, folder, ...spellings]) {
      await expect(request({ type: "project.create", payload: { name: "Duplicate", path } })).rejects.toThrow("Inertia manages this folder for chats without a project.");
    }
    const after = await request({ type: "conversation.create", payload: { projectId, title: "Still works", activate: false } });
    expect(after.result.kind).toBe("conversation.created");
    const latest = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated" && event.snapshot.conversations.length === 2);
    expect(latest.snapshot.conversations.map(({ id }) => id)).toContain(conversationId);
    expect(latest.snapshot.projects.filter(({ name }) => name === "Duplicate")).toEqual([]);
    expect(latest.snapshot.projects.find(({ id }) => id === projectId)).toMatchObject({ name: "No project", workspaceKind: "scratch" });
  } finally {
    await close();
  }
});

it("opens or reveals only the chosen chat's own folder for chats without a project", async () => {
  const { runtime, client, request, close } = await startScratchRuntime("inertia-scratch-open-");
  try {
    const created = await request({ type: "project.ensure-scratch", payload: {} });
    if (created.result.kind !== "project.created") throw new Error("Missing project");
    const projectId = created.result.projectId;
    const chats = [];
    for (const title of ["Chat A", "Chat B"]) {
      const chat = await request({ type: "conversation.create", payload: { projectId, title, activate: false } });
      if (chat.result.kind !== "conversation.created") throw new Error("Missing chat");
      const conversationId = chat.result.conversationId;
      const snapshot = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated" && event.snapshot.conversations.some(({ id }) => id === conversationId));
      chats.push(snapshot.snapshot.conversations.find(({ id }) => id === conversationId)!);
    }
    const [a, b] = chats as [typeof chats[number], typeof chats[number]];
    writeFileSync(join(b.worktreePath!, "secret.txt"), "b only");
    await expect(runtime.resolveProjectPath({ projectId, relativePath: ".", action: "reveal" })).rejects.toThrow("Choose a chat");
    await expect(runtime.resolveProjectPath({ projectId, relativePath: `${basename(b.worktreePath!)}/secret.txt`, action: "open-externally" })).rejects.toThrow("Choose a chat");
    await expect(runtime.resolveProjectPath({ projectId, conversationId: a.id, relativePath: `../${basename(b.worktreePath!)}/secret.txt`, action: "open-externally" })).rejects.toThrow();
    await expect(runtime.resolveProjectPath({ projectId, conversationId: b.id, relativePath: "secret.txt", action: "open-externally" }))
      .resolves.toBe(join(realpathSync(b.worktreePath!), "secret.txt"));
  } finally {
    await close();
  }
});

it("deletes a chat through the runtime command without Git checkpoint cleanup and keeps its folder", async () => {
  const { client, request, mutate, close } = await startScratchRuntime("inertia-scratch-delete-");
  try {
    const created = await request({ type: "project.ensure-scratch", payload: {} });
    if (created.result.kind !== "project.created") throw new Error("Missing project");
    const projectId = created.result.projectId;
    const chat = await request({ type: "conversation.create", payload: { projectId, title: "Delete me", activate: false } });
    if (chat.result.kind !== "conversation.created") throw new Error("Missing chat");
    const conversationId = chat.result.conversationId;
    const snapshot = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated" && event.snapshot.conversations.some(({ id }) => id === conversationId));
    const folder = snapshot.snapshot.conversations.find(({ id }) => id === conversationId)!.worktreePath!;
    writeFileSync(join(folder, "notes.txt"), "keep these notes");
    vi.mocked(deleteCheckpoints).mockClear();
    await mutate({ type: "conversation.delete", payload: { conversationId } });
    const latest = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated" && !event.snapshot.conversations.some(({ id }) => id === conversationId));
    expect(latest.snapshot.projects.some(({ id }) => id === projectId)).toBe(true);
    expect(readFileSync(join(folder, "notes.txt"), "utf8")).toBe("keep these notes");
    expect(deleteCheckpoints).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});


it("refuses a real inherited Git checkout instead of sharing its repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-scratch-git-"));
  execFileSync("git", ["init", "--quiet", root]);
  const data = join(root, "data");
  mkdirSync(data);
  const store = new RuntimeStore(join(data, "inertia.sqlite"), root);
  try {
    await expect(new ScratchWorkspace(store, data).ensureProject()).rejects.toThrow("outside a Git repository");
    expect(store.shellSnapshot().projects).toEqual([]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
