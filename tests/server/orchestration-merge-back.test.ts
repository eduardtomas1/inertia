import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { createConversationCommandHandler, type ConversationCommandDependencies } from "../../src/server/runtime/commands/conversation-commands";
import { ConversationContextService } from "../../src/server/runtime/conversation-context-service";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import type { ServerEvent } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { MAX_CONVERSATION_CONTEXT_SUPPLEMENT_BYTES, MAX_CONVERSATION_CONTEXT_SUPPLEMENT_COMMANDS } from "../../src/shared/conversation-context";
import { mergeBackResultSchema } from "../../src/shared/orchestration-merge-back";
import { OrchestrationConflict } from "../../src/server/orchestration-v2/types";
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

function mergeBack(runtime: TurnControllerTestRuntime, forkId: string, commandId = requestId(), throughTurnId?: string) {
  const command = { type: "conversation.merge-back", requestId: commandId,
    payload: { forkConversationId: forkId, ...(throughTurnId ? { throughTurnId } : {}) } };
  return runtime.store.orchestration.mergeBacks.prepare(forkId, { actorId: "human", commandId, command }, throughTurnId ?? null);
}

function database(runtime: TurnControllerTestRuntime) {
  return (runtime.store as unknown as { database: Database.Database }).database;
}

function excerptText(runtime: TurnControllerTestRuntime, packetId: string) {
  return runtime.store.contextPackets.get(packetId, runtime.conversationId).excerpts.map(({ content }) => content).join("\n");
}

function recordCommand(runtime: TurnControllerTestRuntime, conversationId: string, turn: { id: string; runId: string }, text: string,
  title = "Bash") {
  runtime.store.addActivity({ conversationId, runId: turn.runId, turnId: turn.id, kind: "command", title,
    detail: `Command:\n${text}\n\nOutput:\nRAW-COMMAND-OUTPUT`, status: "completed" });
}

function changedFiles(runtime: TurnControllerTestRuntime, turnId: string, paths: readonly string[]) {
  const createdAt = new Date().toISOString();
  runtime.store.createTurnGitArtifact({ turnId, status: "pending", createdAt });
  runtime.store.completeTurnGitArtifact(turnId, {
    files: paths.map((path) => ({ path, previousPath: null, status: "modified", insertions: 1, deletions: 0, binary: false,
      untracked: false, staged: false, unstaged: true, indexStatus: " ", worktreeStatus: "M" })),
    insertions: paths.length, deletions: 0, status: "ready", completeness: "complete", updatedAt: createdAt,
  });
}

