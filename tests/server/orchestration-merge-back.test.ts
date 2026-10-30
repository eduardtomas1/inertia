import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { createConversationCommandHandler, type ConversationCommandDependencies } from "../../src/server/runtime/commands/conversation-commands";
import { ConversationContextService } from "../../src/server/runtime/conversation-context-service";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import type { ServerEvent } from "../../src/shared/contracts";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  type TurnControllerTestRuntime } from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

let requestSequence = 0;
const requestId = () => `00000000-0000-4000-8000-${String(++requestSequence).padStart(12, "0")}`;

async function finish(runtime: TurnControllerTestRuntime, label: string, conversationId = runtime.conversationId,
  status: "completed" | "failed" = "completed", packetIds: readonly string[] = []) {
  const queued = runtime.controller.queue({ conversationId, content: `${label} request`,
    ...(packetIds.length ? { context: { conversationContextPacketIds: [...packetIds] }, contextRequestId: requestId() } : {}) });
  runtime.controller.start(queued.turn.id);
  const prompt = runtime.provider.input?.prompt ?? "";
  runtime.provider.resolve(status === "completed" ? { text: `${label} answer` } : { status: "failed" });
  await flushTurnControllerTestPromises();
  return { turn: queued.turn, prompt };
}

function fork(runtime: TurnControllerTestRuntime, turnId: string) {
  const parent = runtime.store.conversation(runtime.conversationId);
  const input = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: turnId, activate: false };
  return runtime.store.orchestration.forks.create(input, { actorId: "human", commandId: `fork-${turnId}`, command: { ...input } });
}

function mergeBack(runtime: TurnControllerTestRuntime, forkId: string, commandId = requestId()) {
  const command = { type: "conversation.merge-back", requestId: commandId, payload: { forkConversationId: forkId } };
  return runtime.store.orchestration.mergeBacks.prepare(forkId, { actorId: "human", commandId, command });
}

function portableRollback(runtime: TurnControllerTestRuntime, conversationId: string, turnId: string | null) {
  const commandId = requestId();
  const command = { type: "conversation.rollback", requestId: commandId, payload: { conversationId, turnId } };
  return rollbackConversationHistory({ store: runtime.store, turns: runtime.controller,
    providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
    providers: { resolveModelRoute: runtime.provider.resolveModelRoute, isRunning: (id: string) => runtime.provider.isRunning(id),
      nativeConversation: vi.fn(async (request: NativeConversationRequest) => ({ operationId: request.operationId,
        identity: request.source.identity, status: "unsupported" as const, reason: "fixture" })) } },
  { conversationId, turnId, source: { actorId: "human", commandId, command } }, new AbortController().signal);
}

async function forkWithWork(runtime: TurnControllerTestRuntime) {
  const first = await finish(runtime, "parent-first");
  const child = fork(runtime, first.turn.id);
  const one = await finish(runtime, "fork-one", child.id);
  const two = await finish(runtime, "fork-two", child.id);
  return { first, child, one, two };
}

