import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import {
  createTurnInteractionCommandHandler,
  type TurnInteractionCommandDependencies,
} from "../../src/server/runtime/commands/turn-interaction-commands";
import { createTodoCommandHandler, type TodoCommandDependencies } from "../../src/server/runtime/commands/todo-commands";
import { ConversationCreationService } from "../../src/server/runtime/conversation-creation-service";
import { BackendProfileController } from "../../src/server/runtime/backends/backend-profile-controller";
import { ConversationUpdateService } from "../../src/server/runtime/conversation-update-service";
import { RouteAdvisor, type RouteAdvisorDependencies } from "../../src/server/runtime/routing/route-advisor";
import type { ClientCommand, ModelSelection, ProviderInfo } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import type { RoutingPreset, RoutingSettingsUpdate } from "../../src/shared/routing/routing-policy";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestProviderInfo,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";
import { resolveNativeModelRoute } from "./model-route-fixture";

const gptTest: RoutingPreset = {
  providerId: "codex", backendProfileId: "builtin:openai", modelId: "gpt-test", reasoningEffort: "high", fastMode: false, weight: "normal",
};
const gptNext: RoutingPreset = { ...gptTest, modelId: "gpt-next" };
const ROUTING: RoutingSettingsUpdate = {
  enabled: true,
  tiers: { light: { presets: [gptTest] }, standard: { presets: [gptTest] }, heavy: { presets: [gptNext] }, max: { presets: [gptNext] } },
};
const DEBUGGING = "Tests are failing after the last merge, can you debug?";
const QUESTION = "What does this function do?";

const backendProfileController = {
  validateSelection: (selection: ModelSelection) => selection,
  isExternalSelection: () => false,
  supportsNativeFastModeControl: () => false,
  readiness: async (_selection: ModelSelection): Promise<{ ready: boolean; message: string | null } | null> => null,
};

/** A mutable, schema-parsed native selection, as a conversation.update payload carries it. */
function nativeSelection(input: Parameters<typeof providerNativeModelSelection>[0]) {
  return modelSelectionSchema.parse(providerNativeModelSelection(input));
}

function advisor(runtime: Pick<TurnControllerTestRuntime, "store" | "provider">, overrides: Partial<RouteAdvisorDependencies> = {}) {
  return new RouteAdvisor({
    store: runtime.store,
    providerInfo: () => [turnControllerTestProviderInfo()],
    backendProfiles: () => [],
    validateSelection: (selection) => selection,
    updates: new ConversationUpdateService({ store: runtime.store, providers: runtime.provider, backendProfileController }),
    ...overrides,
  });
}

interface SenderOptions {
  providers?: ProviderInfo[];
  controller?: Partial<typeof backendProfileController> | BackendProfileController;
  prepareDocumentAttachments?: TurnInteractionCommandDependencies["prepareDocumentAttachments"];
}

function messageSender(
  runtime: TurnControllerTestRuntime,
  routeAdvisor?: TurnInteractionCommandDependencies["routeAdvisor"],
  options: SenderOptions = {},
) {
  const providers = options.providers ?? [turnControllerTestProviderInfo()];
  const controller = options.controller instanceof BackendProfileController
    ? options.controller
    : { ...backendProfileController, ...options.controller };
  const dependencies: TurnInteractionCommandDependencies = {
    routeAdvisor,
    store: runtime.store,
    turns: runtime.controller,
    conversationAttachments: {
      retain: async (payloads: Array<{ attachment: unknown }>) => payloads.map(({ attachment }) => attachment),
      acceptRetention: () => undefined,
      releaseRetention: async () => undefined,
    } as unknown as TurnInteractionCommandDependencies["conversationAttachments"],
    backendProfileController: controller as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    ...(options.prepareDocumentAttachments ? { prepareDocumentAttachments: options.prepareDocumentAttachments } : {}),
    isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals: new Map(),
    pendingInputs: new Map(),
    dataDirectory: runtime.directory,
    enableProviders: true,
    attachmentResolver: null,
    generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: {
      resolveTurnSkills: async () => ({ inputs: [], routeKey: null }),
      assertTurnSkillsCurrent: () => undefined,
    } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: {
      isActive: () => false,
      acquireWhenAvailable: async () => true,
      release: () => undefined,
    } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => providers,
    broadcast: () => undefined,
    broadcastSnapshot: () => undefined,
    send: () => undefined,
  };
  return async (content: string) => {
    await createTurnInteractionCommandHandler(dependencies)(null as unknown as WebSocket, {
      type: "message.send",
      requestId: randomUUID(),
      payload: { conversationId: runtime.conversationId, content, attachments: [] },
    } as ClientCommand);
    await vi.waitFor(() => expect(runtime.provider.input?.prompt).toContain(content));
    return runtime.store.latestAgentTurnForConversation(runtime.conversationId)!;
  };
}

