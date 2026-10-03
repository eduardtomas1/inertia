// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CliConversationDiscovery, CLI_TRANSCRIPT_MAX_BYTES, cliConversationRoots, type CliScanLimits } from "../../src/server/cli-import/discovery";
import { providerChildEnvironment } from "../../src/server/environment";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { RuntimeStore } from "../../src/server/database";
import { createCliConversationCommandHandler } from "../../src/server/runtime/commands/cli-conversation-commands";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import { cliConversationScanSchema } from "../../src/shared/cli-conversations";
import type { ProviderManager } from "../../src/server/providers";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { claudeSuccessResult, claudeSystem, CLAUDE_PROTOCOL_SESSION_ID, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises } from "../support/turn-controller-runtime";
import { nativeProviderRunInput } from "./model-route-fixture";

const directories: string[] = [];
const unowned = () => ({ importedConversationId: null, owned: false });
const stores: RuntimeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); await cleanupTurnControllerTestDirectories(); });
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
  const claudeRoot = join(root, "claude", "projects");
  const claude = async (directory: string, cwd: string, id = randomUUID(), text = "Plan the Claude work"): Promise<string> => {
    await mkdir(join(claudeRoot, directory), { recursive: true });
    const path = join(claudeRoot, directory, `${id}.jsonl`);
    await writeFile(path, JSON.stringify({ type: "user", uuid: randomUUID(), parentUuid: null, sessionId: id, cwd, timestamp: "2026-09-25T11:00:00.000Z", message: { role: "user", content: text } }) + "\n");
    return path;
  };
  const both = (limits: Partial<CliScanLimits> = {}) => new CliConversationDiscovery([{ providerId: "codex", path: sessions }, { providerId: "claude", path: claudeRoot }], [], undefined, limits);
  return { root, workspace, other, sessions, sessionId, file, content, discovery, claudeRoot, claude, both };
}
async function rollouts(f: Awaited<ReturnType<typeof fixture>>, count: number, cwd: string, padding = 0): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    await writeFile(join(f.sessions, `rollout-${id}.jsonl`), [
      JSON.stringify({ type: "session_meta", payload: { id, cwd, model_provider: "openai" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Other ${index} ${"x".repeat(padding)}` }] } }),
    ].join("\n"));
  }
}

describe("CLI conversation import authority and persistence", () => {
  it("discovers only the enrolled checkout and rejects cross-project, expired and forged candidates", async () => {
    const f = await fixture();
    await writeFile(join(f.sessions, "other.jsonl"), f.content(f.other));
    await writeFile(join(f.sessions, "broken.jsonl"), "invalid\n");
    const scan = await f.discovery.scan("project", f.workspace, unowned);
    expect(scan.candidates).toHaveLength(1); expect(scan.skipped).toBe(0);
    const id = scan.candidates[0]!.id;
    const read = await f.discovery.read("project", f.workspace, id);
    expect(read.transcript.sessionId).toBe(f.sessionId);
    await expect(f.discovery.read("wrong-project", f.workspace, id)).rejects.toThrow(/expired/u);
    await expect(f.discovery.read("project", f.other, id)).rejects.toThrow(/changed/u);
    await expect(f.discovery.read("project", f.workspace, "../../file")).rejects.toThrow(/expired/u);
    await f.discovery.scan("project", f.workspace, unowned);
    await expect(f.discovery.read("project", f.workspace, id)).rejects.toThrow(/expired/u);
  });
  it.skipIf(process.platform === "win32")("refuses file and directory symlinks and a symlink swapped in after scanning", async () => {
    const f = await fixture();
    await symlink(f.file, join(f.sessions, "linked.jsonl"));
    await symlink(f.other, join(f.sessions, "linked-directory"), "dir");
    await writeFile(join(f.other, "hidden.jsonl"), f.content());
    const scan = await f.discovery.scan("project", f.workspace, unowned);
    expect(scan.candidates).toHaveLength(1);
    await rm(f.file); await symlink(join(f.other, "hidden.jsonl"), f.file);
    await expect(f.discovery.read("project", f.workspace, scan.candidates[0]!.id)).rejects.toThrow(/no longer readable/u);
  });
  it("skips oversized files and cancels scans without publishing candidates", async () => {
    const f = await fixture();
    await truncate(f.file, CLI_TRANSCRIPT_MAX_BYTES + 1);
    expect(await f.discovery.scan("project", f.workspace, unowned)).toMatchObject({ candidates: [], skipped: 1 });
    const controller = new AbortController(); controller.abort();
    const discovery = new CliConversationDiscovery([{ providerId: "codex", path: f.sessions }], [], controller.signal);
    await expect(discovery.scan("project", f.workspace, unowned)).rejects.toThrow();
  });
  it.each(["codex", "claude"] as const)("imports %s atomically, retains native resume identity and deduplicates after restart", async (providerId) => {
    const f = await fixture(); const dbPath = join(f.root, "inertia.sqlite");
    let store = new RuntimeStore(dbPath, f.workspace); stores.push(store);
    const project = store.createProject("Studio", f.workspace);
    const selection = providerNativeModelSelection({ providerId });
    const identity = continuationIdentityForSelection(selection, "native-fixture");
    const input = { projectId: project.id, sourceKey: "a".repeat(64), providerId, sessionId: f.sessionId, cwd: f.workspace, title: "CLI session", messages: [{ role: "user" as const, content: "Earlier work", createdAt: "2099-09-25T10:00:00.000Z" }, { role: "assistant" as const, content: "Preserved order", createdAt: "2026-09-25T10:00:00.000Z" }, { role: "user" as const, content: "Same timestamp", createdAt: "2026-09-25T10:00:00.000Z" }], selection, continuationIdentity: identity };
    const previous = store.shellSnapshot().activeConversationId;
    const conversationId = store.importCliConversation(input);
    expect(store.conversation(conversationId)).toMatchObject({ projectId: project.id, providerId, providerSessionId: f.sessionId, continuationIdentity: identity, accessMode: "supervised", interactionMode: "build" });
    expect(store.shellSnapshot().activeConversationId).toBe(previous);
    expect(store.conversationHistory(conversationId)!.messages.map((message) => [message.role, message.content])).toEqual([["user", "Earlier work"], ["assistant", "Preserved order"], ["user", "Same timestamp"]]);
    expect(store.importCliConversation(input)).toBe(conversationId);
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
    const candidate = (await f.discovery.scan(project.id, f.workspace, unowned)).candidates[0]!;
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
    const candidate = (await f.discovery.scan(scratch.id, scratch.path, unowned)).candidates[0]!;
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
  it("counts only this project's unreadable or oversized files as skipped", async () => {
    const f = await fixture();
    await writeFile(join(f.sessions, "other-broken.jsonl"), `${f.content(f.other)}\n{broken\n{}`);
    await writeFile(join(f.sessions, "other-large.jsonl"), f.content(f.other)); await truncate(join(f.sessions, "other-large.jsonl"), CLI_TRANSCRIPT_MAX_BYTES + 1);
    await writeFile(join(f.sessions, "missing-folder.jsonl"), f.content(join(f.root, "deleted")) + "\n{broken\n{}");
    await writeFile(join(f.sessions, "headerless.jsonl"), "invalid\n");
    expect(await f.discovery.scan("project", f.workspace, unowned)).toMatchObject({ candidates: [{ providerId: "codex" }], skipped: 0, oversized: 0 });
    await writeFile(join(f.sessions, "own-broken.jsonl"), `${f.content()}\n{broken\n{}`);
    await writeFile(join(f.sessions, "own-large.jsonl"), f.content()); await truncate(join(f.sessions, "own-large.jsonl"), CLI_TRANSCRIPT_MAX_BYTES + 1);
    expect(await f.discovery.scan("project", f.workspace, unowned)).toMatchObject({ candidates: [{ providerId: "codex" }], skipped: 2, oversized: 1 });
  });
  it("gives each provider its own scan budget so a large Codex history cannot hide Claude conversations", async () => {
    const f = await fixture();
    await rm(f.file);
    await rollouts(f, 6, f.other);
    await f.claude("project", f.workspace);
    const scan = await f.both({ entries: 4 }).scan("project", f.workspace, unowned);
    expect(scan.limited).toBe(true);
    expect(scan.candidates.map(({ providerId, opening }) => [providerId, opening])).toEqual([["claude", { user: "Plan the Claude work", assistant: null }]]);
    await f.claude("project", f.workspace, randomUUID(), "Second Claude session");
    const budgeted = await f.both({ bytes: 1 }).scan("project", f.workspace, unowned);
    expect(budgeted.limited).toBe(true);
    expect(budgeted.candidates.map(({ providerId }) => providerId)).toEqual(["claude"]);
  });
  it("learns a rollout's folder from its header instead of reading other projects' rollouts in full", async () => {
    const f = await fixture();
    await utimes(f.file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await rollouts(f, 3, f.other, 2 * 1024 * 1024);
    const scan = await f.both({ bytes: 1024 * 1024 }).scan("project", f.workspace, unowned);
    expect(scan).toMatchObject({ limited: false, skipped: 0, candidates: [{ providerId: "codex", opening: { user: "Continue the sidebar work", assistant: null } }] });
    expect(cliConversationScanSchema.parse(scan)).toEqual(scan);
  });
  it("walks Claude session folders newest first", async () => {
    const f = await fixture();
    await f.claude("a-older", f.workspace, randomUUID(), "Older session");
    await f.claude("z-newer", f.workspace, randomUUID(), "Newer session");
    await utimes(join(f.claudeRoot, "a-older"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await utimes(join(f.claudeRoot, "z-newer"), new Date("2026-09-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
    const discovery = new CliConversationDiscovery([{ providerId: "claude", path: f.claudeRoot }], [], undefined, { entries: 3 });
    const scan = await discovery.scan("project", f.workspace, unowned);
    expect(scan.limited).toBe(true);
    expect(scan.candidates.map(({ title }) => title)).toEqual(["Newer session"]);
  });
  it.skipIf(process.platform === "win32")("matches Claude sessions to a symlinked checkout by real path in both directions", async () => {
    const f = await fixture();
    const link = join(f.root, "project-link");
    await symlink(f.workspace, link, "dir");
    await f.claude("via-link", link, randomUUID(), "Started through the link");
    await f.claude("via-real", f.workspace, randomUUID(), "Started in the real folder");
    const discovery = new CliConversationDiscovery([{ providerId: "claude", path: f.claudeRoot }], []);
    for (const workspace of [f.workspace, link]) {
      const scan = await discovery.scan("project", workspace, unowned);
      expect(scan.candidates.map(({ title }) => title).sort()).toEqual(["Started in the real folder", "Started through the link"]);
      await expect(discovery.read("project", workspace, scan.candidates[0]!.id)).resolves.toMatchObject({ providerId: "claude" });
    }
  });
  it("joins a duplicate scan request and serializes scans for other projects instead of failing", async () => {
    const f = await fixture();
    await f.claude("other", f.other);
    const discovery = f.both();
    const [first, duplicate, other] = await Promise.all([
      discovery.scan("project", f.workspace, unowned),
      discovery.scan("project", f.workspace, unowned),
      discovery.scan("other", f.other, unowned),
    ]);
    expect(duplicate).toBe(first);
    expect(first.candidates.map(({ providerId }) => providerId)).toEqual(["codex"]);
    expect(other.candidates.map(({ providerId }) => providerId)).toEqual(["claude"]);
    await expect(discovery.read("project", f.workspace, first.candidates[0]!.id)).resolves.toMatchObject({ providerId: "codex" });
    await expect(discovery.read("other", f.other, other.candidates[0]!.id)).resolves.toMatchObject({ providerId: "claude" });
  });
  it("resumes an imported Claude session with the configuration folder it was scanned from", async () => {
    const f = await fixture();
    const configDirectory = join(f.root, "claude");
    const roots = cliConversationRoots({ CLAUDE_CONFIG_DIR: configDirectory }).filter(({ providerId }) => providerId === "claude");
    expect(roots).toEqual([{ providerId: "claude", path: f.claudeRoot }]);
    await f.claude("project", f.workspace, CLAUDE_PROTOCOL_SESSION_ID);
    const discovery = new CliConversationDiscovery(roots, []);
    const candidate = (await discovery.scan("project", f.workspace, unowned)).candidates[0]!;
    const sessionId = (await discovery.read("project", f.workspace, candidate.id)).transcript.sessionId;
    const options: Array<Record<string, unknown>> = [];
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options: queryOptions }) => {
        options.push(queryOptions as Record<string, unknown>);
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> { yield claudeSystem("init"); yield claudeSuccessResult("Continued"); })());
      },
    });
    const environment = providerChildEnvironment("claude", { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configDirectory, GITHUB_TOKEN: "unrelated" });
    const run = harness.start({
      input: nativeProviderRunInput({ providerId: "claude", conversationId: "imported-claude", cwd: f.workspace, prompt: "Continue.", interactionMode: "build", access: "supervised", sessionId }),
      executable: process.execPath, environment, providerNativeToolsAvailable: true,
    });
    await run.result;
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ resume: sessionId, env: expect.objectContaining({ CLAUDE_CONFIG_DIR: configDirectory }) });
    expect(options[0]!.env).not.toHaveProperty("GITHUB_TOKEN");
  });
  it.each(["codex", "claude"] as const)("fails an imported %s chat closed when its native session is gone", async (providerId) => {
    const runtime = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId, modelId: "provider-default" }) });
    try {
      const sessionId = randomUUID();
      const selection = providerNativeModelSelection({ providerId });
      const continuationIdentity = runtime.provider.resolveModelRoute(selection).continuationIdentity;
      const conversationId = runtime.store.importCliConversation({ projectId: runtime.store.conversation(runtime.conversationId).projectId, sourceKey: "b".repeat(64), providerId, sessionId, cwd: runtime.store.conversationPath(runtime.conversationId), title: "Imported", messages: [{ role: "user", content: "Earlier work", createdAt: "2026-09-25T10:00:00.000Z" }], selection, continuationIdentity });
      const unavailable = { reason: "provider-error", message: "The saved provider session is no longer available.", sessionUnavailable: true } as const;
      const label = providerId === "codex" ? "Codex" : "Claude Code";
      for (const content of ["Continue.", "Try again."]) {
        const queued = runtime.controller.queue({ conversationId, content });
        expect(queued.turn).toMatchObject({ providerSessionBefore: sessionId, continuationReasonCode: "same-continuation" });
        runtime.controller.start(queued.turn.id);
        expect(runtime.provider.input?.sessionId).toBe(sessionId);
        expect(runtime.provider.callbacks!.freshSessionFallback!()).toBeNull();
        runtime.provider.resolve({ status: "failed", sessionId, error: unavailable.message, failure: unavailable });
        await flushTurnControllerTestPromises();
        expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({ status: "failed", providerSessionBefore: sessionId, providerSessionAfter: sessionId });
        const errors = (runtime.store.conversationDetail(conversationId)?.activities ?? []).filter(({ kind, turnId }) => kind === "error" && turnId === queued.turn.id);
        expect(errors).toEqual([expect.objectContaining({ title: `The original ${label} session for this imported chat is no longer available.` })]);
        expect(runtime.store.conversation(conversationId)).toMatchObject({ providerSessionId: sessionId, continuationIdentity });
        expect(runtime.store.importedCliConversation(providerId, sessionId)).toBe(conversationId);
      }
      expect(runtime.controller.queue({ conversationId, content: "Once more." }).turn).toMatchObject({ providerSessionBefore: sessionId, continuationReasonCode: "same-continuation" });
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
  it("lists imported sessions with their chat, hides sessions Inertia already owns, and records the transcript's cwd", async () => {
    const f = await fixture(); const store = new RuntimeStore(join(f.root, "inertia.sqlite"), f.workspace); stores.push(store);
    const project = store.createProject("Studio", f.workspace); const send = vi.fn();
    const providers = { resolveModelRoute: (selection: Parameters<ProviderManager["resolveModelRoute"]>[0]) => ({ continuationIdentity: continuationIdentityForSelection(selection, "native-fixture") }) } as Pick<ProviderManager, "resolveModelRoute">;
    const handler = createCliConversationCommandHandler({ store, providers, discovery: f.discovery, send, broadcastSnapshot: vi.fn() });
    const call = async (command: ClientCommand) => { await handler({} as WebSocket, command); const event = send.mock.lastCall?.[1] as ServerEvent; if (event.type !== "request.result") throw new Error("Missing result"); return event.result; };
    const ownedId = randomUUID();
    await writeFile(join(f.sessions, "owned.jsonl"), [JSON.stringify({ type: "session_meta", payload: { id: ownedId, cwd: f.workspace, model_provider: "openai" } }), JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inertia's own chat" }] } })].join("\n"));
    const own = store.createConversation(project.id, "Native chat", { providerId: "codex", model: "gpt-test", reasoningEffort: "high" });
    store.updateConversation(own.id, { providerSessionId: ownedId });
    const scan = await call({ type: "conversation.cli.scan", requestId: "scan", payload: { projectId: project.id } });
    if (scan.kind !== "conversation.cli.scan") throw new Error("Missing scan");
    expect(scan.scan.candidates.map(({ title, importedConversationId }) => [title, importedConversationId])).toEqual([["Continue the sidebar work", null]]);
    const preview = await call({ type: "conversation.cli.preview", requestId: "preview", payload: { projectId: project.id, candidateId: scan.scan.candidates[0]!.id } });
    if (preview.kind !== "conversation.cli.preview") throw new Error("Missing preview");
    const imported = await call({ type: "conversation.cli.import", requestId: "import", payload: { projectId: project.id, candidateId: scan.scan.candidates[0]!.id, revision: preview.preview.revision } });
    if (imported.kind !== "conversation.cli.imported") throw new Error("Missing import");
    expect(store.cliConversationImport(imported.conversationId)).toEqual({ providerId: "codex", cwd: f.workspace });
    const rescan = await call({ type: "conversation.cli.scan", requestId: "rescan", payload: { projectId: project.id } });
    if (rescan.kind !== "conversation.cli.scan") throw new Error("Missing scan");
    expect(rescan.scan.candidates.map(({ importedConversationId }) => importedConversationId)).toEqual([imported.conversationId]);
    const again = await call({ type: "conversation.cli.preview", requestId: "again", payload: { projectId: project.id, candidateId: rescan.scan.candidates[0]!.id } });
    if (again.kind !== "conversation.cli.preview") throw new Error("Missing preview");
    expect(again.preview.candidate.importedConversationId).toBe(imported.conversationId);
  });
  it("skips Codex subagent rollouts from their header without reading them in full or counting them", async () => {
    const f = await fixture();
    await utimes(f.file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    for (let index = 0; index < 3; index += 1) {
      const id = randomUUID();
      await writeFile(join(f.sessions, `rollout-${id}.jsonl`), [
        JSON.stringify({ type: "session_meta", payload: { id, cwd: f.workspace, model_provider: "openai", source: { subagent: { thread_spawn: { parent_thread_id: f.sessionId } } } } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(2 * 1024 * 1024) }] } }),
      ].join("\n"));
    }
    const scan = await f.both({ bytes: 1024 * 1024 }).scan("project", f.workspace, unowned);
    expect(scan).toMatchObject({ limited: false, skipped: 0, oversized: 0, candidates: [{ title: "Continue the sidebar work" }] });
  });
  it("finds archived Codex sessions under the same budget", async () => {
    const f = await fixture();
    const codexHome = join(f.root, "codex-home");
    const roots = cliConversationRoots({ CODEX_HOME: codexHome }).filter(({ providerId }) => providerId === "codex");
    expect(roots.map(({ path }) => path)).toEqual([join(codexHome, "sessions"), join(codexHome, "archived_sessions")]);
    await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
    await writeFile(join(codexHome, "archived_sessions", `rollout-${f.sessionId}.jsonl`), f.content(f.workspace, "Archived work"));
    const discovery = new CliConversationDiscovery(roots, []);
    const scan = await discovery.scan("project", f.workspace, unowned);
    expect(scan.candidates.map(({ title }) => title)).toEqual(["Archived work"]);
    await expect(discovery.read("project", f.workspace, scan.candidates[0]!.id)).resolves.toMatchObject({ providerId: "codex" });
    expect((await new CliConversationDiscovery(roots, [], undefined, { entries: 0 }).scan("project", f.workspace, unowned)).candidates).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("resumes an imported Claude session under the cwd spelling it was recorded with", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }) });
    try {
      const checkout = runtime.store.conversationPath(runtime.conversationId);
      const link = `${checkout}-link`;
      await symlink(checkout, link, "dir");
      const selection = providerNativeModelSelection({ providerId: "claude" });
      const continuationIdentity = runtime.provider.resolveModelRoute(selection).continuationIdentity;
      const projectId = runtime.store.conversation(runtime.conversationId).projectId;
      const importChat = (cwd: string) => runtime.store.importCliConversation({ projectId, sourceKey: randomUUID().replaceAll("-", "").padEnd(64, "0"), providerId: "claude", sessionId: randomUUID(), cwd, title: "Imported", messages: [{ role: "user", content: "Earlier", createdAt: "2026-09-25T10:00:00.000Z" }], selection, continuationIdentity });
      const cwdFor = async (conversationId: string) => {
        const queued = runtime.controller.queue({ conversationId, content: "Continue." });
        runtime.controller.start(queued.turn.id);
        const cwd = runtime.provider.input?.cwd;
        runtime.provider.resolve({ status: "completed", sessionId: runtime.provider.input!.sessionId!, text: "" });
        await flushTurnControllerTestPromises();
        return cwd;
      };
      expect(await cwdFor(importChat(link))).toBe(link);
      expect(await cwdFor(importChat(join(runtime.store.conversationPath(runtime.conversationId), "..", "elsewhere")))).toBe(checkout);
      const stale = importChat(`${checkout}-gone`);
      expect(await cwdFor(stale)).toBe(checkout);
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
  it("keeps header reads on their own byte budget so large headers do not limit the scan", async () => {
    const f = await fixture();
    await utimes(f.file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    for (let index = 0; index < 12; index += 1) {
      const id = randomUUID();
      await writeFile(join(f.sessions, `rollout-${id}.jsonl`), [
        JSON.stringify({ type: "session_meta", payload: { id, cwd: f.other, model_provider: "openai", base_instructions: { text: "i".repeat(100 * 1024) } } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Other" }] } }),
      ].join("\n"));
    }
    expect(await f.both({ bytes: 512 * 1024 }).scan("project", f.workspace, unowned)).toMatchObject({ limited: false, candidates: [{ title: "Continue the sidebar work" }] });
    expect(await f.both({ headerBytes: 256 * 1024 }).scan("project", f.workspace, unowned)).toMatchObject({ limited: true, candidates: [] });
    await rollouts(f, 2, f.workspace);
    expect(await f.both({ bytes: 1 }).scan("project", f.workspace, unowned)).toMatchObject({ limited: true, candidates: [{ providerId: "codex" }] });
  });
});
