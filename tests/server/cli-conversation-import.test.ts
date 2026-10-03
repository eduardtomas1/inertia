// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliConversationDiscovery, CLI_TRANSCRIPT_MAX_BYTES } from "../../src/server/cli-import/discovery";
import { RuntimeStore } from "../../src/server/database";
import { createCliConversationCommandHandler } from "../../src/server/runtime/commands/cli-conversation-commands";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import type { ProviderManager } from "../../src/server/providers";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

const directories: string[] = [];
const stores: RuntimeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inertia-cli-import-")); directories.push(root);
  const workspace = join(root, "project"); const other = join(root, "other"); const sessions = join(root, "sessions");
  await Promise.all([workspace, other, sessions].map((path) => mkdir(path)));
  const sessionId = randomUUID(); const file = join(sessions, `rollout-${sessionId}.jsonl`);
  const content = (cwd = workspace, text = "Continue the sidebar work") => [
    { type: "session_meta", payload: { id: sessionId, cwd, model_provider: "openai" } },
    { type: "response_item", timestamp: "2026-09-25T10:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
  ].map((item) => JSON.stringify(item)).join("\n");
  await writeFile(file, content());
  const discovery = new CliConversationDiscovery([{ providerId: "codex", path: sessions }], []);
  return { root, workspace, other, sessions, sessionId, file, content, discovery };
}

