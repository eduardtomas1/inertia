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
import { createInertiaHarnessCapabilities } from "../../src/server/runtime/inertia-harness-capabilities";
import {
  SECRET_REQUEST_DEFAULT_WAIT_MS,
  SECRET_REQUEST_FALLBACK_INSTRUCTION,
  SECRET_REQUEST_ROUTES,
  SECRET_REQUEST_TOOL_NAME,
  SECRET_REQUEST_WAIT_MS_BY_PROVIDER,
  secretRequestWaitMs,
} from "../../src/node/agent-secrets";
import { hostToolActivityTitle } from "../../src/shared/activity-display";
import { PROVIDER_IDS } from "../../src/server/runtime/backends/backend-profile-model";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
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
  it("registers one instruction-free inertia.secrets pack whose only tool carries the inertia_ prefix", () => {
    const registry = createInertiaHarnessCapabilities({
      orchestrationTools: [], browserEnabled: false, secretsEnabled: true, invoke: async () => ({ success: true, text: "" }),
    });
    const pack = registry.manifest().packs.find(({ id }) => id === "inertia.secrets");
    expect(pack).toMatchObject({ revision: 1, toolNames: [SECRET_REQUEST_TOOL_NAME] });
    expect(SECRET_REQUEST_TOOL_NAME).toMatch(/^inertia_[a-z0-9_]+$/u);
    expect(registry.instructions().map(({ label }) => label)).not.toContain("inertia-secrets");
    const without = createInertiaHarnessCapabilities({
      orchestrationTools: [], browserEnabled: false, invoke: async () => ({ success: true, text: "" }),
    });
    expect(without.manifest().packs.map(({ id }) => id)).not.toContain("inertia.secrets");
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

  it("covers every provider in the route table, caps waits at ten minutes and lets OpenCode hold a call that long", () => {
    expect(Object.keys(SECRET_REQUEST_ROUTES).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(Object.keys(SECRET_REQUEST_WAIT_MS_BY_PROVIDER).sort()).toEqual([...PROVIDER_IDS].sort());
    for (const providerId of PROVIDER_IDS) {
      const wait = secretRequestWaitMs(providerId);
      expect(wait).toBeLessThanOrEqual(SECRET_REQUEST_DEFAULT_WAIT_MS);
      if (SECRET_REQUEST_ROUTES[providerId] !== "prompt-fallback") expect(wait, providerId).toBeGreaterThanOrEqual(5 * 60_000);
    }
    expect(SECRET_REQUEST_ROUTES.antigravity).toBe("prompt-fallback");
    const connection = { url: "http://127.0.0.1:1/mcp", bearerToken: "t".repeat(43) } as never;
    expect(openCodeHostMcpConfig(connection).timeout).toBe(30_000);
    expect(openCodeHostMcpConfig(connection, OPENCODE_SECRET_MCP_TIMEOUT_MS).timeout).toBeGreaterThan(secretRequestWaitMs("opencode"));
  });

  it("labels the live activity row while asking, after saving and when nothing was saved", () => {
    for (const title of [SECRET_REQUEST_TOOL_NAME, `mcp__inertia-chat-manager__${SECRET_REQUEST_TOOL_NAME}`, `inertia-chat-manager_${SECRET_REQUEST_TOOL_NAME}`]) {
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
