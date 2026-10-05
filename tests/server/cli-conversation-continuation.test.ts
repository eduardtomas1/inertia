// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliConversationDiscovery, cliConversationRoots } from "../../src/server/cli-import/discovery";
import { ProviderManager } from "../../src/server/providers";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { CliConversationContinuation, CliMessage, CliProvider } from "../../src/shared/cli-conversations";
import { captured, fakeAppServer } from "../helpers/codex-app-server-fixture";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises, type TurnControllerTestRuntime } from "../support/turn-controller-runtime";

const directories: string[] = [];
const roots: string[] = [];
const managers: ProviderManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  await Promise.all(roots.splice(0).map(removePortableFixture));
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  await cleanupTurnControllerTestDirectories();
});
const unowned = () => ({ importedConversationId: null, omission: null, owned: false });
const history: CliMessage[] = [
  { role: "user", content: "Earlier archived request", createdAt: "2026-09-25T10:00:00.000Z" },
  { role: "assistant", content: "Earlier archived reply", createdAt: "2026-09-25T10:01:00.000Z" },
];
const HOST_TOOLS_NOTE = "This chat continues a Codex CLI session, so Inertia's Browser and other host tools are not available in it.";
const CONTEXT_NOTE = "Continues in a new session with the imported messages as earlier context";

function importInto(runtime: TurnControllerTestRuntime, providerId: CliProvider, continuation: CliConversationContinuation, sessionId = randomUUID()): string {
  const selection = providerNativeModelSelection({ providerId });
  return runtime.store.importCliConversation({
    projectId: runtime.store.conversation(runtime.conversationId).projectId, sourceKey: randomUUID().replaceAll("-", "").padEnd(64, "0"), providerId, sessionId,
    cwd: runtime.store.conversationPath(runtime.conversationId), title: "Imported", messages: history, omittedMessages: 0, omittedBytes: 0, droppedRecords: 0,
    continuation, selection, continuationIdentity: runtime.provider.resolveModelRoute(selection).continuationIdentity,
  });
}

function notes(runtime: TurnControllerTestRuntime, conversationId: string, turnId: string): string[] {
  return (runtime.store.conversationDetail(conversationId)?.messages ?? []).filter((message) => message.role === "system" && message.turnId === turnId).map(({ content }) => content);
}

