import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import type { ProviderHostToolCall } from "../../src/server/provider/contracts";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import { AppUnderTestHostTools } from "../../src/server/runtime/app-under-test/host-tools";
import {
  ConversationContextRequestCoordinator,
} from "../../src/server/runtime/conversation-context-request-coordinator";
import { APP_UNDER_TEST_TOOL_NAMES } from "../../src/shared/app-under-test";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { privateConnectDeviceId?: string; imageModel?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "inertia-app-routing-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace);
  const project = store.createProject("App project", workspace);
  const source = store.createConversation(project.id, "App chat", { accessMode: "full" });
  const turn = store.beginAgentTurn({
    id: crypto.randomUUID(),
    conversationId: source.id,
    runId: crypto.randomUUID(),
    content: "Launch the app",
    ...(options.privateConnectDeviceId ? { privateConnectDeviceId: options.privateConnectDeviceId } : {}),
    activateConversation: false,
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: source.modelSelection.backendProfileId,
    model: source.modelSelection.modelId,
    modelAlias: source.modelSelection.alias,
    reasoningEffort: source.modelSelection.reasoningEffort ?? "",
    interactionMode: "build",
    accessMode: "full",
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: source.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
  const appUnderTest = {
    status: vi.fn(() => []),
    clear: vi.fn(async () => true),
    turnSettled: vi.fn(),
  };
  const manager = new AgentThreadManager({
    store,
    providers: {} as never,
    backendProfileController: {} as never,
    creation: {} as never,
    turns: { activeConversationIds: () => [], isActive: () => false } as never,
    providerTerminalResumes: { acquire: () => true, isActive: () => false, release: () => undefined },
    contextRequests: new ConversationContextRequestCoordinator({
      pendingInputs: new Map(), broadcast: vi.fn(), broadcastConversationShell: vi.fn(),
    }),
    appUnderTest: appUnderTest as never,
    providerInfo: () => (options.imageModel === undefined ? [] : [{
      id: "codex",
      models: [{ id: source.modelSelection.modelId, isDefault: true, inputModalities: options.imageModel ? ["text", "image"] : ["text"] }],
    }] as never),
    broadcastSnapshot: vi.fn(),
    broadcastConversationShell: vi.fn(),
    broadcast: vi.fn(),
  });
  return { store, project, source, turn, manager, appUnderTest };
}

function call(tool: string, args: unknown = {}): ProviderHostToolCall {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: crypto.randomUUID(),
    tool,
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => "approve" as const),
  };
}

describe("App under test routing", () => {
  it("refuses a cancelled App call with the pack's full failure shape", async () => {
    const { store, source, turn, manager, appUnderTest } = await fixture();
    try {
      const cancelled = call("inertia_app_status");
      const controller = new AbortController();
      controller.abort();
      cancelled.signal = controller.signal;
      const result = await manager.bridgeFor({ conversation: source, turn }).invoke(cancelled);
      expect(JSON.parse(result.text)).toEqual({
        error: { code: "call_cancelled", message: "The App action was cancelled.", retryable: false, dispatched: false },
      });
      expect(appUnderTest.status).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it("advertises the pack to provider bridges and routes status to the launch manager", async () => {
    const { store, source, turn, manager, appUnderTest } = await fixture();
    try {
      expect(manager.capabilityManifest().packs.map(({ id }) => id)).toContain("inertia.app-under-test");
      expect(manager.capabilityInstructions().map(({ label }) => label)).toContain("inertia-app-under-test");
      const bridge = manager.bridgeFor({ conversation: source, turn });
      expect(bridge.definitions.map(({ name }) => name)).toEqual(expect.arrayContaining([...APP_UNDER_TEST_TOOL_NAMES]));
      await expect(bridge.invoke(call("inertia_app_status"))).resolves.toEqual({ success: true, text: "{\"launches\":[]}" });
      expect(appUnderTest.status).toHaveBeenCalledWith(source.id, undefined);
    } finally { store.close(); }
  });

  it("refuses the whole pack for a turn whose source message came from a Private Connect device", async () => {
    const { store, source, turn, manager, appUnderTest } = await fixture({
      privateConnectDeviceId: "77777777-7777-4777-8777-777777777777",
    });
    try {
      expect(store.message(turn.userMessageId).privateConnectDeviceId).toBe("77777777-7777-4777-8777-777777777777");
      const bridge = manager.bridgeFor({ conversation: source, turn });
      for (const tool of APP_UNDER_TEST_TOOL_NAMES) {
        const result = await bridge.invoke(call(tool));
        expect(JSON.parse(result.text), tool).toEqual({
          error: {
            code: "unavailable",
            message: "App tools are unavailable for turns sent from another device.",
            retryable: true,
            dispatched: false,
          },
        });
      }
      expect(appUnderTest.status).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it("hands the App tools the project's screenshot opt-in and whether this exact route accepts images", async () => {
    const seen: Array<{ visualEvidence?: boolean; imagesAccepted?: boolean }> = [];
    const spy = vi.spyOn(AppUnderTestHostTools.prototype, "invoke").mockImplementation(async (_conversation, _call, identity) => {
      seen.push({ visualEvidence: identity.visualEvidence, imagesAccepted: identity.imagesAccepted });
      return { success: true, text: "{}" };
    });
    try {
      for (const imageModel of [true, false]) {
        const { store, project, source, turn, manager } = await fixture({ imageModel });
        try {
          const bridge = manager.bridgeFor({ conversation: source, turn });
          await bridge.invoke(call("inertia_app_status"));
          store.updateProject(project.id, { preferences: { ...defaultProjectPreferences(), appUnderTestVisualEvidence: true } });
          await bridge.invoke(call("inertia_app_status"));
        } finally { store.close(); }
      }
      expect(seen).toEqual([
        { visualEvidence: false, imagesAccepted: true },
        { visualEvidence: true, imagesAccepted: true },
        { visualEvidence: false, imagesAccepted: false },
        { visualEvidence: true, imagesAccepted: false },
      ]);
    } finally { spy.mockRestore(); }
  });

  it("ends the App pack's per-turn state when the source turn settles, whatever its outcome", async () => {
    const { store, turn, manager, appUnderTest } = await fixture();
    try {
      await manager.onSourceTurnSettled({ ...turn, status: "completed" });
      await manager.onSourceTurnSettled({ ...turn, status: "cancelled" });
      expect(appUnderTest.turnSettled.mock.calls).toEqual([[turn.id], [turn.id]]);
    } finally { store.close(); }
  });

  it("honours the project's appUnderTestAccess preference before reaching the manager", async () => {
    const { store, project, source, turn, manager, appUnderTest } = await fixture();
    try {
      store.updateProject(project.id, { preferences: { ...defaultProjectPreferences(), appUnderTestAccess: false } });
      const result = await manager.bridgeFor({ conversation: source, turn }).invoke(call("inertia_app_status"));
      expect(result.success).toBe(false);
      expect(JSON.parse(result.text)).toEqual({
        error: { code: "unavailable", message: expect.stringContaining("disabled in this project's settings"), retryable: true, dispatched: false },
      });
      expect(appUnderTest.status).not.toHaveBeenCalled();
      store.updateProject(project.id, { preferences: { ...defaultProjectPreferences(), appUnderTestAccess: true } });
      await expect(manager.bridgeFor({ conversation: source, turn }).invoke(call("inertia_app_status")))
        .resolves.toMatchObject({ success: true });
    } finally { store.close(); }
  });
});