describe("CLI conversation import authority and persistence", () => {
  it("discovers only the enrolled checkout and rejects cross-project, expired and forged candidates", async () => {
    const f = await fixture();
    await writeFile(join(f.sessions, "other.jsonl"), f.content(f.other));
    await writeFile(join(f.sessions, "broken.jsonl"), "invalid\n");
    const scan = await f.discovery.scan("project", f.workspace, () => null);
    expect(scan.candidates).toHaveLength(1); expect(scan.skipped).toBe(1);
    const id = scan.candidates[0]!.id;
    const read = await f.discovery.read("project", f.workspace, id);
    expect(read.transcript.sessionId).toBe(f.sessionId);
    await expect(f.discovery.read("wrong-project", f.workspace, id)).rejects.toThrow(/expired/u);
    await expect(f.discovery.read("project", f.other, id)).rejects.toThrow(/changed/u);
    await expect(f.discovery.read("project", f.workspace, "../../file")).rejects.toThrow(/expired/u);
    await f.discovery.scan("project", f.workspace, () => null);
    await expect(f.discovery.read("project", f.workspace, id)).rejects.toThrow(/expired/u);
  });
  it.skipIf(process.platform === "win32")("refuses file and directory symlinks and a symlink swapped in after scanning", async () => {
    const f = await fixture();
    await symlink(f.file, join(f.sessions, "linked.jsonl"));
    await symlink(f.other, join(f.sessions, "linked-directory"), "dir");
    await writeFile(join(f.other, "hidden.jsonl"), f.content());
    const scan = await f.discovery.scan("project", f.workspace, () => null);
    expect(scan.candidates).toHaveLength(1);
    await rm(f.file); await symlink(join(f.other, "hidden.jsonl"), f.file);
    await expect(f.discovery.read("project", f.workspace, scan.candidates[0]!.id)).rejects.toThrow(/no longer readable/u);
  });
  it("skips oversized files and cancels scans without publishing candidates", async () => {
    const f = await fixture();
    await truncate(f.file, CLI_TRANSCRIPT_MAX_BYTES + 1);
    expect(await f.discovery.scan("project", f.workspace, () => null)).toMatchObject({ candidates: [], skipped: 1 });
    const controller = new AbortController(); controller.abort();
    const discovery = new CliConversationDiscovery([{ providerId: "codex", path: f.sessions }], [], controller.signal);
    await expect(discovery.scan("project", f.workspace, () => null)).rejects.toThrow();
  });
  it.each(["codex", "claude"] as const)("imports %s atomically, retains native resume identity and deduplicates after restart", async (providerId) => {
    const f = await fixture(); const dbPath = join(f.root, "inertia.sqlite");
    let store = new RuntimeStore(dbPath, f.workspace); stores.push(store);
    const project = store.createProject("Studio", f.workspace);
    const selection = providerNativeModelSelection({ providerId });
    const identity = continuationIdentityForSelection(selection, "native-fixture");
    const input = { projectId: project.id, sourceKey: "a".repeat(64), providerId, sessionId: f.sessionId, title: "CLI session", messages: [{ role: "user" as const, content: "Earlier work", createdAt: "2099-09-25T10:00:00.000Z" }, { role: "assistant" as const, content: "Preserved order", createdAt: "2026-09-25T10:00:00.000Z" }, { role: "user" as const, content: "Same timestamp", createdAt: "2026-09-25T10:00:00.000Z" }], omittedMessages: 0, selection, continuationIdentity: identity };
    const previous = store.shellSnapshot().activeConversationId;
    const conversationId = store.importCliConversation(input);
    expect(store.conversation(conversationId)).toMatchObject({ projectId: project.id, providerId, providerSessionId: f.sessionId, continuationIdentity: identity, accessMode: "supervised", interactionMode: "build" });
    expect(store.shellSnapshot().activeConversationId).toBe(previous);
    expect(store.conversationHistory(conversationId)!.messages.map((message) => message.content)).toEqual(["Earlier work", "Preserved order", "Same timestamp", expect.stringContaining("original native session")]);
    expect(store.importCliConversation(input)).toBe(conversationId);
    // A provider may replace its current session ID; the original import receipt remains authoritative.
    store.updateConversation(conversationId, { providerSessionId: randomUUID() });
    store.close(); stores.pop(); store = new RuntimeStore(dbPath, f.workspace); stores.push(store);
    expect(store.importCliConversation(input)).toBe(conversationId);
    expect(store.importedCliConversation(providerId, f.sessionId)).toBe(conversationId);
    const count = store.shellSnapshot().conversations.length;
    expect(() => store.importCliConversation({ ...input, sessionId: randomUUID(), sourceKey: "invalid" })).toThrow();
    expect(store.shellSnapshot().conversations).toHaveLength(count);
    expect(await readFile(f.file, "utf8")).toBe(f.content());
  });
  it("rechecks preview revision at commit and makes command retries idempotent", async () => {
    const f = await fixture(); const store = new RuntimeStore(join(f.root, "inertia.sqlite"), f.workspace); stores.push(store);
    const project = store.createProject("Studio", f.workspace); const send = vi.fn(); const broadcastSnapshot = vi.fn();
    const providers = { resolveModelRoute: (selection: Parameters<ProviderManager["resolveModelRoute"]>[0]) => ({ continuationIdentity: continuationIdentityForSelection(selection, "native-fixture") }) } as Pick<ProviderManager, "resolveModelRoute">;
    const handler = createCliConversationCommandHandler({ store, providers, discovery: f.discovery, send, broadcastSnapshot });
    const call = async (command: ClientCommand) => { await handler({} as WebSocket, command); return send.mock.lastCall?.[1] as ServerEvent; };
    const candidate = (await f.discovery.scan(project.id, f.workspace, () => null)).candidates[0]!;
    const preview = await call({ type: "conversation.cli.preview", requestId: "preview", payload: { projectId: project.id, candidateId: candidate.id } });
    if (preview.type !== "request.result" || preview.result.kind !== "conversation.cli.preview") throw new Error("Missing preview");
    const command: ClientCommand = { type: "conversation.cli.import", requestId: "import", payload: { projectId: project.id, candidateId: candidate.id, revision: preview.result.preview.revision } };
    await writeFile(f.file, f.content(f.workspace, "Changed after preview"));
    await expect(call(command)).rejects.toThrow(/changed since your preview/u);
    expect(broadcastSnapshot).not.toHaveBeenCalled();
    await writeFile(f.file, f.content());
    const first = await call(command); const retry = await call(command);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ type: "request.result", result: { kind: "conversation.cli.imported" } });
    expect(store.shellSnapshot().conversations.filter((conversation) => conversation.providerSessionId === f.sessionId)).toHaveLength(1);
  });
  it("refuses to scan or import into the folder for chats without a project", async () => {
    const f = await fixture(); const store = new RuntimeStore(join(f.root, "inertia.sqlite"), f.workspace); stores.push(store);
    const scratch = await new ScratchWorkspace(store, f.root).ensureProject();
    await writeFile(f.file, f.content(scratch.path));
    const send = vi.fn(); const broadcastSnapshot = vi.fn();
    const providers = { resolveModelRoute: (selection: Parameters<ProviderManager["resolveModelRoute"]>[0]) => ({ continuationIdentity: continuationIdentityForSelection(selection, "native-fixture") }) } as Pick<ProviderManager, "resolveModelRoute">;
    const handler = createCliConversationCommandHandler({ store, providers, discovery: f.discovery, send, broadcastSnapshot });
    const candidate = (await f.discovery.scan(scratch.id, scratch.path, () => null)).candidates[0]!;
    for (const command of [
      { type: "conversation.cli.scan", requestId: "scan", payload: { projectId: scratch.id } },
      { type: "conversation.cli.import", requestId: "import", payload: { projectId: scratch.id, candidateId: candidate.id, revision: "a".repeat(64) } },
    ] satisfies ClientCommand[]) {
      await expect(handler({} as WebSocket, command)).rejects.toThrow("Chats without a project cannot import CLI conversations.");
    }
    expect(send).not.toHaveBeenCalled();
    expect(broadcastSnapshot).not.toHaveBeenCalled();
    expect(store.shellSnapshot().conversations).toEqual([]);
  });
});
