import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { queuedIntentDigest } from "../../src/server/persistence/queued-message-repository";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
} from "../support/turn-controller-runtime";

const roots: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await cleanupTurnControllerTestDirectories();
});

function raw(store: RuntimeStore): Database.Database {
  return (store as unknown as { database: Database.Database }).database;
}

function queue(store: RuntimeStore, conversationId: string, content: string) {
  return store.queuedMessages.add({
    id: randomUUID(),
    conversation: store.conversation(conversationId),
    content,
    attachments: [],
    digest: queuedIntentDigest(content, []),
  });
}

function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-initiative-access-"));
  roots.push(root);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Access", root);
  return { store, project };
}

describe("an initiative's access limit and queued messages", () => {
  it("lowers the access queued messages carry when the limit is lowered, so they still match their chat", () => {
    const { store, project } = storeFixture();
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Checkout" });
    const member = store.createConversation(project.id, "Member", { accessMode: "full", initiativeId: initiative.id });
    const outsider = store.createConversation(project.id, "Outsider", { accessMode: "full" });
    const queued = queue(store, member.id, "Next step");
    const untouched = queue(store, outsider.id, "Elsewhere");

    store.initiatives.update(initiative.id, 1, { preferences: { accessCeiling: "auto-edit" } });

    expect(store.conversation(member.id).accessMode).toBe("auto-edit");
    expect(store.queuedMessages.routeMatches(queued, store.conversation(member.id))).toBe(true);
    expect(store.queuedMessages.get(member.id, queued.id)).toMatchObject({ state: "waiting", error: null });
    // A chat outside the initiative keeps its access and its queue.
    expect(store.conversation(outsider.id).accessMode).toBe("full");
    expect(store.queuedMessages.routeMatches(untouched, store.conversation(outsider.id))).toBe(true);
  });

  it("lowers a moved chat's queued messages with the chat", () => {
    const { store, project } = storeFixture();
    const limited = store.initiatives.create({ id: randomUUID(), name: "Limited" });
    store.initiatives.update(limited.id, 1, { preferences: { accessCeiling: "supervised" } });
    const chat = store.createConversation(project.id, "Chat", { accessMode: "full" });
    const queued = queue(store, chat.id, "Carry on");

    store.initiatives.assignConversation(chat.id, limited.id);

    expect(store.conversation(chat.id).accessMode).toBe("supervised");
    expect(store.queuedMessages.routeMatches(queued, store.conversation(chat.id))).toBe(true);
  });
});

describe("an initiative's access limit for new chats", () => {
  it("lowers Duo sides and the judge chat created in a limited initiative", () => {
    const { store, project } = storeFixture();
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Checkout" });
    store.initiatives.update(initiative.id, 1, { preferences: { accessCeiling: "auto-edit" } });
    const launchId = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID()] as const;
    store.createPairedLaunch(launchId, [0, 1].map((ordinal) => ({
      ordinal: ordinal as 0 | 1,
      projectId: project.id,
      plannedConversationId: ids[ordinal],
      plannedWorktreePath: null,
      plannedBranch: null,
      ownsWorktree: false,
    })) as never, new Date().toISOString(), { plannedConversationId: ids[2] });
    const plan = (id: string, title: string) => ({
      projectId: project.id,
      title,
      options: {
        id,
        modelSelection: providerNativeModelSelection({ providerId: "codex" }),
        accessMode: "full" as const,
        initiativeId: initiative.id,
        activate: false,
      },
    });
    const created = store.createDuoConversations(
      launchId,
      [plan(ids[0], "Duo left"), plan(ids[1], "Duo right")],
      plan(ids[2], "Duo judge"),
    );
    expect([...created.sides, created.comparison!].map(({ accessMode, initiativeId }) => [accessMode, initiativeId]))
      .toEqual([["auto-edit", initiative.id], ["auto-edit", initiative.id], ["auto-edit", initiative.id]]);
    expect(ids.map((id) => store.conversation(id).accessMode)).toEqual(["auto-edit", "auto-edit", "auto-edit"]);
  });
});

