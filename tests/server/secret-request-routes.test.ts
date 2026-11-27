import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import { CliConversationDiscovery } from "../../src/server/cli-import/discovery";
import { RuntimeStore } from "../../src/server/database";
import { PrivateConnectRuntimeGateway } from "../../src/server/private-connect/runtime-gateway";
import { privateConnectStoreReads } from "../../src/server/private-connect/store-detail";
import { OPENCODE_SECRET_MCP_TIMEOUT_MS, openCodeHostMcpConfig } from "../../src/server/provider/host-tool-mcp-config";
import { watcherHarnessProfile } from "../../src/server/provider/watcher-harness-profile";
import {
  createInertiaHarnessCapabilities,
  INERTIA_SECRETS_PACK_DIGEST,
  INERTIA_SECRETS_PACK_ID,
  SECRET_REQUEST_INSTRUCTION,
} from "../../src/server/runtime/inertia-harness-capabilities";
import {
  codexResumedThreadWithheldInstructions,
  recordCodexThreadRegistration,
} from "../../src/server/codex/app-server-thread-tools";
import { CachedThreadToolRegistrations } from "../../src/server/runtime/thread-tool-registrations";
import {
  SECRET_REQUEST_DECLINED_MESSAGE,
  SECRET_REQUEST_ENDED_MESSAGE,
  secretFileUseExample,
} from "../../src/server/runtime/agent-secrets/secret-request-host-tool";
import { resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import {
  SECRET_REQUEST_DEFAULT_WAIT_MS,
  SECRET_REQUEST_FALLBACK_INSTRUCTION,
  SECRET_REQUEST_ROUTES,
  SECRET_REQUEST_TOOL_NAME,
  SECRET_REQUEST_WAIT_MS_BY_PROVIDER,
  secretRequestWaitMs,
} from "../../src/node/agent-secrets";
import { hostToolActivityTitle } from "../../src/shared/activity-display";
import { PROVIDER_IDS } from "../../src/server/provider/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { resolveNativeModelRoute } from "./model-route-fixture";
import { privateConnectRuntimeGrantsFromProjectIds } from "../../src/shared/private-connect/runtime-grants";
import {
  claudeAdvertisedSurface,
  codexAdvertisedSurface,
  createSurfaceRuntime,
  httpMcpAdvertisedSurface,
} from "../helpers/agent-tool-surface";
import {
  cleanupWatcherFixtures,
  createWatcherFixture,
  WATCHER_TEST_PROVIDERS,
} from "../support/watcher-runtime-fixture";
import { WATCHER_ACCUMULATE_AGE_COOLDOWNS, WATCHER_SETTLE_DELAY_MS } from "../../src/server/runtime/watcher/watcher-wake-scheduler";

const fixtures: { directory: string; store: RuntimeStore }[] = [];

afterEach(async () => {
  for (const { directory, store } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
  await cleanupWatcherFixtures();
});

describe("inertia_request_secret registration and routes", () => {
  it("registers one inertia.secrets pack with concise triggering guidance whose only tool carries the inertia_ prefix", () => {
    const registry = createInertiaHarnessCapabilities({
      orchestrationTools: [], browserEnabled: false, secretsEnabled: true, invoke: async () => ({ success: true, text: "" }),
    });
    const pack = registry.manifest().packs.find(({ id }) => id === INERTIA_SECRETS_PACK_ID);
    expect(pack).toMatchObject({ revision: 2, toolNames: [SECRET_REQUEST_TOOL_NAME] });
    expect(SECRET_REQUEST_TOOL_NAME).toMatch(/^inertia_[a-z0-9_]+$/u);
    expect(registry.instructions().map(({ label }) => label)).toContain("inertia-secrets");
    const instructionBytes = Buffer.byteLength(SECRET_REQUEST_INSTRUCTION.text, "utf8");
    expect(instructionBytes).toBeGreaterThanOrEqual(220);
    expect(instructionBytes).toBeLessThanOrEqual(320);
    expect(SECRET_REQUEST_INSTRUCTION.text).toContain("inertia_request_secret");
    expect(SECRET_REQUEST_INSTRUCTION.text).toContain("sudo -S -p ''");
    expect(SECRET_REQUEST_DECLINED_MESSAGE).toBe(
      "The user declined. Don't ask for it in chat or another way; say what's blocked and continue without it.",
    );
    expect(SECRET_REQUEST_ENDED_MESSAGE).toBe(
      "No answer arrived. Don't ask in chat; call inertia_request_secret again only if still needed.",
    );
    expect(secretFileUseExample("C:\\Users\\o'neil\\secret", "win32")).toBe(
      "PowerShell: $key = Get-Content -Raw 'C:\\Users\\o''neil\\secret' | Git Bash: KEY=\"$(cat 'C:\\Users\\o'\\''neil\\secret')\"",
    );
    expect(watcherHarnessProfile("grok-acp")).toEqual({
      systemInstruction: false,
      sessionInstruction: false,
      sessionInstructionRecordedAtCompaction: false,
      editsGatedBeforeStart: true,
    });
    const without = createInertiaHarnessCapabilities({
      orchestrationTools: [], browserEnabled: false, invoke: async () => ({ success: true, text: "" }),
    });
    expect(without.manifest().packs.map(({ id }) => id)).not.toContain(INERTIA_SECRETS_PACK_ID);
    expect(without.instructions().map(({ label }) => label)).not.toContain("inertia-secrets");
  });

  it("advertises the tool on Claude's in-process MCP, Codex dynamic tools, the Cursor/Kimi HTTP MCP and OpenCode's remote MCP", async () => {
    const runtime = await createSurfaceRuntime();
    try {
      const surfaces = {
        claude: await claudeAdvertisedSurface(runtime.bridge),
        codex: await codexAdvertisedSurface(runtime.bridge),
        cursorKimi: await httpMcpAdvertisedSurface(runtime.bridge, {}),
        opencode: await httpMcpAdvertisedSurface(runtime.bridge, { destructiveHints: true }),
      };
      for (const [provider, surface] of Object.entries(surfaces)) {
        const tool = surface.tools.find(({ name }) => name === SECRET_REQUEST_TOOL_NAME);
        expect(tool, provider).toBeDefined();
        expect(JSON.stringify(tool), provider).toContain("You never see the value.");
        expect(JSON.stringify(tool), provider).toContain("fileName");
      }
    } finally {
      await runtime.close();
    }
  });

  it("gives a watcher's context-only bridge no secret tool, so the call is refused without a card", async () => {
    const runtime = await createSurfaceRuntime();
    try {
      const bridge = runtime.manager.contextOnlyBridgeFor({ conversation: runtime.source, turn: runtime.sourceTurn });
      expect(bridge.definitions.map(({ name }) => name)).not.toContain(SECRET_REQUEST_TOOL_NAME);
      const result = await bridge.invoke({
        providerThreadId: "t", providerTurnId: "u", toolCallId: randomUUID(), tool: SECRET_REQUEST_TOOL_NAME,
        arguments: { title: "Key", description: "Needed." }, signal: new AbortController().signal,
        requestApproval: async () => "approve",
      });
      expect(result).toMatchObject({ success: false });
      expect(JSON.parse(result.text)).toMatchObject({ error: { code: "unknown_tool" } });
      expect(runtime.store.transcriptRepository.secretRequests.forConversation(runtime.source.id)).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("covers every provider in the route table, caps waits at ten minutes, ends Cursor, Kimi and Pi waits before their bridge fetch times out, and lets OpenCode hold a call that long", () => {
    expect(Object.keys(SECRET_REQUEST_ROUTES).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(Object.keys(SECRET_REQUEST_WAIT_MS_BY_PROVIDER).sort()).toEqual([...PROVIDER_IDS].sort());
    for (const providerId of PROVIDER_IDS) {
      const wait = secretRequestWaitMs(providerId);
      expect(wait).toBeLessThanOrEqual(SECRET_REQUEST_DEFAULT_WAIT_MS);
      if (SECRET_REQUEST_ROUTES[providerId] !== "prompt-fallback") expect(wait, providerId).toBeGreaterThanOrEqual(4 * 60_000);
    }
    const nodeFetchHeadersTimeoutMs = 300_000;
    for (const providerId of ["cursor", "kimi", "pi"] as const) {
      expect(secretRequestWaitMs(providerId), providerId).toBeLessThan(nodeFetchHeadersTimeoutMs);
    }
    expect(SECRET_REQUEST_ROUTES.antigravity).toBe("prompt-fallback");
    const connection = { url: "http://127.0.0.1:1/mcp", bearerToken: "t".repeat(43) } as never;
    expect(openCodeHostMcpConfig(connection).timeout).toBe(30_000);
    expect(openCodeHostMcpConfig(connection, OPENCODE_SECRET_MCP_TIMEOUT_MS).timeout).toBeGreaterThan(secretRequestWaitMs("opencode"));
  });

  it("labels the live activity row while asking, after saving and when nothing was saved", () => {
    for (const title of [SECRET_REQUEST_TOOL_NAME, `mcp__inertia-chat-manager__${SECRET_REQUEST_TOOL_NAME}`, `inertia-chat-manager_${SECRET_REQUEST_TOOL_NAME}`,
      `mcp__inertia__${SECRET_REQUEST_TOOL_NAME}`]) {
      expect(hostToolActivityTitle({ kind: "tool", title, status: "running" })).toBe("Asking for a secret");
      expect(hostToolActivityTitle({ kind: "tool", title, status: "completed" })).toBe("Secret saved");
      expect(hostToolActivityTitle({ kind: "tool", title, status: "failed" })).toBe("No secret saved");
    }
  });
});

describe("chats without the tool", () => {
  async function wakeOnce(f: Awaited<ReturnType<typeof createWatcherFixture>>, linkId: string): Promise<string> {
    const { watcherConversationId } = f.store.watcherLinks.get(linkId)!;
    f.provider.emit(f.watched.id, { type: "activity", kind: "tool", phase: "completed", label: "Read src/parser.ts", activityId: "watched-1" });
    await f.advance(WATCHER_SETTLE_DELAY_MS + WATCHER_ACCUMULATE_AGE_COOLDOWNS * 60_000);
    await vi.waitFor(() => {
      if (!f.provider.runs.has(watcherConversationId)) throw new Error("watcher not running");
    });
    return watcherConversationId;
  }

  it("tell an unattested chat how to avoid pasting secrets, but never a watcher or an attested chat", async () => {
    const unattested = WATCHER_TEST_PROVIDERS.map((info) => ({
      ...info, capabilityContract: { ...info.capabilityContract!, hostToolBridgeAvailable: false },
    }));
    const f = await createWatcherFixture({ providerInfo: () => unattested });
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const watched = f.provider.input(f.watched.id);
      expect(`${watched.prompt}\n${watched.systemInstruction ?? ""}\n${watched.sessionInstruction ?? ""}`).toContain(SECRET_REQUEST_FALLBACK_INSTRUCTION);
      expect(`${watched.prompt}\n${watched.systemInstruction ?? ""}\n${watched.sessionInstruction ?? ""}`).not.toContain("This chat's id is");
      const watcherId = await wakeOnce(f, link.id);
      const watcher = f.provider.input(watcherId);
      expect(`${watcher.prompt}\n${watcher.systemInstruction ?? ""}\n${watcher.sessionInstruction ?? ""}`).not.toContain(SECRET_REQUEST_FALLBACK_INSTRUCTION);
    } finally {
      await f.close();
    }
    const attested = await createWatcherFixture();
    try {
      await attested.startWatchedTurn();
      const input = attested.provider.input(attested.watched.id);
      expect(`${input.prompt}\n${input.systemInstruction ?? ""}\n${input.sessionInstruction ?? ""}`).not.toContain(SECRET_REQUEST_FALLBACK_INSTRUCTION);
    } finally {
      await attested.close();
    }
  });

  it("withholds inertia-secrets and injects the fallback instruction when resuming a Codex thread without the current inertia.secrets digest", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-codex-pre85-"));
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
    fixtures.push({ directory, store });
    const project = store.createProject("Codex", directory);
    const modelSelection = providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" });
    const oldSessionId = "codex-pre-v0-0-85-thread";
    const rev1SessionId = "codex-rev1-secrets-thread";
    const newSessionId = "codex-post-v0-0-85-thread";
    const oldChat = store.createConversation(project.id, "Legacy Codex", { modelSelection });
    const rev1Chat = store.createConversation(project.id, "Rev1 Codex", { modelSelection });
    const newChat = store.createConversation(project.id, "Current Codex", { modelSelection });
    const route = resolveNativeModelRoute(modelSelection);
    store.updateConversation(oldChat.id, {
      providerSessionId: oldSessionId,
      continuationIdentity: route.continuationIdentity,
    });
    store.updateConversation(rev1Chat.id, {
      providerSessionId: rev1SessionId,
      continuationIdentity: route.continuationIdentity,
    });
    store.updateConversation(newChat.id, {
      providerSessionId: newSessionId,
      continuationIdentity: route.continuationIdentity,
    });
    store.codexThreadToolPacks.record(oldSessionId, new Map([["inertia.workspace", "a".repeat(64)]]));
    store.codexThreadToolPacks.record(rev1SessionId, new Map([
      ["inertia.workspace", "a".repeat(64)],
      [INERTIA_SECRETS_PACK_ID, "1".repeat(64)],
    ]));
    store.codexThreadToolPacks.record(newSessionId, new Map([
      ["inertia.workspace", "a".repeat(64)],
      [INERTIA_SECRETS_PACK_ID, INERTIA_SECRETS_PACK_DIGEST],
    ]));
    const registry = createInertiaHarnessCapabilities({
      orchestrationTools: [],
      browserEnabled: false,
      secretsEnabled: true,
      invoke: async () => ({ success: true, text: "" }),
      threadRegistrations: store.codexThreadToolPacks,
    });
    const codexInfo = WATCHER_TEST_PROVIDERS.find(({ id }) => id === "codex")!;
    const deps = {
      store,
      providers: {
        resolveModelRoute: () => route,
        harnessIdFor: () => "codex-app-server",
      } as never,
      hooks: {
        providerInfo: () => [codexInfo],
        capabilityOfferForTurn: () => ({
          instructions: registry.instructions(),
          offer: { withheldPacks: new Map() },
        }),
      } as never,
      id: () => randomUUID(),
      now: () => "2026-10-29T12:00:00.000Z",
      clock: () => new Date("2026-10-29T12:00:00.000Z"),
    };

    const prepare = (conversationId: string) => {
      const resolved = resolveTurnRequest(deps, { conversationId, content: "Deploy now" });
      const queued = store.beginAgentTurn(resolved.input);
      return resolved.adopt(queued).active;
    };

    for (const [chatId, sessionId] of [[oldChat.id, oldSessionId], [rev1Chat.id, rev1SessionId]] as const) {
      const active = prepare(chatId);
      const input = active.providerInput;
      expect(input.sessionId).toBe(sessionId);
      const text = `${input.prompt}\n${input.sessionInstruction ?? ""}`;
      expect(text).not.toContain("[inertia-secrets]");
      expect(text).toContain("[inertia-secrets-fallback]");
      expect(text).toContain(SECRET_REQUEST_FALLBACK_INSTRUCTION);
      const bridge = registry.bridgeFor({ conversation: active.conversation, turn: active.turn });
      expect(codexResumedThreadWithheldInstructions(sessionId, bridge).map(({ label }) => label))
        .toContain(SECRET_REQUEST_INSTRUCTION.label);
    }

    const currentActive = prepare(newChat.id);
    const currentInput = currentActive.providerInput;
    expect(currentInput.sessionId).toBe(newSessionId);
    const currentText = `${currentInput.prompt}\n${currentInput.sessionInstruction ?? ""}`;
    expect(currentText).toContain("[inertia-secrets]");
    expect(currentText).not.toContain("[inertia-secrets-fallback]");
    const currentBridge = registry.bridgeFor({ conversation: currentActive.conversation, turn: currentActive.turn });
    expect(codexResumedThreadWithheldInstructions(newSessionId, currentBridge).map(({ label }) => label))
      .not.toContain(SECRET_REQUEST_INSTRUCTION.label);

    // When durable SQLite writes fail, both turn preparation and resume filtering
    // must read the same CachedThreadToolRegistrations instance.
    const cachedSessionId = "codex-cached-only-thread";
    const cachedChat = store.createConversation(project.id, "Cached Codex", { modelSelection });
    store.updateConversation(cachedChat.id, {
      providerSessionId: cachedSessionId,
      continuationIdentity: route.continuationIdentity,
    });
    const recordSpy = vi.spyOn(store.codexThreadToolPacks, "record").mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });
    const cachedRegistry = createInertiaHarnessCapabilities({
      orchestrationTools: [],
      browserEnabled: false,
      secretsEnabled: true,
      invoke: async () => ({ success: true, text: "" }),
      threadRegistrations: new CachedThreadToolRegistrations(store.codexThreadToolPacks),
    });
    const cachedActive = prepare(cachedChat.id);
    const cachedBridge = cachedRegistry.bridgeFor({ conversation: cachedActive.conversation, turn: cachedActive.turn });
    recordCodexThreadRegistration(cachedSessionId, cachedBridge);
    expect(recordSpy).toHaveBeenCalledOnce();
    expect(store.codexThreadToolPacks.read(cachedSessionId)).toBeNull();

    const resumedCachedActive = prepare(cachedChat.id);
    const resumedCachedText = `${resumedCachedActive.providerInput.prompt}\n${resumedCachedActive.providerInput.sessionInstruction ?? ""}`;
    expect(resumedCachedText).toContain("[inertia-secrets]");
    expect(resumedCachedText).not.toContain("[inertia-secrets-fallback]");
    expect(codexResumedThreadWithheldInstructions(cachedSessionId, cachedBridge).map(({ label }) => label))
      .not.toContain(SECRET_REQUEST_INSTRUCTION.label);
  });
});

describe("secret request cards outside the desktop chat", () => {
  it("reach Private Connect as a status line with no answer path and stay out of shared context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-secret-projection-"));
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
    fixtures.push({ directory, store });
    const project = store.createProject("Secrets", directory);
    const modelSelection = providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" });
    const source = store.createConversation(project.id, "Tailscale", { modelSelection });
    const target = store.createConversation(project.id, "Follow-up", { modelSelection });
    const { turn } = store.beginAgentTurn({
      conversationId: source.id, runId: randomUUID(), content: "Set up the VMs.", providerId: "codex", modelSelection,
      reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
      configurationRevision: modelSelection.backendConfigurationRevision, association: "authoritative",
    });
    const { message } = store.transcriptRepository.secretRequests.create({
      conversationId: source.id, runId: turn.runId, turnId: turn.id, providerId: "codex",
      title: "Tailscale auth key", description: "Create a reusable key.", fileName: "secret", ttlHours: 24,
    });
    const reads = privateConnectStoreReads(store);
    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => store.shellSnapshot(),
      conversation: reads.conversation,
      detail: reads.detail,
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
    });
    const response = await gateway.request({
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }, { type: "conversation.get", requestId: "33333333-3333-4333-8333-333333333333", conversationId: source.id });
    if (!response.ok || response.result.kind !== "conversation") throw new Error("Expected a conversation detail.");
    expect(response.result.detail.messages.map(({ id, role, content }) => [id, role, content])).toContainEqual([
      message.id, "assistant", "[secret request: Tailscale auth key, pending; answer on the computer]",
    ]);
    const transcript = store.contextPackets.sourceTranscript(source.id, target.id);
    expect(JSON.stringify(transcript)).not.toContain("Tailscale auth key");
    const token = "0123456789abcdef0123456789abcdef";
    store.transcriptRepository.secretRequests.transition(message.secretRequest!.requestId, ["pending"], "saved", {
      fileToken: token, expiresAt: "2030-01-02T00:00:00.000Z", vaulted: true,
    });
    const saved = await gateway.request({
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }, { type: "conversation.get", requestId: "44444444-4444-4444-8444-444444444444", conversationId: source.id });
    if (!saved.ok || saved.result.kind !== "conversation") throw new Error("Expected a conversation detail.");
    expect(saved.result.detail.messages.map(({ content }) => content))
      .toContain("[secret request: Tailscale auth key, saved; answer on the computer]");
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(JSON.stringify(saved)).not.toContain("agent-secrets");
  });
});

describe("CLI import while a secret is active", () => {
  it("redacts the active values, read at scan time, from an imported transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-secret-cli-import-"));
    const workspace = join(root, "project");
    const sessions = join(root, "sessions");
    await mkdir(workspace);
    await mkdir(sessions);
    const sessionId = randomUUID();
    const secret = "fake-token-kQ9xZ2mB7vN4pL1sR8tW";
    await writeFile(join(sessions, `rollout-${sessionId}.jsonl`), [
      { type: "session_meta", payload: { id: sessionId, cwd: workspace, model_provider: "openai" } },
      { type: "response_item", timestamp: "2026-10-29T10:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Log in with ${secret} please` }] } },
    ].map((item) => JSON.stringify(item)).join("\n"));
    const active: string[] = [];
    const discovery = new CliConversationDiscovery([{ providerId: "codex", path: sessions }], () => active);
    active.push(secret);
    try {
      const scan = await discovery.scan("project", workspace, () => ({ importedConversationId: null, omission: null, owned: false }));
      const read = await discovery.read("project", workspace, scan.candidates[0]!.id);
      expect(JSON.stringify(read)).not.toContain(secret);
      expect(read.transcript.messages[0]?.content).toContain("[redacted]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