async function finish(runtime: TurnControllerTestRuntime, sessionId: string) {
  runtime.provider.resolve({ status: "completed", sessionId });
  await flushTurnControllerTestPromises();
  await vi.waitFor(() => expect(runtime.controller.isActive(runtime.conversationId)).toBe(false));
}

afterEach(async () => {
  await cleanupTurnControllerTestDirectories();
});

describe("Auto routing on message.send", () => {
  it("applies the routed model through the validated update and records the decision on the turn", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.updateSettings({ routing: ROUTING });
      runtime.store.updateConversation(runtime.conversationId, { routingMode: "auto" });
      const send = messageSender(runtime, advisor(runtime));

      const first = await send(QUESTION);
      expect(first.modelSelection.modelId).toBe("gpt-test");
      expect(first.routing).toMatchObject({ picker: "rules", tier: "light", taskKind: "question", outcome: "kept", previousRoute: null });
      await finish(runtime, "thread-1");
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("thread-1");

      const second = await send(DEBUGGING);
      const conversation = runtime.store.conversation(runtime.conversationId);
      expect(conversation).toMatchObject({ routingMode: "auto", modelSelection: expect.objectContaining({ modelId: "gpt-next" }) });
      expect(second.modelSelection.modelId).toBe("gpt-next");
      // Codex may switch models inside its session, so the validated continuation resumes it.
      expect(second.providerSessionBefore).toBe("thread-1");
      expect(second.routing).toMatchObject({
        tier: "heavy",
        taskKind: "debugging",
        outcome: "applied",
        previousRoute: { providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" },
      });
      expect(second.routing!.reason).toContain("Heavy tier");
      expect(runtime.store.shellSnapshot().conversations[0]!.latestTurn?.routing).toEqual(second.routing);
      await finish(runtime, "thread-1");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("keeps the current route and still sends the message when the update is refused", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.updateSettings({ routing: ROUTING });
      runtime.store.updateConversation(runtime.conversationId, { routingMode: "auto" });
      const update = vi.fn(() => {
        throw new RuntimeRequestError("Stop the active run or review before changing its agent configuration.");
      });
      const turn = await messageSender(runtime, advisor(runtime, { updates: { update } }))(DEBUGGING);
      expect(update).toHaveBeenCalledOnce();
      expect(turn.modelSelection.modelId).toBe("gpt-test");
      expect(turn.routing).toMatchObject({ outcome: "kept", previousRoute: null });
      expect(turn.routing!.reason).toContain("Kept the current model: Stop the active run");
      expect(runtime.store.conversation(runtime.conversationId).modelSelection.modelId).toBe("gpt-test");
      await finish(runtime, "thread-1");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("never fails the message when the picker throws or validation refuses every preset", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.updateSettings({ routing: ROUTING });
      runtime.store.updateConversation(runtime.conversationId, { routingMode: "auto" });
      const broken = advisor(runtime, { pickers: { rules: async () => { throw new Error("boom"); } } });
      const first = await messageSender(runtime, broken)(DEBUGGING);
      expect(first.routing).toMatchObject({ outcome: "kept", confidence: 0 });
      await finish(runtime, "thread-1");
      const strict = advisor(runtime, { validateSelection: () => { throw new Error("refused"); } });
      const second = await messageSender(runtime, strict)(DEBUGGING);
      expect(second.modelSelection.modelId).toBe("gpt-test");
      expect(second.routing).toMatchObject({ outcome: "fallback" });
      expect(second.routing!.reason).toContain("current model stays");
      await finish(runtime, "thread-1");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("leaves manual chats and disabled routing untouched", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.updateSettings({ routing: ROUTING });
      const manual = await messageSender(runtime, advisor(runtime))(DEBUGGING);
      expect(manual.routing).toBeUndefined();
      expect(manual.modelSelection.modelId).toBe("gpt-test");
      await finish(runtime, "thread-1");
      runtime.store.updateSettings({ routing: { enabled: false } });
      runtime.store.updateConversation(runtime.conversationId, { routingMode: "auto" });
      const disabled = await messageSender(runtime, advisor(runtime))(DEBUGGING);
      expect(disabled.routing).toBeUndefined();
      expect(disabled.modelSelection.modelId).toBe("gpt-test");
      await finish(runtime, "thread-1");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

const DUO_LOCK = "This judge chat is reserved for its locked Duo comparison. Retry or cancel the comparison before sending other work.";

function codexProvider(models: ProviderInfo["models"]): ProviderInfo {
  return { ...turnControllerTestProviderInfo(), models };
}

function claudeProvider(): ProviderInfo {
  const codex = turnControllerTestProviderInfo();
  return {
    ...codex,
    id: "claude",
    label: "Claude",
    command: "fake-claude",
    executable: "fake-claude",
    models: [{ ...codex.models[0]!, id: "claude-test", label: "Claude Test", fastMode: null }],
    capabilityContract: undefined,
  };
}

async function withAutoChat(
  routing: RoutingSettingsUpdate,
  test: (runtime: TurnControllerTestRuntime) => Promise<void>,
): Promise<void> {
  const runtime = await createTurnControllerTestRuntime();
  try {
    runtime.store.updateSettings({ routing });
    runtime.store.updateConversation(runtime.conversationId, { routingMode: "auto" });
    await test(runtime);
  } finally {
    await runtime.controller.dispose();
    runtime.store.close();
  }
}

describe("Auto routing safeguards on message.send", () => {
  it("treats scanned PDF pages as image input, so a text-only Light default never takes the chat", async () => {
    const [visionModel] = turnControllerTestProviderInfo().models;
    const providers = [codexProvider([
      visionModel!,
      { ...visionModel!, id: "gpt-mini", label: "GPT Mini", inputModalities: ["text"], fastMode: null },
    ])];
    await withAutoChat({ enabled: true }, async (runtime) => {
      const routeAdvisor = advisor(runtime, { providerInfo: () => providers });
      const scannedPdf = messageSender(runtime, routeAdvisor, {
        providers,
        prepareDocumentAttachments: async () => ({ contexts: [], imagePaths: [], generatedImagePaths: ["/private/page-1.png"] }),
      });
      const withPdf = await scannedPdf(QUESTION);
      expect(withPdf.modelSelection.modelId).toBe("gpt-test");
      expect(withPdf.routing).toMatchObject({ tier: "standard", outcome: "fallback", previousRoute: null });
      expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
        routingMode: "auto",
        modelSelection: expect.objectContaining({ modelId: "gpt-test" }),
      });
      await finish(runtime, "thread-1");
      // Control: without the scanned pages the same message takes the Light default.
      const plain = await messageSender(runtime, routeAdvisor, { providers })(QUESTION);
      expect(plain.modelSelection.modelId).toBe("gpt-mini");
      expect(plain.routing).toMatchObject({ tier: "light", outcome: "applied" });
      await finish(runtime, "thread-1");
    });
  });

  it("restores the previous route when the routed one is not ready, and still sends the message", async () => {
    await withAutoChat(ROUTING, async (runtime) => {
      const offline = new Set(["gpt-next"]);
      const readiness = vi.fn(async (selection: ModelSelection) => offline.has(selection.modelId)
        ? { ready: false, message: `${selection.modelId} is offline.` }
        : null);
      const send = messageSender(runtime, advisor(runtime), { controller: { readiness } });
      const turn = await send(DEBUGGING);
      expect(readiness.mock.calls.map(([selection]) => selection.modelId)).toEqual(["gpt-next", "gpt-test"]);
      expect(turn.modelSelection.modelId).toBe("gpt-test");
      expect(turn.routing).toMatchObject({ tier: "heavy", outcome: "kept", previousRoute: null });
      expect(turn.routing!.reason).toContain("not ready (gpt-next is offline.)");
      expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
        routingMode: "auto",
        providerSessionId: null,
        modelSelection: expect.objectContaining({ modelId: "gpt-test" }),
      });
      await finish(runtime, "thread-1");

      // When the previous route is not ready either, the normal readiness error stands.
      offline.add("gpt-test");
      await expect(send(DEBUGGING)).rejects.toThrow("gpt-test is offline.");
      expect(runtime.store.conversation(runtime.conversationId).modelSelection.modelId).toBe("gpt-test");
      expect(runtime.store.agentTurnsForConversation(runtime.conversationId)).toHaveLength(1);
    });
  });

  it("applies the selection canonicalised by the real backend validator", async () => {
    await withAutoChat(ROUTING, async (runtime) => {
      const controller = await BackendProfileController.create({ store: runtime.store });
      controller.profiles([turnControllerTestProviderInfo()]);
      const routeAdvisor = advisor(runtime, {
        validateSelection: (selection) => controller.validateSelection(selection),
        updates: new ConversationUpdateService({ store: runtime.store, providers: runtime.provider, backendProfileController: controller }),
      });
      const turn = await messageSender(runtime, routeAdvisor, { controller })(DEBUGGING);
      const canonical = controller.validateSelection(
        providerNativeModelSelection({ providerId: "codex", modelId: "gpt-next", reasoningEffort: "high" }),
      );
      expect(canonical.alias).toBe("GPT Next");
      expect(runtime.store.conversation(runtime.conversationId).modelSelection).toEqual(canonical);
      expect(turn.modelSelection).toEqual(canonical);
      expect(turn.routing).toMatchObject({ outcome: "applied", tier: "heavy" });
      await finish(runtime, "thread-1");
    });
  });

  it("resets the provider session when Auto moves the chat to another provider", async () => {
    const claudeTest: RoutingPreset = { ...gptTest, providerId: "claude", backendProfileId: "builtin:anthropic", modelId: "claude-test" };
    const providers = [turnControllerTestProviderInfo(), claudeProvider()];
    await withAutoChat({ ...ROUTING, stickiness: "rebalance", tiers: { ...ROUTING.tiers, heavy: { presets: [claudeTest] } } }, async (runtime) => {
      const send = messageSender(runtime, advisor(runtime, { providerInfo: () => providers }), { providers });
      await send(QUESTION);
      await finish(runtime, "thread-1");
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("thread-1");

      const switched = await send(DEBUGGING);
      expect(switched).toMatchObject({ providerId: "claude", providerSessionBefore: null });
      expect(switched.modelSelection.modelId).toBe("claude-test");
      expect(switched.routing).toMatchObject({
        outcome: "applied",
        previousRoute: { providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" },
      });
      expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({ providerId: "claude", routingMode: "auto" });
      await finish(runtime, "claude-session-1");
    });
  });

  it("keeps a Duo-locked chat on its route", async () => {
    await withAutoChat(ROUTING, async (runtime) => {
      vi.spyOn(runtime.store, "assertDuoComparisonTurnAllowed").mockImplementation(() => {
        throw new Error(DUO_LOCK);
      });
      const decision = await advisor(runtime).routeBeforeTurn({
        conversationId: runtime.conversationId,
        content: DEBUGGING,
        attachments: [],
      });
      expect(decision).toMatchObject({ restore: null, summary: { tier: "heavy", outcome: "kept", previousRoute: null } });
      expect(decision!.summary!.reason).toContain("reserved for its locked Duo comparison");
      expect(runtime.store.conversation(runtime.conversationId).modelSelection.modelId).toBe("gpt-test");
    });
  });

  it("never overwrites a mode or model change made while the picker ran", async () => {
    await withAutoChat(ROUTING, async (runtime) => {
      const updates = new ConversationUpdateService({ store: runtime.store, providers: runtime.provider, backendProfileController });
      const slowPicker = (change: Parameters<ConversationUpdateService["update"]>[0]) => async () => {
        updates.update(change);
        return { tier: "heavy" as const, taskKind: "debugging" as const, confidence: 0.9, trace: [] };
      };
      const route = (pickers: RouteAdvisorDependencies["pickers"]) => advisor(runtime, { pickers, updates }).routeBeforeTurn({
        conversationId: runtime.conversationId,
        content: DEBUGGING,
        attachments: [],
      });
      const turnedOff = await route({ rules: slowPicker({ conversationId: runtime.conversationId, routingMode: "manual" }) });
      expect(turnedOff?.summary).toMatchObject({ outcome: "kept", reason: "Kept the current model: the chat changed while routing." });
      expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
        routingMode: "manual",
        modelSelection: expect.objectContaining({ modelId: "gpt-test" }),
      });

      runtime.store.updateConversation(runtime.conversationId, { routingMode: "auto" });
      const fast = nativeSelection({
        providerId: "codex", modelId: "gpt-test", reasoningEffort: "high", providerOptions: { fastMode: "priority" },
      });
      const changed = await route({ rules: slowPicker({ conversationId: runtime.conversationId, modelSelection: fast, routingMode: "auto" }) });
      expect(changed?.summary?.outcome).toBe("kept");
      expect(runtime.store.conversation(runtime.conversationId).modelSelection).toEqual(fast);
    });
  });

  it("drops an invalid previous route instead of failing turn creation", async () => {
    await withAutoChat(ROUTING, async (runtime) => {
      const summary = {
        picker: "rules", tier: "heavy", taskKind: "debugging", confidence: 0.9, outcome: "applied", reason: "Routed.",
      } as const;
      const stub = (routing: object) => ({
        routeBeforeTurn: async () => ({ summary: routing as never, restore: null }),
        restorePreviousRoute: vi.fn(),
      });
      const emptyEffort = await messageSender(runtime, stub({
        ...summary, previousRoute: { providerId: "codex", modelId: "gpt-test", reasoningEffort: "" },
      }))(QUESTION);
      expect(emptyEffort.routing?.previousRoute).toEqual({ providerId: "codex", modelId: "gpt-test", reasoningEffort: null });
      await finish(runtime, "thread-1");
      const unknownProvider = await messageSender(runtime, stub({
        ...summary, previousRoute: { providerId: "elsewhere", modelId: "x", reasoningEffort: null },
      }))(QUESTION);
      expect(unknownProvider.routing).toMatchObject({ outcome: "applied", previousRoute: null });
      await finish(runtime, "thread-1");
      const oversized = await messageSender(runtime, stub({ ...summary, reason: "r".repeat(400), previousRoute: null }))(QUESTION);
      expect(oversized.routing).toBeUndefined();
      await finish(runtime, "thread-1");
    });
  });
});

describe("Auto routing mode changes", () => {
  it("lets the routing mode change during an active run but keeps refusing route changes", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.updateSettings({ routing: ROUTING });
      const updates = new ConversationUpdateService({ store: runtime.store, providers: runtime.provider, backendProfileController });
      await messageSender(runtime)(QUESTION);
      expect(runtime.store.hasActiveWorkspaceRunForConversation(runtime.conversationId)).toBe(true);
      expect(updates.update({ conversationId: runtime.conversationId, routingMode: "auto" }).routingMode).toBe("auto");
      const next = nativeSelection({ providerId: "codex", modelId: "gpt-next", reasoningEffort: "high" });
      expect(() => updates.update({ conversationId: runtime.conversationId, modelSelection: next }))
        .toThrow("Stop the active run or review before changing its agent configuration.");
      expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
        routingMode: "auto",
        modelSelection: expect.objectContaining({ modelId: "gpt-test" }),
      });
      await finish(runtime, "thread-1");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("turns Auto off for a user's model choice but not for Auto routing's own update", async () => {
    await withAutoChat(ROUTING, async (runtime) => {
      const updates = new ConversationUpdateService({ store: runtime.store, providers: runtime.provider, backendProfileController });
      const next = nativeSelection({ providerId: "codex", modelId: "gpt-next", reasoningEffort: "high" });
      expect(updates.update({ conversationId: runtime.conversationId, modelSelection: next }, "auto-routing").routingMode).toBe("auto");
      expect(updates.update({ conversationId: runtime.conversationId, accessMode: "auto-edit" }).routingMode).toBe("auto");
      expect(updates.update({ conversationId: runtime.conversationId, reasoningEffort: "high" }).routingMode).toBe("manual");
      updates.update({ conversationId: runtime.conversationId, routingMode: "auto" });
      expect(updates.update({ conversationId: runtime.conversationId, modelSelection: next }, "user").routingMode).toBe("manual");
      runtime.store.updateConversation(runtime.conversationId, { routingMode: "manual" });
      expect(updates.update({ conversationId: runtime.conversationId, modelSelection: next }, "auto-routing").routingMode).toBe("manual");
    });
  });
});

describe("Auto routing on todo.start", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function todoFixture(routing: RoutingSettingsUpdate, readiness = backendProfileController.readiness) {
    const root = mkdtempSync(join(tmpdir(), "inertia-route-todo-"));
    roots.push(root);
    const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
    store.updateSettings({ routing });
    const project = store.createProject("Tasks", root);
    const providers = { resolveModelRoute: resolveNativeModelRoute } as never;
    const creation = new ConversationCreationService({
      store,
      providers,
      backendProfileController: backendProfileController as never,
      workspaceRuns: {} as never,
      dataDirectory: root,
      broadcastSnapshot: () => undefined,
      providerInfo: () => [turnControllerTestProviderInfo()],
    });
    const turns = {
      queue: vi.fn((_request: { conversationId: string; routing?: unknown }) => ({ turn: { id: "turn-1" } })),
      start: vi.fn(() => true),
      failBeforeStart: vi.fn(() => true),
    };
    const handler = createTodoCommandHandler({
      store,
      creation,
      turns,
      backendProfileController: { ...backendProfileController, readiness },
      enableProviders: true,
      routeAdvisor: advisor({ store, provider: providers }),
      providerInfo: () => [{ ...turnControllerTestProviderInfo() }] as ProviderInfo[],
      broadcastSnapshot: () => undefined,
      send: () => undefined,
    } as unknown as TodoCommandDependencies);
    const start = async (title: string, routingMode?: "manual" | "auto") => {
      const id = randomUUID();
      store.todos.create({ id, title, note: "", priority: "medium", dueDate: null });
      await handler({} as WebSocket, clientCommandSchema.parse({
        type: "todo.start",
        requestId: randomUUID(),
        payload: {
          id,
          conversation: {
            projectId: project.id,
            modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }),
            ...(routingMode ? { routingMode } : {}),
          },
        },
      }));
      return store.conversation(store.todos.get(id)!.conversationId!);
    };
    return { store, turns, start };
  }

  it("creates the task's chat in Auto and routes its first turn like message.send", async () => {
    const { store, turns, start } = todoFixture({ ...ROUTING, autoForNewChats: true });
    try {
      const conversation = await start("Debug the failing tests and fix the error");
      expect(conversation).toMatchObject({ routingMode: "auto", modelSelection: expect.objectContaining({ modelId: "gpt-next" }) });
      expect(turns.queue).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: conversation.id,
        routing: expect.objectContaining({ tier: "heavy", taskKind: "debugging", outcome: "applied" }),
      }));
    } finally {
      store.close();
    }
  });

  it("restores the task's original route when the routed one is not ready", async () => {
    const readiness = vi.fn(async (selection: ModelSelection) => selection.modelId === "gpt-next"
      ? { ready: false, message: "GPT Next is offline." }
      : null);
    const { store, turns, start } = todoFixture({ ...ROUTING, autoForNewChats: true }, readiness);
    try {
      const conversation = await start("Debug the failing tests and fix the error");
      expect(readiness.mock.calls.map(([selection]) => selection.modelId)).toEqual(["gpt-test", "gpt-next", "gpt-test"]);
      expect(conversation).toMatchObject({ routingMode: "auto", modelSelection: expect.objectContaining({ modelId: "gpt-test" }) });
      const request = turns.queue.mock.calls[0]![0] as { routing?: { outcome: string; reason: string } };
      expect(request.routing).toMatchObject({ outcome: "kept", previousRoute: null });
      expect(request.routing!.reason).toContain("GPT Next is offline.");
    } finally {
      store.close();
    }
  });

  it("honours an explicit routing mode and leaves manual tasks unrouted", async () => {
    const { store, turns, start } = todoFixture(ROUTING);
    try {
      const manual = await start("Debug the failing tests and fix the error");
      expect(manual).toMatchObject({ routingMode: "manual", modelSelection: expect.objectContaining({ modelId: "gpt-test" }) });
      expect(turns.queue.mock.calls[0]![0]).not.toHaveProperty("routing");
      const auto = await start("Debug the failing tests and fix the error", "auto");
      expect(auto.routingMode).toBe("auto");
      expect(turns.queue.mock.calls[1]![0]).toHaveProperty("routing.outcome", "applied");
    } finally {
      store.close();
    }
  });
});