describe("an initiative's access limit at turn start", () => {
  it("keeps a running turn's access until it ends and starts the next turn at the lowered limit", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const { store, controller, provider, conversationId } = runtime;
    store.updateConversation(conversationId, { accessMode: "full" });
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Checkout" }, conversationId);

    const running = controller.queue({ conversationId, content: "Refactor the parser." });
    controller.start(running.turn.id);
    const runningInput = provider.input;
    expect(runningInput?.access).toBe("full");

    store.initiatives.update(initiative.id, 1, { preferences: { accessCeiling: "auto-edit" } });
    expect(store.conversation(conversationId).accessMode).toBe("auto-edit");
    // The provider received its access when the turn started; nothing re-runs
    // or rewrites it, and the turn's record still says what it ran with.
    expect(provider.runCount).toBe(1);
    expect(provider.input).toBe(runningInput);
    expect(provider.input?.access).toBe("full");
    expect(store.agentTurn(running.turn.id).accessMode).toBe("full");

    provider.resolve({ status: "completed" });
    await flushTurnControllerTestPromises();
    await controller.drainSettlementTasks();

    const next = controller.queue({ conversationId, content: "Now the tests." });
    controller.start(next.turn.id);
    expect(provider.runCount).toBe(2);
    expect(provider.input?.access).toBe("auto-edit");
    expect(store.agentTurn(next.turn.id).accessMode).toBe("auto-edit");
    provider.resolve({ status: "completed" });
    await flushTurnControllerTestPromises();
    await controller.drainSettlementTasks();
    await controller.dispose();
    store.close();
  });

  it("clamps a chat restored above its limit, lowers it and its queue with the turn, and publishes it", async () => {
    const broadcastConversationShell = vi.fn();
    const runtime = await createTurnControllerTestRuntime({ broadcastConversationShell });
    const { store, controller, provider, conversationId } = runtime;
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Checkout" }, conversationId);
    store.initiatives.update(initiative.id, 1, { preferences: { accessCeiling: "auto-edit" } });
    // Restored or racing data: the stored access is above the limit.
    raw(store).prepare("UPDATE conversations SET access_mode = 'full' WHERE id = ?").run(conversationId);
    const queued = queue(store, conversationId, "Then the docs.");

    const turn = controller.queue({ conversationId, content: "Refactor the parser." });
    expect(store.conversation(conversationId).accessMode).toBe("auto-edit");
    expect(store.agentTurn(turn.turn.id).accessMode).toBe("auto-edit");
    expect(broadcastConversationShell).toHaveBeenCalledWith(conversationId);
    expect(store.queuedMessages.routeMatches(queued, store.conversation(conversationId))).toBe(true);
    controller.start(turn.turn.id);
    expect(provider.input?.access).toBe("auto-edit");

    provider.resolve({ status: "completed" });
    await flushTurnControllerTestPromises();
    await controller.drainSettlementTasks();
    // Nothing more to lower: the next turn publishes nothing extra for access.
    broadcastConversationShell.mockClear();
    const next = controller.queue({ conversationId, content: "And the tests." });
    expect(store.agentTurn(next.turn.id).accessMode).toBe("auto-edit");
    expect(broadcastConversationShell).not.toHaveBeenCalled();
    controller.start(next.turn.id);
    provider.resolve({ status: "completed" });
    await flushTurnControllerTestPromises();
    await controller.drainSettlementTasks();
    await controller.dispose();
    store.close();
  });

  it("refuses an Antigravity turn under a Supervised limit, which it would run as Auto-accept edits", async () => {
    const runtime = await createTurnControllerTestRuntime({}, {
      modelSelection: providerNativeModelSelection({ providerId: "antigravity", modelId: "provider-default" }),
    });
    const { store, controller, conversationId } = runtime;
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Checkout" }, conversationId);
    store.initiatives.update(initiative.id, 1, { preferences: { accessCeiling: "supervised" } });
    expect(store.conversation(conversationId).accessMode).toBe("supervised");

    const refusal = (() => {
      try {
        controller.queue({ conversationId, content: "Ship it." });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(refusal).toBeInstanceOf(RuntimeRequestError);
    expect((refusal as Error).message)
      .toBe("“Checkout” limits chats to Supervised. Antigravity cannot run supervised.");
    expect(store.latestAgentTurnForConversation(conversationId)).toBeNull();

    // Antigravity stays within an Auto-accept edits limit.
    store.initiatives.update(initiative.id, 2, { preferences: { accessCeiling: "auto-edit" } });
    const allowed = controller.queue({ conversationId, content: "Ship it." });
    expect(store.agentTurn(allowed.turn.id).accessMode).toBe("supervised");
    await controller.dispose();
    store.close();
  });
});
