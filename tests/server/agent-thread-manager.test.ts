import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import {
  ConversationContextRequestCoordinator,
} from "../../src/server/runtime/conversation-context-request-coordinator";
import type { ProviderHostToolCall } from "../../src/server/provider/contracts";
import type { AgentApprovalDecision } from "../../src/server/provider/interactions";

const roots: string[] = [];

async function runtime(agentBrowser?: { perform: ReturnType<typeof vi.fn> }) {
  const root = await mkdtemp(join(tmpdir(), "inertia-agent-thread-manager-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace);
  const project = store.createProject("Managed project", workspace);
  const source = store.createConversation(project.id, "Parent chat", {
    accessMode: "supervised",
  });
  const sourceTurn = store.beginAgentTurn({
    id: "source-turn",
    conversationId: source.id,
    runId: "source-run",
    content: "Manage another top-level chat",
    activateConversation: false,
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: source.modelSelection.backendProfileId,
    model: source.modelSelection.modelId,
    modelAlias: source.modelSelection.alias,
    reasoningEffort: source.modelSelection.reasoningEffort ?? "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: source.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
  const active = new Set<string>();
  const terminalResumes = new Set<string>();
  let reservationHeldDuringStart = false;
  const providerTerminalResumes = {
    isActive: (conversationId: string) => terminalResumes.has(conversationId),
    acquire: vi.fn((conversationId: string) => {
      if (terminalResumes.has(conversationId)) return false;
      terminalResumes.add(conversationId);
      return true;
    }),
    release: vi.fn((conversationId: string) => {
      terminalResumes.delete(conversationId);
    }),
    setActive: (conversationId: string, value: boolean) => {
      if (value) terminalResumes.add(conversationId);
      else terminalResumes.delete(conversationId);
    },
    reservationHeldDuringStart: () => reservationHeldDuringStart,
  };
  const starts: string[] = [];
  let followUps = 0;
  let followUpAdmission = true;
  const turns = {
    isActive: (conversationId: string) => active.has(conversationId),
    activeConversationIds: () => [...active],
    queue: (request: {
      conversationId: string;
      content: string;
      activateConversation: boolean;
    }) => {
      const conversation = store.conversation(request.conversationId);
      return store.beginAgentTurn({
        id: `child-turn-${starts.length + 1}`,
        conversationId: conversation.id,
        runId: `child-run-${starts.length + 1}`,
        content: request.content,
        activateConversation: request.activateConversation,
        providerId: conversation.providerId,
        harnessId: conversation.modelSelection.harnessId,
        backendProfileId: conversation.modelSelection.backendProfileId,
        model: conversation.modelSelection.modelId,
        modelAlias: conversation.modelSelection.alias,
        reasoningEffort: conversation.modelSelection.reasoningEffort ?? "",
        interactionMode: conversation.interactionMode,
        accessMode: conversation.accessMode,
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision:
          conversation.modelSelection.backendConfigurationRevision,
        association: "authoritative",
      });
    },
    start: (turnId: string) => {
      const turn = store.agentTurn(turnId);
      reservationHeldDuringStart ||= terminalResumes.has(turn.conversationId);
      starts.push(turnId);
      active.add(turn.conversationId);
      return true;
    },
    failBeforeStart: vi.fn(),
    cancel: (conversationId: string) => active.delete(conversationId),
    waitForProviderCleanup: async () => undefined,
    acquireFollowUpAdmission: (conversationId: string) => (
      active.has(conversationId) && followUpAdmission
        ? { conversationId, release: vi.fn() }
        : null
    ),
    setFollowUpAdmission: (accepted: boolean) => {
      followUpAdmission = accepted;
    },
    steer: async () => ({ turnId: `follow-up-${++followUps}` }),
  };
  const creation = {
    create: async (payload: Parameters<RuntimeStore["createConversation"]>[2] & {
      projectId: string;
      title: string;
    }) => store.createConversation(payload.projectId, payload.title, {
      ...payload,
      activate: false,
    }),
  };
  const pendingInputs = new Map();
  const contextRequests = new ConversationContextRequestCoordinator({
    pendingInputs,
    broadcast: vi.fn(),
    broadcastConversationShell: vi.fn(),
  });
  const manager = new AgentThreadManager({
    store,
    providers: {
      resolveModelRoute: () => ({ providerId: "codex" }),
    } as never,
    backendProfileController: {
      validateSelection: (selection: typeof source.modelSelection) => selection,
      readiness: async () => null,
    } as never,
    creation: creation as never,
    turns: turns as never,
    providerTerminalResumes,
    contextRequests,
    agentBrowser: agentBrowser as never,
    providerInfo: () => [{
      id: "codex",
      canRun: true,
      statusMessage: null,
    }] as never,
    broadcastSnapshot: vi.fn(),
    broadcastConversationShell: vi.fn(),
    broadcast: vi.fn(),
    now: () => "2026-08-19T10:00:00.000Z",
  });
  let sourceTurnSequence = 1;
  const beginSourceTurn = () => store.beginAgentTurn({
    id: `source-turn-${++sourceTurnSequence}`,
    conversationId: source.id,
    runId: `source-run-${sourceTurnSequence}`,
    content: "Continue managing the child chat",
    activateConversation: false,
    providerId: source.providerId,
    harnessId: source.modelSelection.harnessId,
    backendProfileId: source.modelSelection.backendProfileId,
    model: source.modelSelection.modelId,
    modelAlias: source.modelSelection.alias,
    reasoningEffort: source.modelSelection.reasoningEffort ?? "",
    interactionMode: source.interactionMode,
    accessMode: source.accessMode,
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: source.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
  return {
    beginSourceTurn,
    manager,
    contextRequests,
    pendingInputs,
    providerTerminalResumes,
    project,
    source,
    sourceTurn,
    starts,
    store,
    turns,
  };
}

function call(
  tool: string,
  args: unknown,
  decision: AgentApprovalDecision = "approve",
): ProviderHostToolCall {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: `tool-${tool}-${JSON.stringify(args)}`,
    tool,
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => decision),
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("AgentThreadManager", () => {
  it("exposes the same real host bridge to every audited provider harness", async () => {
    const browser = { perform: vi.fn() };
    const { manager, source, sourceTurn, store } = await runtime(browser);
    try {
      for (const harnessId of [
        "codex-app-server",
        "claude-agent-sdk",
        "cursor-acp",
        "kimi-acp",
        "opencode-sdk",
      ] as const) {
        const bridge = manager.bridgeFor({
          conversation: source,
          turn: { ...sourceTurn, harnessId },
        });
        expect(bridge?.definitions.map(({ name }) => name)).toEqual(
          expect.arrayContaining([
            "inertia_browser_snapshot",
            "inertia_browser_screenshot",
            "inertia_browser_navigate",
            "inertia_browser_interact",
            "inertia_browser_tabs",
          ]),
        );
      }
    } finally {
      store.close();
    }
  });

  it("advertises and validates Kimi as a managed child route", async () => {
    const { manager, source, sourceTurn, store } = await runtime();
    try {
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
      const definition = bridge?.definitions.find(
        ({ name }) => name === "inertia_create_conversation",
      );
      const route = (definition?.inputSchema.properties as {
        route?: {
          properties?: { providerId?: { enum?: string[] } };
        };
      } | undefined)?.route;
      expect(route?.properties?.providerId?.enum).toContain("kimi");
      expect(definition?.inputValidator?.safeParse({
        title: "Kimi verifier",
        prompt: "Inspect independently.",
        route: { providerId: "kimi" },
      }).success).toBe(true);
    } finally {
      store.close();
    }
  });

  it("lists only safe same-project configuration without transcript leakage", async () => {
    const { manager, project, source, sourceTurn, store } = await runtime();
    try {
      const sibling = store.createConversation(project.id, "Sibling chat", {
        activate: false,
      });
      store.createMessage(sibling.id, "SECRET TRANSCRIPT", "assistant");
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
      const result = await bridge!.invoke(call(
        "inertia_list_conversations",
        { limit: 10 },
      ));
      expect(result.success).toBe(true);
      expect(result.text).toContain("Sibling chat");
      expect(result.text).not.toContain("SECRET TRANSCRIPT");
      expect(result.text).not.toContain(store.conversationPath(sibling.id));
      expect(result.text).not.toContain("providerSessionId");
    } finally {
      store.close();
    }
  });

  it("returns only the exact user-selected bounded context and replays it verbatim", async () => {
    const {
      contextRequests,
      manager,
      pendingInputs,
      project,
      source,
      sourceTurn,
      store,
    } = await runtime();
    try {
      const sibling = store.createConversation(project.id, "Prior design", {
        activate: false,
      });
      const selected = store.createMessage(
        sibling.id,
        "Use token sk-secret-value-123456789 only in this test.",
        "assistant",
      );
      store.createMessage(sibling.id, "This must stay unselected.", "user");
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn })!;
      expect(bridge.definitions.map(({ name }) => name))
        .toContain("inertia_request_context");
      const requestCall = call("inertia_request_context", {
        sourceConversationId: sibling.id,
      });
      const resultPromise = bridge.invoke(requestCall);
      const chooser = [...pendingInputs.values()][0];
      expect(chooser?.conversationContextRequest).toMatchObject({
        targetConversationId: source.id,
        requestedSourceConversationId: sibling.id,
      });
      expect(contextRequests.respond({
        requestId: chooser!.id,
        targetConversationId: source.id,
        selection: {
          sourceConversationId: sibling.id,
          sourceMessageIds: [selected.id],
          acknowledgedWorkspaceDifference: false,
        },
      })).toBe(true);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.text).toContain("[redacted]");
      expect(result.text).not.toContain("sk-secret-value");
      expect(result.text).not.toContain("This must stay unselected");
      const durable = store.contextPackets.agentRequest(chooser!.id);
      expect(durable).toMatchObject({
        status: "completed",
        targetTurnId: sourceTurn.id,
        selectedSourceConversationId: sibling.id,
      });
      expect(store.contextPackets.get(durable!.packetId!, source.id))
        .toMatchObject({ consumedMessageId: sourceTurn.userMessageId });

      const replay = await bridge.invoke(call("inertia_request_context", {
        sourceConversationId: sibling.id,
      }));
      expect(replay).toEqual(result);
      expect(store.conversationDetail(source.id)?.contextPackets).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("interrupts a pending context chooser when its exact source turn settles", async () => {
    const { manager, pendingInputs, source, sourceTurn, store } = await runtime();
    try {
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn })!;
      const resultPromise = bridge.invoke(call("inertia_request_context", {}));
      const chooser = [...pendingInputs.values()][0]!;

      await manager.onSourceTurnSettled({ ...sourceTurn, status: "failed" });

      await expect(resultPromise).resolves.toMatchObject({ success: false });
      expect(pendingInputs.size).toBe(0);
      expect(store.contextPackets.agentRequest(chooser.id)).toMatchObject({
        status: "interrupted",
      });
    } finally {
      store.close();
    }
  });

  it("never accepts provider-authored message selection and durably expires silence", async () => {
    const { manager, pendingInputs, source, sourceTurn, store } = await runtime();
    try {
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn })!;
      const forged = await bridge.invoke(call("inertia_request_context", {
        sourceMessageIds: ["33333333-3333-4333-8333-333333333333"],
      }));
      expect(forged.success).toBe(false);
      expect(pendingInputs.size).toBe(0);

      vi.useFakeTimers();
      const expiration = bridge.invoke(call("inertia_request_context", {}));
      const chooser = [...pendingInputs.values()][0]!;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(expiration).resolves.toMatchObject({ success: false });
      expect(store.contextPackets.agentRequest(chooser.id)).toMatchObject({
        status: "expired",
      });
    } finally {
      store.close();
    }
  });

  it("reports exact management ownership for an older recently active child", async () => {
    const { manager, project, source, sourceTurn, store } = await runtime();
    try {
      const oldest = store.createConversation(project.id, "Old managed chat", {
        activate: false,
      });
      store.agentThreadManagement.attachManaged({
        childConversationId: oldest.id,
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        sourceHarnessId: sourceTurn.harnessId,
        now: "2026-08-19T10:00:00.000Z",
      });
      for (let index = 1; index <= 25; index += 1) {
        const child = store.createConversation(
          project.id,
          `Newer managed chat ${index}`,
          { activate: false },
        );
        store.agentThreadManagement.attachManaged({
          childConversationId: child.id,
          sourceConversationId: source.id,
          sourceTurnId: sourceTurn.id,
          sourceRunId: sourceTurn.runId,
          sourceHarnessId: sourceTurn.harnessId,
          now: `2026-08-19T10:00:${String(index).padStart(2, "0")}.000Z`,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.updateConversation(oldest.id, { title: "Old managed chat, active now" });

      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
      const result = await bridge!.invoke(call(
        "inertia_list_conversations",
        { limit: 25 },
      ));
      const payload = JSON.parse(result.text) as {
        conversations: Array<{
          conversationId: string;
          managedByCaller: boolean;
        }>;
      };
      expect(payload.conversations.find(
        ({ conversationId }) => conversationId === oldest.id,
      )).toMatchObject({ managedByCaller: true });
    } finally {
      store.close();
    }
  });

  it("cancels a child dispatched by a later parent turn when that turn fails", async () => {
    const {
      beginSourceTurn,
      manager,
      project,
      source,
      sourceTurn,
      store,
      turns,
    } = await runtime();
    try {
      const child = store.createConversation(project.id, "Existing child", {
        activate: false,
      });
      store.agentThreadManagement.attachManaged({
        childConversationId: child.id,
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        sourceHarnessId: sourceTurn.harnessId,
        now: "2026-08-19T10:00:00.000Z",
      });
      const laterTurn = beginSourceTurn();
      const bridge = manager.bridgeFor({ conversation: source, turn: laterTurn });
      expect((await bridge!.invoke(call("inertia_send_message", {
        conversationId: child.id,
        content: "Start a later independent check",
      }))).success).toBe(true);
      expect(turns.isActive(child.id)).toBe(true);

      await manager.onSourceTurnSettled({ ...laterTurn, status: "failed" });

      expect(turns.isActive(child.id)).toBe(false);
      expect(store.agentThreadManagement.targetsActedOnByTurn(
        source.id,
        laterTurn.id,
      )).toEqual([child.id]);
    } finally {
      store.close();
    }
  });

  it("keeps a follow-up running after completion but cancels it after failure", async () => {
    const {
      beginSourceTurn,
      manager,
      project,
      source,
      sourceTurn,
      store,
      turns,
    } = await runtime();
    try {
      const child = store.createConversation(project.id, "Follow-up child", {
        activate: false,
      });
      store.agentThreadManagement.attachManaged({
        childConversationId: child.id,
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        sourceHarnessId: sourceTurn.harnessId,
        now: "2026-08-19T10:00:00.000Z",
      });
      const completedParent = beginSourceTurn();
      const completedBridge = manager.bridgeFor({
        conversation: source,
        turn: completedParent,
      });
      expect((await completedBridge!.invoke(call("inertia_send_message", {
        conversationId: child.id,
        content: "Start work that should continue",
      }))).success).toBe(true);
      await manager.onSourceTurnSettled({
        ...completedParent,
        status: "completed",
      });
      expect(turns.isActive(child.id)).toBe(true);

      const failedParent = beginSourceTurn();
      const failedBridge = manager.bridgeFor({
        conversation: source,
        turn: failedParent,
      });
      const followUp = await failedBridge!.invoke(call("inertia_send_message", {
        conversationId: child.id,
        content: "Add one follow-up while the child runs",
      }));
      expect(followUp.success).toBe(true);
      expect(JSON.parse(followUp.text)).toMatchObject({ disposition: "follow-up" });

      await manager.onSourceTurnSettled({ ...failedParent, status: "cancelled" });

      expect(turns.isActive(child.id)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("does not claim or cancel active work when follow-up admission is rejected", async () => {
    const {
      beginSourceTurn,
      manager,
      project,
      source,
      sourceTurn,
      store,
      turns,
    } = await runtime();
    try {
      const child = store.createConversation(project.id, "Busy child", {
        activate: false,
      });
      store.agentThreadManagement.attachManaged({
        childConversationId: child.id,
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        sourceHarnessId: sourceTurn.harnessId,
        now: "2026-08-19T10:00:00.000Z",
      });
      const startingParent = beginSourceTurn();
      const startingBridge = manager.bridgeFor({
        conversation: source,
        turn: startingParent,
      });
      expect((await startingBridge!.invoke(call("inertia_send_message", {
        conversationId: child.id,
        content: "Start work that belongs to the earlier turn",
      }))).success).toBe(true);
      await manager.onSourceTurnSettled({
        ...startingParent,
        status: "completed",
      });
      expect(turns.isActive(child.id)).toBe(true);

      turns.setFollowUpAdmission(false);
      const rejectedParent = beginSourceTurn();
      const rejectedBridge = manager.bridgeFor({
        conversation: source,
        turn: rejectedParent,
      });
      const rejected = await rejectedBridge!.invoke(call(
        "inertia_send_message",
        {
          conversationId: child.id,
          content: "This follow-up cannot be admitted",
        },
      ));
      expect(rejected.success).toBe(false);
      expect(store.agentThreadManagement.targetsActedOnByTurn(
        source.id,
        rejectedParent.id,
      )).toEqual([]);

      await manager.onSourceTurnSettled({
        ...rejectedParent,
        status: "failed",
      });

      expect(turns.isActive(child.id)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("does not dispatch or archive across an active provider terminal", async () => {
    const {
      manager,
      project,
      providerTerminalResumes,
      source,
      sourceTurn,
      starts,
      store,
    } = await runtime();
    try {
      const child = store.createConversation(project.id, "Terminal-owned child", {
        activate: false,
      });
      store.agentThreadManagement.attachManaged({
        childConversationId: child.id,
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        sourceHarnessId: sourceTurn.harnessId,
        now: "2026-08-19T10:00:00.000Z",
      });
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
      providerTerminalResumes.setActive(child.id, true);

      const send = await bridge!.invoke(call("inertia_send_message", {
        conversationId: child.id,
        content: "Do not race the resumed native session.",
      }));
      const archive = await bridge!.invoke(call("inertia_archive_conversation", {
        conversationId: child.id,
        archived: true,
      }));

      expect(send.success).toBe(false);
      expect(send.text).toContain("resumed provider terminal");
      expect(archive.success).toBe(false);
      expect(starts).toEqual([]);
      expect(store.conversation(child.id).archivedAt).toBeNull();

      providerTerminalResumes.setActive(child.id, false);
      const accepted = await bridge!.invoke(call("inertia_send_message", {
        conversationId: child.id,
        content: "Start only after terminal ownership ends.",
      }));
      expect(accepted.success).toBe(true);
      expect(providerTerminalResumes.reservationHeldDuringStart()).toBe(true);
      expect(providerTerminalResumes.isActive(child.id)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("does not create or dispatch compute when the user denies approval", async () => {
    const { manager, source, sourceTurn, starts, store } = await runtime();
    try {
      const before = store.shellSnapshot().conversations.length;
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
      const result = await bridge!.invoke(call(
        "inertia_create_conversation",
        {
          title: "Denied child",
          prompt: "Do not run",
          accessMode: "supervised",
          workspace: { kind: "project" },
        },
        "deny",
      ));
      expect(result).toMatchObject({ success: false });
      expect(result.text).toContain("user_denied");
      expect(store.shellSnapshot().conversations).toHaveLength(before);
      expect(starts).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("creates, proves provenance, and dispatches one approved independent chat", async () => {
    const { manager, source, sourceTurn, starts, store, turns } = await runtime();
    try {
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
      const toolCall = call("inertia_create_conversation", {
        title: "Independent verifier",
        prompt: "Inspect the implementation independently.",
        interactionMode: "plan",
        accessMode: "supervised",
        workspace: { kind: "project" },
      });
      const result = await bridge!.invoke(toolCall);
      expect(result.success).toBe(true);
      const receipt = JSON.parse(result.text) as {
        conversationId: string;
        turnId: string;
      };
      expect(starts).toEqual([receipt.turnId]);
      expect(turns.isActive(receipt.conversationId)).toBe(true);
      expect(store.conversation(receipt.conversationId)).toMatchObject({
        title: "Independent verifier",
        interactionMode: "plan",
        accessMode: "supervised",
      });
      expect(store.agentThreadManagement.managed(receipt.conversationId))
        .toMatchObject({
          sourceConversationId: source.id,
          sourceTurnId: sourceTurn.id,
          sourceRunId: sourceTurn.runId,
          sourceHarnessId: "codex-app-server",
          depth: 1,
        });
      const operations = (store as unknown as {
        agentThreadManagement: {
          managed(id: string): unknown;
        };
      }).agentThreadManagement;
      expect(operations.managed(receipt.conversationId)).not.toBeNull();
      expect(toolCall.requestApproval).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it("refuses access escalation before asking for approval", async () => {
    const { manager, source, sourceTurn, starts, store } = await runtime();
    try {
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
      const toolCall = call(
        "inertia_create_conversation",
        {
          title: "Escalated child",
          prompt: "Try full access",
          accessMode: "full",
          workspace: { kind: "project" },
        },
      );
      const result = await bridge!.invoke(toolCall);
      expect(result).toMatchObject({ success: false });
      expect(result.text).toContain("cannot exceed");
      expect(starts).toEqual([]);
      expect(toolCall.requestApproval).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("serializes approved handoffs so parallel creates cannot exceed three live children", async () => {
    const { manager, source, sourceTurn, starts, store } = await runtime();
    try {
      const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
      const results = await Promise.all(Array.from({ length: 4 }, (_, index) =>
        bridge!.invoke(call("inertia_create_conversation", {
          title: `Parallel child ${index + 1}`,
          prompt: `Run independent check ${index + 1}`,
          accessMode: "supervised",
          workspace: { kind: "project" },
        }))));

      expect(results.filter(({ success }) => success)).toHaveLength(3);
      expect(results.find(({ success }) => !success)?.text).toContain(
        "already has three managed chats running",
      );
      expect(starts).toHaveLength(3);
    } finally {
      store.close();
    }
  });
});