describe("fork context merge-back", () => {
  it.each(["delivered", "withdrawn", "superseded"] as const)("replays the receipt of a reused draft after it is %s", async (state) => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { child } = await forkWithWork(runtime);
      const original = mergeBack(runtime, child.id);
      const reuseId = requestId();
      expect(mergeBack(runtime, child.id, reuseId)).toEqual(original);
      if (state === "delivered") await finish(runtime, "delivered", runtime.conversationId, "completed", [original.packetId]);
      if (state === "withdrawn") runtime.store.contextPackets.deleteDraft(original.packetId, runtime.conversationId);
      await finish(runtime, "later-fork-work", child.id);
      const next = mergeBack(runtime, child.id);
      expect(next.mergeBackId).not.toBe(original.mergeBackId);
      const revision = runtime.store.orchestration.events.revision(runtime.conversationId);
      expect(mergeBack(runtime, child.id, reuseId)).toEqual(original);
      expect(runtime.store.orchestration.events.revision(runtime.conversationId)).toBe(revision);
      runtime.store.orchestration.events.rebuildProjections();
      expect(mergeBack(runtime, child.id, reuseId)).toEqual(original);
    } finally { runtime.store.close(); }
  });

  it("retains the last delivered base beyond 256 later withdrawn preparations", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { child, two } = await forkWithWork(runtime);
      const delivered = mergeBack(runtime, child.id);
      await finish(runtime, "parent-delivery", runtime.conversationId, "completed", [delivered.packetId]);
      const three = await finish(runtime, "new-fork-findings", child.id);
      for (let index = 0; index < 260; index += 1) {
        const draft = mergeBack(runtime, child.id);
        runtime.store.contextPackets.deleteDraft(draft.packetId, runtime.conversationId);
      }
      const next = mergeBack(runtime, child.id);
      expect(next).toMatchObject({ turnCount: 1, messageCount: 2 });
      expect(runtime.store.orchestration.mergeBacks.get(next.mergeBackId)).toMatchObject({
        baseTurnId: two.turn.id, throughTurnId: three.turn.id,
      });
      const excerpt = runtime.store.contextPackets.get(next.packetId, runtime.conversationId).excerpts.map(({ content }) => content).join("\n");
      expect(excerpt).toContain("new-fork-findings answer");
      expect(excerpt).not.toContain("fork-two answer");
    } finally { runtime.store.close(); }
  });

  it("prepares an attributed draft on the exact source chat, delivers it once and advances the base point", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { child, two } = await forkWithWork(runtime);
      const commandId = requestId();
      const result = mergeBack(runtime, child.id, commandId);
      expect(result).toMatchObject({ forkConversationId: child.id, parentConversationId: runtime.conversationId,
        turnCount: 2, messageCount: 4, omittedMessageCount: 0 });
      const packet = runtime.store.contextPackets.get(result.packetId, runtime.conversationId);
      expect(packet).toMatchObject({ sourceConversationId: child.id, consumedMessageId: null, note: `Merge-back from fork "${child.title}".` });
      expect(packet.excerpts.map(({ content }) => content).join("\n")).not.toContain("parent-first answer");
      expect(mergeBack(runtime, child.id, commandId)).toEqual(result);
      expect(mergeBack(runtime, child.id)).toEqual(result);
      expect(runtime.store.orchestration.mergeBacks.get(result.mergeBackId)).toMatchObject({ state: "prepared",
        baseTurnId: null, throughTurnId: two.turn.id, forkSourceTurnId: runtime.store.orchestration.forks.get(child.id)!.sourceTurnId });
      const delivered = await finish(runtime, "parent-merge", runtime.conversationId, "completed", [result.packetId]);
      expect(delivered.prompt).toContain("fork-two answer");
      expect(runtime.store.orchestration.mergeBacks.get(result.mergeBackId)).toMatchObject({ state: "delivered",
        runId: delivered.turn.runId, messageId: delivered.turn.userMessageId });
      expect(() => mergeBack(runtime, child.id)).toThrow("no finished work since its last merge-back");
      const three = await finish(runtime, "fork-three", child.id);
      const next = mergeBack(runtime, child.id);
      expect(next).toMatchObject({ turnCount: 1, messageCount: 2 });
      expect(runtime.store.orchestration.mergeBacks.get(next.mergeBackId)).toMatchObject({ baseTurnId: two.turn.id, throughTurnId: three.turn.id });
      const excerpts = runtime.store.contextPackets.get(next.packetId, runtime.conversationId).excerpts.map(({ content }) => content).join("\n");
      expect(excerpts).toContain("fork-three answer");
      expect(excerpts).not.toContain("fork-one answer");
      const before = runtime.store.orchestration.mergeBacks.get(result.mergeBackId);
      runtime.store.orchestration.events.rebuildProjections();
      expect(runtime.store.orchestration.mergeBacks.get(result.mergeBackId)).toEqual(before);
    } finally { runtime.store.close(); }
  });

  it("refuses non-forks and stale fork work, and supersedes its own draft after the fork rolls back", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { first, child, one } = await forkWithWork(runtime);
      expect(() => mergeBack(runtime, runtime.conversationId)).toThrow("Only a fork");
      const stale = mergeBack(runtime, child.id);
      await expect(portableRollback(runtime, child.id, one.turn.id)).resolves.toMatchObject({ transfer: "portable", rolledBackTurns: 1 });
      expect(() => new ConversationContextService(runtime.store).assertSendable(runtime.conversationId, [stale.packetId]))
        .toThrow("rolled back");
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId, content: "Use stale findings",
        context: { conversationContextPacketIds: [stale.packetId] }, contextRequestId: requestId() })).toThrow("rolled back");
      const fresh = mergeBack(runtime, child.id);
      expect(fresh.mergeBackId).not.toBe(stale.mergeBackId);
      expect(fresh).toMatchObject({ turnCount: 1, messageCount: 2 });
      expect(runtime.store.orchestration.mergeBacks.get(stale.mergeBackId)?.state).toBe("superseded");
      expect(() => runtime.store.contextPackets.get(stale.packetId, runtime.conversationId)).toThrow("unavailable");
      runtime.store.contextPackets.deleteDraft(fresh.packetId, runtime.conversationId);
      const again = mergeBack(runtime, child.id);
      expect(runtime.store.orchestration.mergeBacks.get(fresh.mergeBackId)?.state).toBe("withdrawn");
      expect(again.mergeBackId).not.toBe(fresh.mergeBackId);
      await finish(runtime, "parent-second");
      await expect(portableRollback(runtime, runtime.conversationId, null)).resolves.toMatchObject({ transfer: "portable" });
      expect(runtime.store.orchestration.history.rolledBack(first.turn.id)).toBe(true);
      expect(() => mergeBack(runtime, child.id)).toThrow("starting point was rolled back");
    } finally { runtime.store.close(); }
  });

  it("keeps uncertain delivery retryable and reopens the base when the parent rolls back the delivering turn", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { first, child } = await forkWithWork(runtime);
      const attempt = mergeBack(runtime, child.id);
      await finish(runtime, "parent-ambiguous", runtime.conversationId, "failed", [attempt.packetId]);
      expect(runtime.store.orchestration.mergeBacks.get(attempt.mergeBackId)?.state).toBe("uncertain");
      const retry = mergeBack(runtime, child.id);
      expect(retry).toMatchObject({ turnCount: 2 });
      expect(runtime.store.orchestration.mergeBacks.get(retry.mergeBackId)?.baseTurnId).toBeNull();
      const delivered = await finish(runtime, "parent-retry", runtime.conversationId, "completed", [retry.packetId]);
      expect(runtime.store.orchestration.mergeBacks.get(retry.mergeBackId)?.state).toBe("delivered");
      expect(() => mergeBack(runtime, child.id)).toThrow("no finished work");
      await expect(portableRollback(runtime, runtime.conversationId, first.turn.id)).resolves.toMatchObject({ rolledBackTurns: 2 });
      expect(runtime.store.orchestration.history.rolledBack(delivered.turn.id)).toBe(true);
      expect(mergeBack(runtime, child.id)).toMatchObject({ turnCount: 2 });
    } finally { runtime.store.close(); }
  });

  it("serializes concurrent production merge-back commands on the source chat and replays the original request", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { child } = await forkWithWork(runtime);
      const sent: ServerEvent[] = [];
      const invalidated: string[] = [];
      const handler = createConversationCommandHandler({ store: runtime.store, creation: {},
        runtimeSync: { broadcast: (event: { conversationId: string }) => { invalidated.push(event.conversationId); } },
        broadcastSnapshot: () => undefined, send: (_socket: WebSocket, event: ServerEvent) => { sent.push(event); },
      } as unknown as ConversationCommandDependencies);
      const command = (id: string, forkConversationId = child.id) => ({ type: "conversation.merge-back" as const, requestId: id,
        payload: { forkConversationId } });
      const socket = {} as WebSocket;
      const original = requestId();
      await Promise.all([handler(socket, command(original)), handler(socket, command(requestId()))]);
      await handler(socket, command(original));
      const results = sent.map((event) => event.type === "request.result" ? event.result as { mergeBackId: string } : null);
      expect(results.every((result) => result?.mergeBackId === results[0]?.mergeBackId)).toBe(true);
      expect(results).toHaveLength(3);
      expect(invalidated).toEqual([runtime.conversationId, runtime.conversationId, runtime.conversationId]);
      await expect(handler(socket, command(requestId(), runtime.conversationId))).rejects.toThrow("Only a fork");
    } finally { runtime.store.close(); }
  });
});
