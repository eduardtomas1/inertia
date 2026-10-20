import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const BRIEF = "Ship the shorter checkout.";

function initiativeBlockLabels(prompt: string | undefined): string[] {
  const line = prompt?.split("\n").find((entry) => entry.startsWith("{\"version\":1"));
  if (!line) return [];
  return (JSON.parse(line) as { attachments: Array<{ kind: string; label: string }> }).attachments
    .filter(({ kind }) => kind === "initiative")
    .map(({ label }) => label);
}

function receipts(store: RuntimeStore, conversationId: string, turnId: string): string[] {
  return (store.conversationHistory(conversationId)?.messages ?? [])
    .filter((message) => message.turnId === turnId && message.initiativeContext)
    .map(({ content }) => content);
}

function deliveryCount(store: RuntimeStore, turnId: string): number {
  const raw = (store as unknown as { database: Database.Database }).database;
  return (raw.prepare("SELECT COUNT(*) AS count FROM initiative_context_deliveries WHERE turn_id = ?")
    .get(turnId) as { count: number }).count;
}

/** A chat in an initiative whose first turn shared the brief on provider session "saved-session". */
async function establishedMember() {
  const runtime = await createTurnControllerTestRuntime();
  const { store, controller, conversationId } = runtime;
  const initiative = store.initiatives.create({ id: randomUUID(), name: "Checkout redesign" });
  store.initiatives.assignConversation(conversationId, initiative.id);
  store.initiatives.updateBrief(initiative.id, 0, BRIEF);
  const first = controller.queue({ conversationId, content: "Start the checkout work." });
  controller.start(first.turn.id);
  expect(initiativeBlockLabels(runtime.provider.input?.prompt))
    .toEqual(["Initiative brief · Checkout redesign · revision 1"]);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "saved-session" });
  runtime.provider.resolve({ status: "completed", sessionId: "saved-session", text: "Started." });
  await flushTurnControllerTestPromises();
  const changeBrief = (brief: string) => {
    const current = store.initiatives.get(initiative.id)!;
    store.initiatives.updateBrief(initiative.id, current.briefRevision, brief);
  };
  return { runtime, initiative, changeBrief };
}

async function close(runtime: TurnControllerTestRuntime): Promise<void> {
  await runtime.controller.dispose();
  runtime.store.close();
}

describe("initiative context of turns that never reached the provider", () => {
  it("withdraws the receipt and delivery of a turn that failed to start, and sends again next time", async () => {
    const { runtime, changeBrief } = await establishedMember();
    try {
      const { store, controller, conversationId, provider } = runtime;
      changeBrief("Revised brief.");
      const lost = controller.queue({ conversationId, content: "Continue." });
      expect(receipts(store, conversationId, lost.turn.id))
        .toEqual(["Shared the updated initiative brief (revision 2) with the agent."]);
      expect(deliveryCount(store, lost.turn.id)).toBe(1);
      const run = provider.run.bind(provider);
      provider.run = () => {
        throw new Error("The provider executable could not be launched.");
      };
      runtime.events.length = 0;
      controller.start(lost.turn.id);
      await flushTurnControllerTestPromises();
      provider.run = run;

      expect(store.agentTurn(lost.turn.id)).toMatchObject({ status: "failed", terminalReason: "turn-start-failed" });
      expect(receipts(store, conversationId, lost.turn.id)).toEqual([]);
      expect(deliveryCount(store, lost.turn.id)).toBe(0);
      expect(runtime.events).toContainEqual({ type: "conversation.detail.invalidated", conversationId });

      const retry = controller.queue({ conversationId, content: "Continue again." });
      controller.start(retry.turn.id);
      expect(provider.input?.sessionId).toBe("saved-session");
      expect(provider.input?.prompt).toContain("Updated since the last turn of this chat (previous revision 1).");
    } finally {
      await close(runtime);
    }
  });

  it("withdraws the receipt and delivery of a turn cancelled before it started", async () => {
    const { runtime, changeBrief } = await establishedMember();
    try {
      const { store, controller, conversationId, provider } = runtime;
      changeBrief("Revised brief.");
      const cancelled = controller.queue({ conversationId, content: "Continue." });
      expect(deliveryCount(store, cancelled.turn.id)).toBe(1);
      runtime.events.length = 0;
      expect(controller.cancel(conversationId)).toBe(true);
      await flushTurnControllerTestPromises();

      expect(store.agentTurn(cancelled.turn.id).status).toBe("cancelled");
      expect(receipts(store, conversationId, cancelled.turn.id)).toEqual([]);
      expect(deliveryCount(store, cancelled.turn.id)).toBe(0);
      expect(runtime.events).toContainEqual({ type: "conversation.detail.invalidated", conversationId });

      const next = controller.queue({ conversationId, content: "Continue again." });
      controller.start(next.turn.id);
      expect(initiativeBlockLabels(provider.input?.prompt)).toEqual(["Initiative brief · Checkout redesign · revision 2"]);
    } finally {
      await close(runtime);
    }
  });

  it("keeps the receipt and delivery of a turn cancelled after it started, so the resumed session is not sent it again", async () => {
    const { runtime, changeBrief } = await establishedMember();
    try {
      const { store, controller, conversationId, provider } = runtime;
      changeBrief("Revised brief.");
      const stopped = controller.queue({ conversationId, content: "Continue." });
      controller.start(stopped.turn.id);
      expect(provider.input?.prompt).toContain("Revised brief.");
      expect(controller.cancel(conversationId)).toBe(true);
      await flushTurnControllerTestPromises();

      expect(store.agentTurn(stopped.turn.id).status).toBe("cancelled");
      expect(receipts(store, conversationId, stopped.turn.id))
        .toEqual(["Shared the updated initiative brief (revision 2) with the agent."]);
      expect(deliveryCount(store, stopped.turn.id)).toBe(1);

      const next = controller.queue({ conversationId, content: "Continue again." });
      controller.start(next.turn.id);
      expect(provider.input?.sessionId).toBe("saved-session");
      expect(initiativeBlockLabels(provider.input?.prompt)).toEqual([]);
      expect(receipts(store, conversationId, next.turn.id)).toEqual([]);
    } finally {
      await close(runtime);
    }
  });
});