describe("how an imported CLI chat continues", () => {
  it("marks archived Codex sessions to continue from context and every other source natively", async () => {
    expect(cliConversationRoots({ CODEX_HOME: "/codex", CLAUDE_CONFIG_DIR: "/claude" }).map(({ providerId, continuation }) => [providerId, continuation]))
      .toEqual([["codex", "native"], ["codex", "context"], ["claude", "native"]]);
    const root = await mkdtemp(join(tmpdir(), "inertia-cli-continuation-")); directories.push(root);
    const workspace = join(root, "project"); const sessions = join(root, "sessions"); const archived = join(root, "archived_sessions");
    await Promise.all([workspace, sessions, archived].map((path) => mkdir(path)));
    for (const [folder, text] of [[sessions, "Live request"], [archived, "Archived request"]] as const) {
      const id = randomUUID();
      await writeFile(join(folder, `rollout-${id}.jsonl`), [{ type: "session_meta", payload: { id, cwd: workspace, model_provider: "openai" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }].map((item) => JSON.stringify(item)).join("\n") + "\n");
    }
    const discovery = new CliConversationDiscovery([{ providerId: "codex", path: sessions, continuation: "native" }, { providerId: "codex", path: archived, continuation: "context" }], []);
    const scan = await discovery.scan("project", workspace, unowned);
    expect(Object.fromEntries(scan.candidates.map(({ title, continuation }) => [title, continuation]))).toEqual({ "Live request": "native", "Archived request": "context" });
    const archivedCandidate = scan.candidates.find(({ title }) => title === "Archived request")!;
    expect((await discovery.read("project", workspace, archivedCandidate.id)).continuation).toBe("context");
  });

  it("records the continuation on the receipt and keeps no native session for a context import", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }) });
    try {
      const sessionId = randomUUID();
      const conversationId = importInto(runtime, "codex", "context", sessionId);
      expect(runtime.store.cliConversationImport(conversationId)).toMatchObject({ providerId: "codex", sessionId, continuation: "context" });
      expect(runtime.store.conversation(conversationId).providerSessionId).toBeNull();
      expect(runtime.store.cliSessionOwnership("codex", sessionId)).toMatchObject({ importedConversationId: conversationId, continuation: "context", owned: false });
      const native = importInto(runtime, "codex", "native");
      expect(runtime.store.cliConversationImport(native)).toMatchObject({ continuation: "native" });
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("starts a context chat's first follow-up on a fresh session with the imported messages restored, and says so once", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }) });
    try {
      const conversationId = importInto(runtime, "codex", "context");
      const first = runtime.controller.queue({ conversationId, content: "Continue the archived work." });
      expect(first.turn).toMatchObject({ providerSessionBefore: null, continuationReasonCode: "missing-continuation-identity", sessionRecovery: { restoredMessageCount: 2, omittedMessageCount: 0 } });
      runtime.controller.start(first.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("Earlier archived reply");
      expect(notes(runtime, conversationId, first.turn.id)).toEqual([CONTEXT_NOTE]);
      runtime.provider.resolve({ status: "completed", sessionId: "thread-new" });
      await flushTurnControllerTestPromises();
      const second = runtime.controller.queue({ conversationId, content: "And the next step." });
      expect(second.turn).toMatchObject({ providerSessionBefore: "thread-new", continuationReasonCode: "same-continuation" });
      expect(notes(runtime, conversationId, second.turn.id)).toEqual([]);
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("tells a native Codex chat's first follow-up that Inertia's host tools are unavailable, and a native Claude chat which session it continues", async () => {
    const codex = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }) });
    const claude = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }) });
    try {
      for (const [runtime, providerId, note] of [[codex, "codex", HOST_TOOLS_NOTE], [claude, "claude", "Continues the original Claude Code session"]] as const) {
        const sessionId = randomUUID();
        const conversationId = importInto(runtime, providerId, "native", sessionId);
        const first = runtime.controller.queue({ conversationId, content: "Continue." });
        expect(first.turn.providerSessionBefore).toBe(sessionId);
        expect(notes(runtime, conversationId, first.turn.id)).toEqual([note]);
        runtime.controller.start(first.turn.id);
        runtime.provider.resolve({ status: "completed", sessionId });
        await flushTurnControllerTestPromises();
        const second = runtime.controller.queue({ conversationId, content: "Again." });
        expect(notes(runtime, conversationId, second.turn.id)).toEqual([]);
        runtime.controller.start(second.turn.id);
        runtime.provider.resolve({ status: "completed", sessionId });
        await flushTurnControllerTestPromises();
      }
    } finally {
      for (const runtime of [codex, claude]) {
        await runtime.controller.dispose();
        runtime.store.close();
      }
    }
  });

  it("never asks Codex to resume a context chat's archived thread on its first follow-up", { concurrent: false }, async () => {
    const runtime = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }) });
    const fake = fakeAppServer(roots);
    const previousCapture = process.env.INERTIA_APP_SERVER_CAPTURE;
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    try {
      const conversationId = importInto(runtime, "codex", "context");
      const first = runtime.controller.queue({ conversationId, content: "Continue the archived work." });
      runtime.controller.start(first.turn.id);
      const input = { ...runtime.provider.input!, cwd: fake.root };
      const manager = ProviderManager.createForTests({
        commands: { codex: fake.command },
        resolveBackendLaunchOptions: (_input, environment) => ({ environment: { ...environment, INERTIA_APP_SERVER_CAPTURE: fake.capturePath, INERTIA_APP_SERVER_SCENARIO: "turn-completed-before-response" } }),
      });
      managers.push(manager);
      await expect(manager.run(input)).resolves.toMatchObject({ status: "completed" });
      const messages = captured(fake.capturePath);
      expect(messages.some(({ method }) => method === "thread/resume" || method === "thread/unarchive")).toBe(false);
      expect(messages.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      const turns = messages.filter(({ method }) => method === "turn/start");
      expect(turns).toHaveLength(1);
      expect(JSON.stringify(turns[0])).toContain("Earlier archived reply");
    } finally {
      if (previousCapture === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
      else process.env.INERTIA_APP_SERVER_CAPTURE = previousCapture;
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});
