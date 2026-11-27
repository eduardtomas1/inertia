import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Conversation } from "../../src/shared/contracts";
import type { DelegatedCompletionAttribution } from "../../src/shared/orchestration-delegation";
import type { WatcherNoteAttribution } from "../../src/shared/watcher";
import { RuntimeStore } from "../../src/server/database";
import {
  MAX_UNATTENDED_RESENDS,
  countDurableProcessLosses,
  hasProviderTurnObservation,
  reconcileQueueOnBoot,
} from "../../src/server/runtime/queue-boot-reconciliation";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

interface Fixture {
  root: string;
  dbPath: string;
  workspace: string;
  store: RuntimeStore;
  projectId: string;
  conversation: Conversation;
  reopen: () => RuntimeStore;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "inertia-unattended-resend-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  roots.push(root);
  const dbPath = join(root, "inertia.sqlite");
  const store = new RuntimeStore(dbPath, workspace, { recoverInterruptedRuns: false });
  const project = store.createProject("Unattended Resend", workspace);
  const conversation = store.createConversation(project.id, "Worker chat", { accessMode: "full" });
  return {
    root,
    dbPath,
    workspace,
    store,
    projectId: project.id,
    conversation,
    reopen: () => new RuntimeStore(dbPath, workspace, { recoverInterruptedRuns: false }),
  };
}

function beginTurn(
  store: RuntimeStore,
  conversation: Conversation,
  options: {
    turnId?: string;
    runId?: string;
    content: string;
    queuedMessageId?: string;
    commandId?: string;
    actorId?: string;
  },
) {
  const turnId = options.turnId ?? randomUUID();
  const runId = options.runId ?? randomUUID();
  const input = {
    id: turnId,
    conversationId: conversation.id,
    runId,
    content: options.content,
    activateConversation: false,
    providerId: "codex" as const,
    harnessId: "codex-app-server" as const,
    backendProfileId: conversation.modelSelection.backendProfileId,
    model: conversation.modelSelection.modelId,
    modelAlias: conversation.modelSelection.alias,
    reasoningEffort: conversation.modelSelection.reasoningEffort ?? "",
    interactionMode: "build" as const,
    accessMode: conversation.accessMode,
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative" as const,
    ...(options.queuedMessageId ? { queuedMessageId: options.queuedMessageId } : {}),
  };
  return store.orchestration.admit(
    input,
    () => store.beginAgentTurn(input),
    {
      actorId: options.actorId ?? "runtime",
      commandId: options.commandId ?? `run-start:${runId}`,
      command: { type: "run.start", conversationId: conversation.id, runId },
    },
  );
}

function interruptNeverStartedTurn(store: RuntimeStore, turnId: string): void {
  store.updateAgentTurnLifecycle(turnId, {
    status: "interrupted",
    terminalReason: "runtime-restarted",
  });
  store.orchestration.synchronize(store.agentTurn(turnId), undefined, "not-delivered");
  const turn = store.agentTurn(turnId);
  store.orchestration.cleanup({ turnId: turn.id, runId: turn.runId }, "confirmed");
}

function watcherNote(): WatcherNoteAttribution {
  return {
    linkId: randomUUID(),
    wakeId: randomUUID(),
    watcherConversationId: randomUUID(),
    preset: "reviewer",
    watcherLabel: "Reviewer",
    delivery: "queue",
    automatic: true,
  };
}

function delegatedCompletion(parentConversationId: string): DelegatedCompletionAttribution {
  return {
    parentConversationId,
    generation: 1,
    taskIds: ["a".repeat(64)],
  };
}

