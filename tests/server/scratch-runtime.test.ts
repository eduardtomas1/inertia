import { execFileSync } from "node:child_process";
import { RuntimeStore } from "../../src/server/database";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { startTestRuntime } from "../support/test-runtime";
import { connectRuntime } from "../support/runtime-event-queue";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends ClientCommand ? Omit<Command, "requestId"> : never : never;

async function startScratchRuntime(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const runtime = await startTestRuntime({ dataDirectory: join(root, "data"), defaultWorkspacePath: workspace,
    enableProviders: false, runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
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
  const close = async (): Promise<void> => {
    client.socket.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, client, request, mutate, close };
}

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
    for (const path of [scratchRoot, folder]) {
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
