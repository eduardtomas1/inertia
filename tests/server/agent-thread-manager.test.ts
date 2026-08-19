import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import type { ProviderHostToolCall } from "../../src/server/provider/contracts";
import type { AgentApprovalDecision } from "../../src/server/provider/interactions";

const roots: string[] = [];

async function runtime() {
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
  const starts: string[] = [];
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
      starts.push(turnId);
      active.add(turn.conversationId);
      return true;
    },
    failBeforeStart: vi.fn(),
    cancel: (conversationId: string) => active.delete(conversationId),
    waitForProviderCleanup: async () => undefined,
    acquireFollowUpAdmission: () => null,
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
    providerInfo: () => [{
      id: "codex",
      canRun: true,
      statusMessage: null,
    }] as never,
    broadcastSnapshot: vi.fn(),
    broadcastConversationShell: vi.fn(),
    now: () => "2026-08-19T10:00:00.000Z",
  });
  return { manager, project, source, sourceTurn, starts, store, turns };
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
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("AgentThreadManager", () => {
  it("capability-gates the real host bridge to Codex App Server turns", async () => {
    const { manager, source, sourceTurn, store } = await runtime();
    try {
      expect(manager.bridgeFor({ conversation: source, turn: sourceTurn }))
        .toBeDefined();
      expect(manager.bridgeFor({
        conversation: source,
        turn: { ...sourceTurn, harnessId: "claude-agent-sdk" },
      })).toBeUndefined();
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