describe("D.6 unattended never-started prompt resend & durable processLossCount", () => {
  it("releases unattended MCP and scheduled never-started prompts for resend on boot and preserves creationSource", async () => {
    const fixture = createFixture();
    try {
      // 1. MCP prompt queued, claimed, delivered into a turn, then interrupted before any provider turn observation.
      const mcpItemId = randomUUID();
      fixture.store.orchestration.queue.enqueue({
        conversationId: fixture.conversation.id,
        itemId: mcpItemId,
        content: "Run automated migration check",
        kind: "message",
        createdBy: "agent",
        creationSource: "mcp",
      });
      fixture.store.orchestration.queue.claim({
        conversationId: fixture.conversation.id,
        itemId: mcpItemId,
        mode: "run",
      });
      const mcpStarted = beginTurn(fixture.store, fixture.conversation, {
        content: "Run automated migration check",
        queuedMessageId: mcpItemId,
      });
      interruptNeverStartedTurn(fixture.store, mcpStarted.turn.id);

      // 2. Scheduled prompt started on a sibling conversation via limit-reset command, interrupted before provider observation.
      const scheduledConv = fixture.store.createConversation(fixture.projectId, "Scheduled chat", {
        accessMode: "full",
      });
      const scheduledStarted = beginTurn(fixture.store, scheduledConv, {
        content: "Resume after usage limit reset",
        commandId: `limit-reset:${randomUUID()}`,
      });
      interruptNeverStartedTurn(fixture.store, scheduledStarted.turn.id);

      expect(
        hasProviderTurnObservation(
          fixture.store.orchestration.effects.connection,
          fixture.conversation.id,
          mcpStarted.turn.runId,
        ),
      ).toBe(false);

      const report = await reconcileQueueOnBoot(fixture.store);
      expect(report.resendsScheduled).toContain(mcpItemId);
      expect(report.resendsExhausted).toEqual([]);
      expect(report.requeuedUndelivered).toContain(mcpItemId);

      const mcpItem = fixture.store.orchestration.queue.getItem(mcpItemId);
      expect(mcpItem).toMatchObject({
        state: "waiting",
        queueHeld: false,
        creationSource: "mcp",
        createdBy: "agent",
      });

      const scheduledItems = fixture.store.orchestration.queue.listActive(scheduledConv.id);
      expect(scheduledItems).toHaveLength(1);
      expect(scheduledItems[0]).toMatchObject({
        state: "waiting",
        queueHeld: false,
        createdBy: "system",
      });
      expect(report.resendsScheduled).toContain(scheduledItems[0]!.id);
      expect(fixture.store.orchestration.events.verify({ readable: true }).valid).toBe(true);
    } finally {
      fixture.store.close();
    }
  });

  it("never treats a turn with a provider-turn observation as never-started even when interrupted", async () => {
    const fixture = createFixture();
    try {
      const mcpItemId = randomUUID();
      fixture.store.orchestration.queue.enqueue({
        conversationId: fixture.conversation.id,
        itemId: mcpItemId,
        content: "Already observed by provider",
        kind: "message",
        createdBy: "agent",
        creationSource: "mcp",
      });
      fixture.store.orchestration.queue.claim({
        conversationId: fixture.conversation.id,
        itemId: mcpItemId,
        mode: "run",
      });
      const started = beginTurn(fixture.store, fixture.conversation, {
        content: "Already observed by provider",
        queuedMessageId: mcpItemId,
      });

      // Record a real provider native-boundary observation for the run before interrupting.
      fixture.store.orchestration.nativeBoundaries.observe(started.turn, {
        nativeConversationId: "native-conv-1",
        nativeSessionId: "native-sess-1",
        nativeTurnId: "native-turn-1",
        persistedHeadId: "head-1",
        phase: "started",
      });
      interruptNeverStartedTurn(fixture.store, started.turn.id);

      expect(
        hasProviderTurnObservation(
          fixture.store.orchestration.effects.connection,
          fixture.conversation.id,
          started.turn.runId,
        ),
      ).toBe(true);

      const report = await reconcileQueueOnBoot(fixture.store);
      expect(report.requeuedUndelivered).toEqual([]);
      expect(report.resendsScheduled).toEqual([]);
      expect(fixture.store.orchestration.queue.listActive(fixture.conversation.id)).toEqual([]);
    } finally {
      fixture.store.close();
    }
  });

  it("skips automatic resend when a Stop was recorded on the run via run-control.interrupt-recorded or H1-stop", async () => {
    const fixture = createFixture();
    try {
      // Case A: run-control.interrupt-recorded on the interrupted MCP run.
      const stoppedRunItemId = randomUUID();
      fixture.store.orchestration.queue.enqueue({
        conversationId: fixture.conversation.id,
        itemId: stoppedRunItemId,
        content: "Stopped before provider started",
        kind: "message",
        createdBy: "agent",
        creationSource: "mcp",
      });
      fixture.store.orchestration.queue.claim({
        conversationId: fixture.conversation.id,
        itemId: stoppedRunItemId,
        mode: "run",
      });
      const started = beginTurn(fixture.store, fixture.conversation, {
        content: "Stopped before provider started",
        queuedMessageId: stoppedRunItemId,
      });
      const target = fixture.store.orchestration.runControl.target(started.turn.runId)!;
      const stopLead = await fixture.store.orchestration.authority.begin({
        source: {
          actorId: "human",
          commandId: `stop-${started.turn.runId}`,
          command: { type: "agent.stop", conversationId: fixture.conversation.id },
        },
        threadId: fixture.conversation.id,
        projectId: fixture.projectId,
        commandType: "agent.stop",
        rejection: null,
      }, (ticket) => {
        fixture.store.orchestration.runControl.recordInterrupt(ticket, target, started.turn.id, "user");
      });
      if (stopLead.kind === "lead") stopLead.ticket.finish(null);
      interruptNeverStartedTurn(fixture.store, started.turn.id);

      // Case B: H1-stop recorded on another conversation with a waiting MCP prompt.
      const h1Conv = fixture.store.createConversation(fixture.projectId, "H1-stopped chat", {
        accessMode: "full",
      });
      const h1ItemId = randomUUID();
      fixture.store.orchestration.queue.enqueue({
        conversationId: h1Conv.id,
        itemId: h1ItemId,
        content: "Held by H1-stop",
        kind: "message",
        createdBy: "agent",
        creationSource: "mcp",
      });
      fixture.store.orchestration.queue.hold({
        conversationId: h1Conv.id,
        cause: "H1-stop",
        itemIds: [h1ItemId],
      });

      const report = await reconcileQueueOnBoot(fixture.store);
      expect(report.resendsScheduled).toEqual([]);
      expect(report.resendsExhausted).toEqual([]);
      expect(fixture.store.orchestration.queue.getItem(stoppedRunItemId)).toMatchObject({
        state: "waiting",
        queueHeld: true,
        creationSource: "mcp",
      });
      expect(fixture.store.orchestration.queue.getItem(h1ItemId)).toMatchObject({
        state: "waiting",
        queueHeld: true,
        creationSource: "mcp",
      });
    } finally {
      fixture.store.close();
    }
  });

  it("skips automatic resend when a Stop was recorded on the delegating parent's run (agent_managed_conversations.source_run_id)", async () => {
    const fixture = createFixture();
    try {
      const parent = fixture.store.createConversation(fixture.projectId, "Delegating parent", {
        accessMode: "full",
      });
      const parentTurn = beginTurn(fixture.store, parent, {
        content: "Delegate work to child",
      }).turn;

      const child = fixture.store.createConversation(fixture.projectId, "Delegated child", {
        accessMode: "full",
      });
      fixture.store.orchestration.effects.connection.prepare(`
        INSERT INTO agent_managed_conversations (
          child_conversation_id, source_conversation_id, source_turn_id, source_run_id,
          root_conversation_id, source_harness_id, depth, created_at
        ) VALUES (?, ?, ?, ?, ?, 'codex-app-server', 1, ?)
      `).run(child.id, parent.id, parentTurn.id, parentTurn.runId, parent.id, new Date().toISOString());

      // Record Stop on the delegating parent's run.
      const parentTarget = fixture.store.orchestration.runControl.target(parentTurn.runId)!;
      const parentStop = await fixture.store.orchestration.authority.begin({
        source: {
          actorId: "human",
          commandId: `parent-stop-${parentTurn.runId}`,
          command: { type: "agent.stop", conversationId: parent.id },
        },
        threadId: parent.id,
        projectId: fixture.projectId,
        commandType: "agent.stop",
        rejection: null,
      }, (ticket) => {
        fixture.store.orchestration.runControl.recordInterrupt(ticket, parentTarget, parentTurn.id, "user");
      });
      if (parentStop.kind === "lead") parentStop.ticket.finish(null);

      // Child has a never-started MCP item that was dispatching when the process crashed.
      const childItemId = randomUUID();
      fixture.store.orchestration.queue.enqueue({
        conversationId: child.id,
        itemId: childItemId,
        content: "Child task from stopped parent",
        kind: "message",
        createdBy: "agent",
        creationSource: "mcp",
      });
      fixture.store.orchestration.queue.claim({
        conversationId: child.id,
        itemId: childItemId,
        mode: "run",
      });

      const report = await reconcileQueueOnBoot(fixture.store);
      expect(report.releasedDispatching).toContain(childItemId);
      expect(report.resendsScheduled).not.toContain(childItemId);
      expect(report.heldConversations).toContain(child.id);
      expect(fixture.store.orchestration.queue.getItem(childItemId)).toMatchObject({
        state: "waiting",
        queueHeld: true,
        creationSource: "mcp",
      });
    } finally {
      fixture.store.close();
    }
  });

  it("enforces the cumulative MAX_UNATTENDED_RESENDS = 3 cap durably across process restarts", async () => {
    expect(MAX_UNATTENDED_RESENDS).toBe(3);
    const fixture = createFixture();
    const itemId = randomUUID();
    let currentStore: RuntimeStore | null = fixture.store;
    try {
      // Crash 1: MCP prompt claimed (`dispatching`) when process dies.
      currentStore.orchestration.queue.enqueue({
        conversationId: fixture.conversation.id,
        itemId,
        content: "Crash-resilient unattended MCP prompt",
        kind: "message",
        createdBy: "agent",
        creationSource: "mcp",
      });
      currentStore.orchestration.queue.claim({
        conversationId: fixture.conversation.id,
        itemId,
        mode: "run",
      });
      currentStore.close();

      // Boot 1 (fresh RuntimeStore from SQLite): processLossCount = 1 < 3 -> released for resend.
      currentStore = fixture.reopen();
      const boot1 = await reconcileQueueOnBoot(currentStore);
      expect(boot1.releasedDispatching).toEqual([itemId]);
      expect(boot1.resendsScheduled).toEqual([itemId]);
      expect(boot1.resendsExhausted).toEqual([]);
      expect(currentStore.orchestration.queue.getItem(itemId)).toMatchObject({
        state: "waiting",
        queueHeld: false,
        creationSource: "mcp",
      });
      expect(countDurableProcessLosses(
        currentStore.orchestration.effects.connection,
        fixture.conversation.id,
        itemId,
        null,
      )).toBe(1);

      // Crash 2: dispatched into a turn that crashes before provider observation.
      currentStore.orchestration.queue.claim({
        conversationId: fixture.conversation.id,
        itemId,
        mode: "run",
      });
      const turn2 = beginTurn(currentStore, fixture.conversation, {
        content: "Crash-resilient unattended MCP prompt",
        queuedMessageId: itemId,
      });
      interruptNeverStartedTurn(currentStore, turn2.turn.id);
      currentStore.close();

      // Boot 2 (fresh RuntimeStore from SQLite): cumulative processLossCount = 2 < 3 -> released for resend.
      currentStore = fixture.reopen();
      const boot2 = await reconcileQueueOnBoot(currentStore);
      expect(boot2.requeuedUndelivered).toEqual([itemId]);
      expect(boot2.resendsScheduled).toEqual([itemId]);
      expect(boot2.resendsExhausted).toEqual([]);
      expect(currentStore.orchestration.queue.getItem(itemId)).toMatchObject({
        state: "waiting",
        queueHeld: false,
        creationSource: "mcp",
      });
      expect(countDurableProcessLosses(
        currentStore.orchestration.effects.connection,
        fixture.conversation.id,
        itemId,
        turn2.message.id,
      )).toBe(2);

      // Crash 3: claimed again (`dispatching`) when process dies a 3rd time.
      currentStore.orchestration.queue.claim({
        conversationId: fixture.conversation.id,
        itemId,
        mode: "run",
      });
      currentStore.close();

      // Boot 3 (fresh RuntimeStore from SQLite): cumulative processLossCount = 3 >= 3 -> HELD & exhausted.
      currentStore = fixture.reopen();
      const boot3 = await reconcileQueueOnBoot(currentStore);
      expect(boot3.releasedDispatching).toEqual([itemId]);
      expect(boot3.resendsScheduled).toEqual([]);
      expect(boot3.resendsExhausted).toEqual([itemId]);
      expect(boot3.heldConversations).toContain(fixture.conversation.id);
      expect(currentStore.orchestration.queue.getItem(itemId)).toMatchObject({
        state: "waiting",
        queueHeld: true,
        creationSource: "mcp",
      });
      expect(countDurableProcessLosses(
        currentStore.orchestration.effects.connection,
        fixture.conversation.id,
        itemId,
        turn2.message.id,
      )).toBe(3);
      expect(currentStore.orchestration.events.verify({ readable: true }).valid).toBe(true);
    } finally {
      currentStore?.close();
    }
  });

  it("never auto-resends delegated deliveries, watcher notes, or interactive web prompts on boot", async () => {
    const fixture = createFixture();
    try {
      const delegatedItemId = randomUUID();
      const watcherItemId = randomUUID();
      const webItemId = randomUUID();

      fixture.store.orchestration.queue.enqueue({
        conversationId: fixture.conversation.id,
        itemId: delegatedItemId,
        content: "Child task results ready",
        kind: "delegated-results",
        createdBy: "system",
        creationSource: "server",
        attribution: { delegatedCompletion: delegatedCompletion(fixture.conversation.id) },
        origin: "automatic",
      });
      fixture.store.orchestration.queue.enqueue({
        conversationId: fixture.conversation.id,
        itemId: watcherItemId,
        content: "Reviewer spotted an issue",
        kind: "watcher-note",
        createdBy: "system",
        creationSource: "server",
        attribution: { watcherNote: watcherNote() },
        origin: "automatic",
      });
      fixture.store.orchestration.queue.enqueue({
        conversationId: fixture.conversation.id,
        itemId: webItemId,
        content: "Manual user prompt",
        kind: "message",
        createdBy: "user",
        creationSource: "web",
      });

      const report = await reconcileQueueOnBoot(fixture.store);
      expect(report.resendsScheduled).toEqual([]);
      expect(report.resendsExhausted).toEqual([]);
      expect(report.heldConversations).toContain(fixture.conversation.id);
      for (const id of [delegatedItemId, watcherItemId, webItemId]) {
        expect(fixture.store.orchestration.queue.getItem(id)).toMatchObject({
          state: "waiting",
          queueHeld: true,
        });
      }
    } finally {
      fixture.store.close();
    }
  });
});
