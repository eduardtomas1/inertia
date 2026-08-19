import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";

const roots: string[] = [];

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), "inertia-agent-thread-repository-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const databasePath = join(root, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace);
  const project = store.createProject("Agent-managed chats", workspace);
  const source = store.createConversation(project.id, "Parent");
  const sourceTurn = store.beginAgentTurn({
    id: "source-turn",
    conversationId: source.id,
    runId: "source-run",
    content: "Manage chats",
    activateConversation: false,
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "codex-local",
    model: "provider-default",
    modelAlias: null,
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: 0,
    association: "authoritative",
  }).turn;
  return { databasePath, project, source, sourceTurn, store, workspace };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("agent-thread management repository", () => {
  it("reserves one exact tool-call receipt and rejects conflicting replay", async () => {
    const { source, sourceTurn, store } = await runtime();
    try {
      const input = {
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        toolCallId: "provider-call-1",
        toolName: "inertia_send_message" as const,
        requestFingerprint: "a".repeat(64),
        inputChars: 12,
        now: "2026-08-19T10:00:00.000Z",
      };
      const reserved = store.agentThreadManagement.reserve(input);
      expect(reserved.kind).toBe("reserved");
      expect(store.agentThreadManagement.reserve(input).kind).toBe("replay");
      expect(store.agentThreadManagement.reserve({
        ...input,
        requestFingerprint: "b".repeat(64),
      }).kind).toBe("conflict");
      if (reserved.kind !== "reserved") throw new Error("receipt not reserved");
      expect(reserved.operation.toolCallIdHash).not.toContain("provider-call-1");
    } finally {
      store.close();
    }
  });

  it("enforces per-turn create, mutation, and aggregate input budgets", async () => {
    const { source, sourceTurn, store } = await runtime();
    try {
      const reserve = (
        index: number,
        toolName: "inertia_create_conversation" | "inertia_send_message",
        inputChars = 1,
      ) => store.agentThreadManagement.reserve({
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        toolCallId: `call-${index}`,
        toolName,
        requestFingerprint: String(index).padStart(64, "0"),
        inputChars,
        now: `2026-08-19T10:00:${String(index).padStart(2, "0")}.000Z`,
      });
      for (let index = 0; index < 4; index += 1) {
        expect(reserve(index, "inertia_create_conversation").kind)
          .toBe("reserved");
      }
      expect(reserve(4, "inertia_create_conversation").kind).toBe("limit");
      for (let index = 4; index < 8; index += 1) {
        expect(reserve(index, "inertia_send_message").kind).toBe("reserved");
      }
      expect(reserve(8, "inertia_send_message").kind).toBe("limit");

      const secondTurn = store.beginAgentTurn({
        id: "source-turn-2",
        conversationId: source.id,
        runId: "source-run-2",
        content: "Try a bounded prompt",
        activateConversation: false,
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfileId: "codex-local",
        model: "provider-default",
        modelAlias: null,
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision: 0,
        association: "authoritative",
      }).turn;
      expect(store.agentThreadManagement.reserve({
        sourceConversationId: source.id,
        sourceTurnId: secondTurn.id,
        sourceRunId: secondTurn.runId,
        toolCallId: "large-1",
        toolName: "inertia_send_message",
        requestFingerprint: "c".repeat(64),
        inputChars: 65_536,
        now: "2026-08-19T10:01:00.000Z",
      }).kind).toBe("reserved");
      expect(store.agentThreadManagement.reserve({
        sourceConversationId: source.id,
        sourceTurnId: secondTurn.id,
        sourceRunId: secondTurn.runId,
        toolCallId: "large-2",
        toolName: "inertia_send_message",
        requestFingerprint: "d".repeat(64),
        inputChars: 1,
        now: "2026-08-19T10:01:01.000Z",
      }).kind).toBe("limit");
    } finally {
      store.close();
    }
  });

  it("persists open harness provenance and bounds recursive managed depth", async () => {
    const { project, source, sourceTurn, store } = await runtime();
    try {
      const child = store.createConversation(project.id, "Child", { activate: false });
      const managed = store.agentThreadManagement.attachManaged({
        childConversationId: child.id,
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        sourceHarnessId: "future-harness:v1",
        now: "2026-08-19T10:00:00.000Z",
      });
      expect(managed).toMatchObject({
        rootConversationId: source.id,
        sourceHarnessId: "future-harness:v1",
        depth: 1,
      });

      const childTurn = store.beginAgentTurn({
        id: "child-turn",
        conversationId: child.id,
        runId: "child-run",
        content: "Create one nested chat",
        activateConversation: false,
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfileId: "codex-local",
        model: "provider-default",
        modelAlias: null,
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision: 0,
        association: "authoritative",
      }).turn;
      const grandchild = store.createConversation(
        project.id,
        "Grandchild",
        { activate: false },
      );
      expect(store.agentThreadManagement.attachManaged({
        childConversationId: grandchild.id,
        sourceConversationId: child.id,
        sourceTurnId: childTurn.id,
        sourceRunId: childTurn.runId,
        sourceHarnessId: "codex-app-server",
        now: "2026-08-19T10:01:00.000Z",
      })).toMatchObject({ rootConversationId: source.id, depth: 2 });

      const grandchildTurn = store.beginAgentTurn({
        id: "grandchild-turn",
        conversationId: grandchild.id,
        runId: "grandchild-run",
        content: "Try to exceed the depth",
        activateConversation: false,
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfileId: "codex-local",
        model: "provider-default",
        modelAlias: null,
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision: 0,
        association: "authoritative",
      }).turn;
      const tooDeep = store.createConversation(project.id, "Too deep", {
        activate: false,
      });
      expect(() => store.agentThreadManagement.attachManaged({
        childConversationId: tooDeep.id,
        sourceConversationId: grandchild.id,
        sourceTurnId: grandchildTurn.id,
        sourceRunId: grandchildTurn.runId,
        sourceHarnessId: "codex-app-server",
        now: "2026-08-19T10:02:00.000Z",
      })).toThrow("cannot create another chat at this depth");
    } finally {
      store.close();
    }
  });

  it("links child provenance and the durable creation receipt atomically", async () => {
    const { project, source, sourceTurn, store } = await runtime();
    try {
      const child = store.createConversation(project.id, "Atomic child", {
        activate: false,
      });
      expect(() => store.agentThreadManagement.attachManaged({
        childConversationId: child.id,
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        sourceHarnessId: "codex-app-server",
        now: "2026-08-19T10:00:00.000Z",
      }, "missing-operation")).toThrow("expected state");
      expect(store.agentThreadManagement.managed(child.id)).toBeNull();

      const reserved = store.agentThreadManagement.reserve({
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        toolCallId: "create-atomic",
        toolName: "inertia_create_conversation",
        requestFingerprint: "f".repeat(64),
        inputChars: 10,
        now: "2026-08-19T10:00:01.000Z",
      });
      if (reserved.kind !== "reserved") throw new Error("receipt not reserved");
      store.agentThreadManagement.transition(
        reserved.operation.id,
        ["approval-pending"],
        "approved",
        {},
        "2026-08-19T10:00:02.000Z",
      );
      store.agentThreadManagement.transition(
        reserved.operation.id,
        ["approved"],
        "creating",
        {},
        "2026-08-19T10:00:03.000Z",
      );
      expect(store.agentThreadManagement.attachManaged({
        childConversationId: child.id,
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceRunId: sourceTurn.runId,
        sourceHarnessId: "codex-app-server",
        now: "2026-08-19T10:00:04.000Z",
      }, reserved.operation.id)).toMatchObject({ childConversationId: child.id });
      expect(store.agentThreadManagement.operation(reserved.operation.id))
        .toMatchObject({
          status: "dispatching",
          childConversationId: child.id,
        });
    } finally {
      store.close();
    }
  });

  it("keeps provenance after restart while interrupting ephemeral ownership", async () => {
    const { databasePath, project, source, sourceTurn, store, workspace } =
      await runtime();
    const child = store.createConversation(project.id, "Restart child", {
      activate: false,
    });
    const managed = store.agentThreadManagement.attachManaged({
      childConversationId: child.id,
      sourceConversationId: source.id,
      sourceTurnId: sourceTurn.id,
      sourceRunId: sourceTurn.runId,
      sourceHarnessId: "codex-app-server",
      now: "2026-08-19T10:00:00.000Z",
    });
    const reserved = store.agentThreadManagement.reserve({
      sourceConversationId: source.id,
      sourceTurnId: sourceTurn.id,
      sourceRunId: sourceTurn.runId,
      toolCallId: "restart-call",
      toolName: "inertia_send_message",
      requestFingerprint: "e".repeat(64),
      inputChars: 10,
      now: "2026-08-19T10:00:01.000Z",
    });
    if (reserved.kind !== "reserved") throw new Error("receipt not reserved");
    store.agentThreadManagement.transition(
      reserved.operation.id,
      ["approval-pending"],
      "approved",
      {},
      "2026-08-19T10:00:02.000Z",
    );
    store.close();

    const restarted = new RuntimeStore(databasePath, workspace);
    try {
      expect(restarted.agentThreadManagement.managed(child.id)).toEqual(managed);
      expect(restarted.agentThreadManagement.operation(reserved.operation.id))
        .toMatchObject({
          status: "interrupted",
          failureMessage: expect.stringContaining("host restarted"),
        });
    } finally {
      restarted.close();
    }
  });
});