describe("fresh-session fallback through the controller", () => {
  it("shares the initiative the chat moved to when the resumed session is lost", async () => {
    const { runtime, changeBrief } = await establishedMember();
    try {
      const { store, controller, conversationId, provider } = runtime;
      changeBrief("Revised brief.");
      const queued = controller.queue({ conversationId, content: "Continue." });
      controller.start(queued.turn.id);
      expect(provider.input?.sessionId).toBe("saved-session");
      const payments = store.initiatives.create({ id: randomUUID(), name: "Payments" });
      store.initiatives.updateBrief(payments.id, 0, "Stripe only.");
      store.initiatives.assignConversation(conversationId, payments.id);
      runtime.events.length = 0;

      const replacement = provider.callbacks!.freshSessionFallback!();
      expect(initiativeBlockLabels(replacement?.prompt)).toEqual(["Initiative brief · Payments · revision 1"]);
      expect(receipts(store, conversationId, queued.turn.id))
        .toEqual(["Shared the initiative brief (revision 1) with the agent."]);
      expect(store.initiatives.deliveries.latestDelivered(conversationId)).toMatchObject({
        turnId: queued.turn.id, initiativeId: payments.id, briefRevision: 1,
      });
      expect(runtime.events).toContainEqual({ type: "conversation.detail.invalidated", conversationId });
    } finally {
      await close(runtime);
    }
  });

  it("withdraws the receipt when the initiative is deleted before the fallback", async () => {
    const { runtime, initiative, changeBrief } = await establishedMember();
    try {
      const { store, controller, conversationId, provider } = runtime;
      changeBrief("Revised brief.");
      const queued = controller.queue({ conversationId, content: "Continue." });
      controller.start(queued.turn.id);
      expect(receipts(store, conversationId, queued.turn.id)).toHaveLength(1);
      store.initiatives.delete(initiative.id);
      runtime.events.length = 0;

      const replacement = provider.callbacks!.freshSessionFallback!();
      expect(replacement?.prompt).toBeTypeOf("string");
      expect(initiativeBlockLabels(replacement?.prompt)).toEqual([]);
      expect(replacement?.prompt).not.toContain("[initiative-context]");
      expect(receipts(store, conversationId, queued.turn.id)).toEqual([]);
      expect(deliveryCount(store, queued.turn.id)).toBe(0);
      expect(runtime.events).toContainEqual({ type: "conversation.detail.invalidated", conversationId });
    } finally {
      await close(runtime);
    }
  });
});

describe("paired turns", () => {
  it("broadcasts each side's initiative receipt live", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { store, controller } = runtime;
      const projectId = store.conversation(runtime.conversationId).projectId;
      const launchId = randomUUID();
      const conversationIds = [randomUUID(), randomUUID()] as const;
      store.createPairedLaunch(launchId, [0, 1].map((ordinal) => ({
        ordinal,
        projectId,
        plannedConversationId: conversationIds[ordinal]!,
        plannedWorktreePath: null,
        plannedBranch: null,
        ownsWorktree: false,
      })) as Parameters<RuntimeStore["createPairedLaunch"]>[1]);
      const selection = providerNativeModelSelection({
        providerId: "codex", modelId: "gpt-test", alias: "GPT Test", reasoningEffort: "high",
      });
      const plan = (ordinal: 0 | 1) => ({
        projectId,
        title: `Pair ${ordinal}`,
        options: {
          id: conversationIds[ordinal],
          providerId: "codex" as const,
          modelSelection: selection,
          interactionMode: "build" as const,
          accessMode: "supervised" as const,
          activate: false,
        },
      });
      const conversations = store.createPairedConversations(launchId, [plan(0), plan(1)]);
      const initiative = store.initiatives.create({ id: randomUUID(), name: "Checkout redesign" });
      store.initiatives.updateBrief(initiative.id, 0, BRIEF);
      for (const conversation of conversations) store.initiatives.assignConversation(conversation.id, initiative.id);
      runtime.events.length = 0;

      const queued = controller.queuePair(launchId, [
        { conversationId: conversations[0].id, content: "First paired side." },
        { conversationId: conversations[1].id, content: "Second paired side." },
      ]);
      const persisted = runtime.events.flatMap((event) =>
        event.type === "conversation.message.persisted" && event.message.initiativeContext ? [event.message] : []);
      expect(persisted.map(({ turnId, content }) => [turnId, content])).toEqual(queued.map(({ turn }) => [
        turn.id,
        "Shared the initiative brief (revision 1) with the agent.",
      ]));
    } finally {
      await close(runtime);
    }
  });
});