function duoSide(runtime: TurnControllerTestRuntime, conversationId: string) {
  const launchId = randomUUID();
  const projectId = runtime.store.conversation(conversationId).projectId;
  runtime.store.createPairedLaunch(launchId, ([0, 1] as const).map((ordinal) => ({ ordinal, projectId,
    plannedConversationId: ordinal === 0 ? conversationId : randomUUID(), plannedWorktreePath: null, plannedBranch: null,
    ownsWorktree: false })) as never);
  database(runtime).prepare(`UPDATE paired_launch_sides SET conversation_id = planned_conversation_id
    WHERE launch_id = ? AND ordinal = 0`).run(launchId);
  return () => database(runtime).prepare("UPDATE paired_launches SET status = 'cancelled' WHERE id = ?").run(launchId);
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

function mergeAttachment(prompt: string) {
  const line = prompt.split("\n").find((value) => value.startsWith("{\"version\":1"));
  const { attachments } = JSON.parse(line ?? "{}") as { attachments?: { label: string }[] };
  return JSON.stringify(attachments?.find(({ label }) => label.startsWith("Chat context")) ?? null);
}

async function finishInSession(runtime: TurnControllerTestRuntime, label: string, conversationId: string, sessionId: string) {
  const queued = runtime.controller.queue({ conversationId, content: `${label} request` });
  runtime.controller.start(queued.turn.id);
  runtime.provider.resolve({ text: `${label} answer`, sessionId });
  await flushTurnControllerTestPromises();
  return { turn: queued.turn };
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

  it("keeps one fork's findings pending in the source chat until they are delivered or removed", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { child } = await forkWithWork(runtime);
      const second = await finish(runtime, "parent-second");
      const sibling = fork(runtime, second.turn.id);
      await finish(runtime, "sibling-work", sibling.id);
      const waiting = mergeBack(runtime, child.id);
      const revision = runtime.store.orchestration.events.revision(runtime.conversationId);
      expect(() => mergeBack(runtime, sibling.id))
        .toThrow("Another fork's findings are already waiting in the source chat. Send or remove that draft first.");
      expect(runtime.store.orchestration.events.revision(runtime.conversationId)).toBe(revision);
      expect(mergeBack(runtime, child.id)).toEqual(waiting);
      runtime.store.contextPackets.deleteDraft(waiting.packetId, runtime.conversationId);
      const next = mergeBack(runtime, sibling.id);
      expect(next).toMatchObject({ forkConversationId: sibling.id, turnCount: 1 });
      expect(runtime.store.orchestration.mergeBacks.get(waiting.mergeBackId)?.state).toBe("withdrawn");
      expect(() => mergeBack(runtime, child.id)).toThrow("already waiting in the source chat");
      const delivery = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Use the sibling findings",
        context: { conversationContextPacketIds: [next.packetId] }, contextRequestId: requestId() });
      expect(runtime.store.orchestration.mergeBacks.get(next.mergeBackId)?.state).toBe("attached");
      expect(() => mergeBack(runtime, child.id)).toThrow("Another fork's findings are still being delivered to the source chat.");
      runtime.controller.start(delivery.turn.id);
      expect(() => mergeBack(runtime, child.id)).toThrow("still being delivered to the source chat");
      runtime.provider.resolve({ text: "sibling delivered" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.mergeBacks.get(next.mergeBackId)?.state).toBe("delivered");
      const released = mergeBack(runtime, child.id);
      expect(released).toMatchObject({ forkConversationId: child.id, turnCount: 2 });
      expect(excerptText(runtime, released.packetId)).toContain("fork-two answer");
    } finally { runtime.store.close(); }
  });

  it("merges back through an explicit finished fork turn and refuses unusable points", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { first, child, one, two } = await forkWithWork(runtime);
      expect(clientCommandSchema.safeParse({ type: "conversation.merge-back", requestId: requestId(),
        payload: { forkConversationId: child.id, throughTurnId: one.turn.id } }).success).toBe(true);
      expect(clientCommandSchema.safeParse({ type: "conversation.merge-back", requestId: requestId(),
        payload: { forkConversationId: child.id, throughTurnId: "latest" } }).success).toBe(false);
      expect(() => mergeBack(runtime, child.id, requestId(), first.turn.id)).toThrow("That turn is not part of this fork.");
      const commandId = requestId();
      const explicit = mergeBack(runtime, child.id, commandId, one.turn.id);
      expect(explicit).toMatchObject({ turnCount: 1, messageCount: 2, throughTurnId: one.turn.id,
        requestedThroughTurnId: one.turn.id });
      expect(excerptText(runtime, explicit.packetId)).toContain("fork-one answer");
      expect(excerptText(runtime, explicit.packetId)).not.toContain("fork-two answer");
      const record = runtime.store.orchestration.mergeBacks.get(explicit.mergeBackId);
      expect(record).toMatchObject({ baseTurnId: null, throughTurnId: one.turn.id, requestedThroughTurnId: one.turn.id,
        turnIds: [one.turn.id] });
      const revision = runtime.store.orchestration.events.revision(runtime.conversationId);
      expect(mergeBack(runtime, child.id, commandId, one.turn.id)).toEqual(explicit);
      expect(runtime.store.orchestration.events.revision(runtime.conversationId)).toBe(revision);
      expect(() => mergeBack(runtime, child.id, commandId)).toThrow(OrchestrationConflict);
      expect(() => mergeBack(runtime, child.id, commandId, two.turn.id)).toThrow(OrchestrationConflict);
      expect(mergeBack(runtime, child.id, requestId(), one.turn.id)).toEqual(explicit);
      runtime.store.orchestration.events.rebuildProjections();
      expect(runtime.store.orchestration.mergeBacks.get(explicit.mergeBackId)).toEqual(record);
      expect(mergeBack(runtime, child.id, commandId, one.turn.id)).toEqual(explicit);
      await finish(runtime, "parent-explicit", runtime.conversationId, "completed", [explicit.packetId]);
      expect(runtime.store.orchestration.mergeBacks.get(explicit.mergeBackId)?.state).toBe("delivered");
      expect(() => mergeBack(runtime, child.id, requestId(), one.turn.id))
        .toThrow("That turn's findings were already merged back into the source chat.");
      const rest = mergeBack(runtime, child.id);
      expect(rest).toMatchObject({ turnCount: 1, throughTurnId: two.turn.id, requestedThroughTurnId: null });
      expect(runtime.store.orchestration.mergeBacks.get(rest.mergeBackId)).toMatchObject({ baseTurnId: one.turn.id });
      runtime.store.contextPackets.deleteDraft(rest.packetId, runtime.conversationId);
      const pending = runtime.controller.queue({ conversationId: child.id, content: "unfinished fork work" });
      expect(() => mergeBack(runtime, child.id, requestId(), pending.turn.id)).toThrow("That turn has not finished yet.");
      runtime.controller.start(pending.turn.id);
      runtime.provider.resolve({ text: "late fork answer" });
      await flushTurnControllerTestPromises();
      await expect(portableRollback(runtime, child.id, one.turn.id)).resolves.toMatchObject({ transfer: "portable" });
      expect(() => mergeBack(runtime, child.id, requestId(), two.turn.id))
        .toThrow("That turn was rolled back in the fork, so its findings can no longer be merged back.");
      expect(() => mergeBack(runtime, child.id, requestId(), pending.turn.id)).toThrow("rolled back in the fork");
    } finally { runtime.store.close(); }
  });

  it("passes the explicit source point through the production command", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { child, one } = await forkWithWork(runtime);
      const sent: ServerEvent[] = [];
      const handler = createConversationCommandHandler({ store: runtime.store, creation: {},
        runtimeSync: { broadcast: () => undefined }, broadcastSnapshot: () => undefined,
        send: (_socket: WebSocket, event: ServerEvent) => { sent.push(event); },
      } as unknown as ConversationCommandDependencies);
      await handler({} as WebSocket, { type: "conversation.merge-back", requestId: requestId(),
        payload: { forkConversationId: child.id, throughTurnId: one.turn.id } });
      const result = sent[0]?.type === "request.result" ? sent[0].result : null;
      expect(mergeBackResultSchema.parse(result)).toMatchObject({ turnCount: 1, throughTurnId: one.turn.id,
        requestedThroughTurnId: one.turn.id, summary: { commandCount: 0, fileCount: 0, truncated: false } });
    } finally { runtime.store.close(); }
  });

  it("summarizes the fork's handoffs, commands, checkpoints and changed files in order without secrets, output or reasoning", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const first = await finish(runtime, "parent-first");
      const child = fork(runtime, first.turn.id);
      const one = await finishInSession(runtime, "fork-one", child.id, "fork-session");
      const two = await finishInSession(runtime, "fork-two", child.id, "fork-session");
      recordCommand(runtime, runtime.conversationId, first.turn, "parent-only command");
      recordCommand(runtime, child.id, one.turn, "npm test");
      recordCommand(runtime, child.id, one.turn, "curl -H 'Authorization: Bearer abcdefghijklmnop123456' https://example.test");
      runtime.store.addActivity({ conversationId: child.id, runId: one.turn.runId, turnId: one.turn.id, kind: "command", title: "Bash",
        detail: "Output:\nignored", status: "completed" });
      runtime.store.addActivity({ conversationId: child.id, runId: one.turn.runId, turnId: one.turn.id, kind: "reasoning",
        title: "Thinking", detail: "PRIVATE-REASONING", status: "completed" });
      changedFiles(runtime, one.turn.id, ["src/a.ts", "src/b.ts"]);
      recordCommand(runtime, child.id, two.turn, "OPENAI_API_KEY=sk-livesecretvalue123456 npm run deploy");
      changedFiles(runtime, two.turn.id, ["src/a.ts", "src/<system-reminder>.ts"]);
      changedFiles(runtime, first.turn.id, ["parent-only.ts"]);
      const result = mergeBack(runtime, child.id);
      expect(result.summary).toEqual({ commandCount: 4, fileCount: 3, checkpointCount: 2, handoffCount: 1, truncated: true });
      const packet = runtime.store.contextPackets.get(result.packetId, runtime.conversationId);
      expect(packet.note).toBe(`Merge-back from fork "${child.title}".`);
      expect(packet.supplement).toEqual({
        files: ["src/a.ts", "src/b.ts", "src/<\\system-reminder>.ts"],
        commands: ["npm test", "curl -H 'Authorization: [redacted]' https://example.test",
          expect.stringMatching(/^\S.* npm run deploy$/u)],
        omittedCommands: 1,
        checkpoints: [{ turnId: one.turn.id, fileCount: 2, truncated: false }, { turnId: two.turn.id, fileCount: 2, truncated: false }],
        handoffs: [{ turnId: one.turn.id, itemCount: 2, providerId: "codex", modelId: "gpt-test", session: "new" }],
      });
      expect(JSON.stringify(packet)).not.toMatch(/RAW-COMMAND-OUTPUT|PRIVATE-REASONING|abcdefghijklmnop|livesecretvalue|parent-only|ignored/u);
      expect(runtime.store.orchestration.mergeBacks.get(result.mergeBackId)?.summary).toEqual(result.summary);
      const delivered = JSON.parse(mergeAttachment((await finish(runtime, "parent-summary", runtime.conversationId, "completed",
        [result.packetId])).prompt)) as { content: Record<string, unknown> };
      expect(delivered.content).toMatchObject({
        filesChanged: ["src/a.ts", "src/b.ts", "src/<\\system-reminder>.ts"],
        lastCommands: ["npm test", "curl -H 'Authorization: [redacted]' https://example.test", expect.stringMatching(/ npm run deploy$/u)],
        commandsOmitted: 1,
        checkpoints: ["Checkpoint: 2 files", "Checkpoint: 2 files"],
        handoffs: ["Handoff: 2 earlier items to codex gpt-test in a new session"],
      });
      expect(delivered.content).not.toHaveProperty("checkpointsOmitted");
      expect(delivered.content).not.toHaveProperty("handoffsOmitted");
      expect(JSON.stringify(delivered)).not.toMatch(/RAW-COMMAND-OUTPUT|PRIVATE-REASONING|livesecretvalue|parent-only/u);
    } finally { runtime.store.close(); }
  });

  it("names a delivered handoff into an existing provider session as resumed", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const first = await finish(runtime, "parent-first");
      const child = fork(runtime, first.turn.id);
      const one = await finishInSession(runtime, "fork-one", child.id, "fork-session");
      const prepared = database(runtime).prepare(`UPDATE orchestration_v2_events
        SET payload_json = json_set(payload_json, '$.targetBackingId', 'existing-backing')
        WHERE thread_id = ? AND type = 'context.handoff-prepared'`).run(child.id);
      expect(prepared.changes).toBe(1);
      const result = mergeBack(runtime, child.id);
      expect(runtime.store.contextPackets.get(result.packetId, runtime.conversationId).supplement?.handoffs)
        .toEqual([{ turnId: one.turn.id, itemCount: 2, providerId: "codex", modelId: "gpt-test", session: "resumed" }]);
      const delivered = mergeAttachment((await finish(runtime, "parent-resumed", runtime.conversationId, "completed",
        [result.packetId])).prompt);
      expect(delivered).toContain("Handoff: 2 earlier items to codex gpt-test in a resumed session");
    } finally { runtime.store.close(); }
  });

  it("bounds the work summary by line count and serialized size and counts what it omits", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { child, one, two } = await forkWithWork(runtime);
      for (let index = 0; index < 80; index += 1) recordCommand(runtime, child.id, one.turn, `npm run step-${index}`);
      changedFiles(runtime, two.turn.id, Array.from({ length: 120 }, (_, index) => `src/generated/file-${index}.ts`));
      const capped = mergeBack(runtime, child.id);
      expect(capped.summary).toEqual({ commandCount: 80, fileCount: 120, checkpointCount: 1, handoffCount: 0, truncated: true });
      const cappedSupplement = runtime.store.contextPackets.get(capped.packetId, runtime.conversationId).supplement!;
      expect(cappedSupplement.commands).toEqual(Array.from({ length: MAX_CONVERSATION_CONTEXT_SUPPLEMENT_COMMANDS },
        (_, index) => `npm run step-${index}`));
      expect(cappedSupplement.omittedCommands).toBe(80 - MAX_CONVERSATION_CONTEXT_SUPPLEMENT_COMMANDS);
      expect(cappedSupplement.checkpoints).toEqual([{ turnId: two.turn.id, fileCount: 120, truncated: false }]);
      expect(cappedSupplement.omittedCheckpoints).toBeUndefined();
      expect(cappedSupplement.files).toHaveLength(120);
      expect(cappedSupplement.omittedFiles).toBeUndefined();
      await finish(runtime, "parent-capped", runtime.conversationId, "completed", [capped.packetId]);
      const three = await finish(runtime, "fork-three", child.id);
      for (let index = 0; index < 90; index += 1) recordCommand(runtime, child.id, three.turn, `npm run long-${index} ${"x".repeat(300)}`);
      changedFiles(runtime, three.turn.id, Array.from({ length: 50 }, (_, index) => `src/late/file-${index}.ts`));
      const sized = mergeBack(runtime, child.id);
      expect(sized.summary).toEqual({ commandCount: 90, fileCount: 50, checkpointCount: 1, handoffCount: 0, truncated: true });
      const supplement = runtime.store.contextPackets.get(sized.packetId, runtime.conversationId).supplement!;
      const bytes = Buffer.byteLength(JSON.stringify(supplement));
      expect(bytes).toBeGreaterThan(4_096);
      expect(bytes).toBeLessThanOrEqual(MAX_CONVERSATION_CONTEXT_SUPPLEMENT_BYTES);
      expect(supplement.commands!.every((line) => line.startsWith("npm run long-") && line.length <= 240)).toBe(true);
      expect(supplement.commands!.length + supplement.omittedCommands!).toBe(90);
      expect(supplement.checkpoints).toBeUndefined();
      expect(supplement.omittedCheckpoints).toBe(1);
      expect(supplement.files).toBeUndefined();
      expect(supplement.omittedFiles).toBe(50);
      const delivered = await finish(runtime, "parent-sized", runtime.conversationId, "completed", [sized.packetId]);
      expect(delivered.prompt).toContain("npm run long-0");
      expect(delivered.prompt).toContain("filesOmitted");
      expect(delivered.prompt).toContain("checkpointsOmitted");
    } finally { runtime.store.close(); }
  });

  it("replays merge-back records written before the source point and work summary existed", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { child, two } = await forkWithWork(runtime);
      recordCommand(runtime, child.id, two.turn, "npm test");
      const result = mergeBack(runtime, child.id, requestId(), two.turn.id);
      expect(runtime.store.orchestration.mergeBacks.get(result.mergeBackId)).toMatchObject({
        requestedThroughTurnId: two.turn.id, summary: { commandCount: 1, fileCount: 0, truncated: false } });
      database(runtime).prepare(`UPDATE orchestration_v2_events
        SET payload_json = json_remove(payload_json, '$.requestedThroughTurnId', '$.summary')
        WHERE type = 'merge-back.prepared' AND json_extract(payload_json, '$.id') = ?`).run(result.mergeBackId);
      runtime.store.orchestration.events.rebuildProjections();
      expect(runtime.store.orchestration.mergeBacks.get(result.mergeBackId)).toMatchObject({ state: "prepared",
        throughTurnId: two.turn.id, requestedThroughTurnId: null, summary: { commandCount: 0, fileCount: 0, truncated: false } });
      await finish(runtime, "parent-legacy", runtime.conversationId, "completed", [result.packetId]);
      expect(runtime.store.orchestration.mergeBacks.get(result.mergeBackId)?.state).toBe("delivered");
    } finally { runtime.store.close(); }
  });

  it("refuses merge-back while the fork or its source chat is in an unsettled Duo", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const { child } = await forkWithWork(runtime);
      const settleParent = duoSide(runtime, runtime.conversationId);
      const revision = runtime.store.orchestration.events.revision(runtime.conversationId);
      expect(() => mergeBack(runtime, child.id)).toThrow("belongs to a Duo that is still running or needs attention");
      expect(runtime.store.orchestration.events.revision(runtime.conversationId)).toBe(revision);
      settleParent();
      const settleFork = duoSide(runtime, child.id);
      expect(() => mergeBack(runtime, child.id)).toThrow("belongs to a Duo that is still running or needs attention");
      settleFork();
      expect(mergeBack(runtime, child.id)).toMatchObject({ forkConversationId: child.id, turnCount: 2 });
    } finally { runtime.store.close(); }
  });
});
