import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NATIVE_FORK_FALLBACK_NOTICE_TITLE } from "../../src/server/orchestration-v2/native-control-repository";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest, NativeConversationResult } from "../../src/server/provider/native-conversation-operations";
import { retainedMissedRunImageCheck } from "../../src/server/runtime/attachments/trusted-attachment-resolver";
import { prepareForkSession } from "../../src/server/runtime/fork-session-service";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import type { AgentActivity, ChatAttachment } from "../../src/shared/contracts";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(() => {
  vi.restoreAllMocks();
  return cleanupTurnControllerTestDirectories();
});

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function database(runtime: TurnControllerTestRuntime): Database.Database {
  return (runtime.store as unknown as { database: Database.Database }).database;
}

async function finishTurn(runtime: TurnControllerTestRuntime, label: string, conversationId = runtime.conversationId, nativeId = "source-native") {
  const queued = runtime.controller.queue({ conversationId, content: `${label} request` });
  runtime.controller.start(queued.turn.id);
  for (const phase of ["started", "settled"] as const) {
    runtime.provider.emit({
      ...turnControllerTestIdentity(runtime),
      conversationId,
      turnId: queued.turn.id,
      runId: queued.turn.runId,
      type: "native-boundary",
      nativeConversationId: nativeId,
      nativeSessionId: null,
      nativeTurnId: label,
      persistedHeadId: phase === "settled" ? label : null,
      phase,
    });
  }
  runtime.provider.resolve({ text: `${label} answer`, sessionId: nativeId });
  await flushTurnControllerTestPromises();
  return queued;
}

describe("C1: Codex user Stop before provider acceptance carries and pins images", () => {
  it("preserves and resends images from a Codex run stopped by the user before acceptance, while excluding non-user stops", async () => {
    const state = { retained: "" };
    const runtime = await createTurnControllerTestRuntime({
      missedRunImageCheck: () => retainedMissedRunImageCheck({ directory: state.retained })(),
    });
    try {
      await mkdir(join(runtime.directory, "retained"));
      state.retained = await realpath(join(runtime.directory, "retained"));
      const makeImage = async (name: string): Promise<ChatAttachment> => {
        const id = randomUUID();
        const path = join(state.retained, id, `${id}.png`);
        await mkdir(join(state.retained, id));
        await writeFile(path, PNG);
        return { id, name, path, mimeType: "image/png", size: PNG.byteLength };
      };

      await finishTurn(runtime, "opening", runtime.conversationId, "codex-native");

      // Codex run stopped by the USER before provider acceptance -> run-interrupt has cause === "user".
      const userImg = await makeImage("user-stopped.png");
      const userStopped = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Inspect this screenshot",
        attachments: [userImg],
      });
      runtime.controller.start(userStopped.turn.id);
      await flushTurnControllerTestPromises();
      // Record a durable user Stop via runControl, then resolve cancelled before turn acceptance.
      const startedStop = await runtime.store.orchestration.authority.begin({
        projectId: runtime.store.conversation(runtime.conversationId).projectId,
        threadId: runtime.conversationId,
        commandType: "agent.stop",
        rejection: null,
        source: {
          actorId: "human",
          commandId: "stop-user-1",
          command: { type: "agent.stop", conversationId: runtime.conversationId },
        },
      }, (ticket) => {
        const target = runtime.store.orchestration.runControl.target(userStopped.turn.runId)!;
        runtime.store.orchestration.runControl.recordInterrupt(ticket, target, userStopped.turn.id, "user");
      });
      if (startedStop.kind === "lead") startedStop.ticket.finish(null);
      runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();

      expect(runtime.store.orchestration.events.projection("run", userStopped.turn.runId)?.value)
        .toMatchObject({ status: "cancelled", delivery: "not-delivered" });
      // Image must be pinned (not evictable) and carried on the next prompt!
      expect(runtime.store.evictableAttachmentIds()).not.toContain(userImg.id);

      // A Codex run stopped by an agent (cause !== "user") without promptDropped must NOT be carried or pinned.
      const agentImg = await makeImage("agent-stopped.png");
      const agentStopped = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Agent cancelled turn",
        attachments: [agentImg],
      });
      runtime.controller.start(agentStopped.turn.id);
      await flushTurnControllerTestPromises();
      // That start itself carried userImg alongside agentImg.
      expect(runtime.provider.input?.imagePaths).toEqual([userImg.path, agentImg.path]);
      const startedAgentStop = await runtime.store.orchestration.authority.begin({
        projectId: runtime.store.conversation(runtime.conversationId).projectId,
        threadId: runtime.conversationId,
        commandType: "agent.stop",
        rejection: null,
        source: {
          actorId: "runtime",
          commandId: "stop-agent-1",
          command: { type: "agent.stop", conversationId: runtime.conversationId },
        },
      }, (ticket) => {
        const agentTarget = runtime.store.orchestration.runControl.target(agentStopped.turn.runId)!;
        runtime.store.orchestration.runControl.recordInterrupt(ticket, agentTarget, agentStopped.turn.id, "agent");
      });
      if (startedAgentStop.kind === "lead") startedAgentStop.ticket.finish(null);
      runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();

      expect(runtime.store.evictableAttachmentIds()).toContain(agentImg.id);
      expect(runtime.store.evictableAttachmentIds()).not.toContain(userImg.id);

      // Next delivered turn carries userImg (and NOT agentImg), then releases eviction pin!
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Try again" });
      runtime.controller.start(next.turn.id);
      await flushTurnControllerTestPromises();
      expect(runtime.provider.input?.imagePaths).toEqual([userImg.path]);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Saw it" });
      runtime.provider.resolve({ sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.evictableAttachmentIds()).toContain(userImg.id);
    } finally {
      runtime.store.close();
    }
  });
});

describe("C2: Fork history excludes active queued unread follow-ups and superseded turns", () => {
  it("never copies messages named by active queued_messages.user_message_id or turns marked superseded-turn", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finishTurn(runtime, "first");
      const superseded = await finishTurn(runtime, "superseded");
      const third = await finishTurn(runtime, "third");
      const db = database(runtime);
      const parent = runtime.store.conversation(runtime.conversationId);

      // Add an unread follow-up message attached to turn 3 and an active queued_messages row pointing at it.
      const unreadMsgId = randomUUID();
      db.prepare(`INSERT INTO messages (id, conversation_id, role, content, attachments_json, turn_id, created_at)
        VALUES (?, ?, 'user', ?, '[]', ?, ?)`)
        .run(unreadMsgId, parent.id, "UNREAD_FOLLOW_UP_SECRET", third.turn.id, "2026-11-26T00:00:00.000Z");
      db.prepare(`INSERT INTO queued_messages
        (id, conversation_id, content, attachments_json, intent_digest, route_identity, state, user_message_id, created_at)
        VALUES (?, ?, ?, '[]', ?, '{}', 'waiting', ?, ?)`)
        .run(randomUUID(), parent.id, "UNREAD_FOLLOW_UP_SECRET", "0".repeat(64), unreadMsgId, "2026-11-26T00:00:00.000Z");

      // Mark turn 2 as superseded-turn in orchestration_v2_entities.
      db.prepare(`INSERT INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
        VALUES ('superseded-turn', ?, ?, ?, 999, ?)`)
        .run(superseded.turn.id, parent.projectId, parent.id, JSON.stringify({ turnId: superseded.turn.id }));

      const forkInput = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: third.turn.id, activate: false };
      const child = runtime.store.orchestration.forks.create(forkInput, { actorId: "human", commandId: "fork-c2", command: { ...forkInput } });
      const inheritedText = runtime.store.orchestration.forks.history(child.id, 0, 100).parts.map(({ text }) => text).join("\n");

      expect(inheritedText).toContain("first request");
      expect(inheritedText).toContain("third answer");
      expect(inheritedText).not.toContain("UNREAD_FOLLOW_UP_SECRET");
      expect(inheritedText).not.toContain("superseded request");
      expect(inheritedText).not.toContain("superseded answer");
      expect(first.turn.id).not.toBe(superseded.turn.id);
    } finally {
      runtime.store.close();
    }
  });
});

describe("Audit 2 Bug #9: MergeBackRepository.forRun scopes by thread_id", () => {
  it("settles a thread's merge-back even when > 256 merge-backs exist across other threads", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    try {
      const parent = runtime.store.conversation(runtime.conversationId);
      const first = await finishTurn(runtime, "parent-first");
      const forkInput = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: first.turn.id, activate: false };
      const child = runtime.store.orchestration.forks.create(forkInput, { actorId: "human", commandId: "fork-mb", command: { ...forkInput } });
      await finishTurn(runtime, "fork-work", child.id, "child-native");

      const cmdId = randomUUID();
      const prepared = runtime.store.orchestration.mergeBacks.prepare(child.id, {
        actorId: "human", commandId: cmdId,
        command: { type: "conversation.merge-back", requestId: cmdId, payload: { forkConversationId: child.id } },
      });

      // Seed 300 higher-revision merge-back rows in OTHER threads so an unscoped LIMIT 256 scan would miss our thread!
      const db = database(runtime);
      const originalRow = db.prepare("SELECT payload_json FROM orchestration_v2_entities WHERE kind = 'merge-back' AND id = ?")
        .get(prepared.mergeBackId) as { payload_json: string };
      const baseMerge = JSON.parse(originalRow.payload_json) as Record<string, unknown>;
      const insertNoise = db.prepare(`INSERT INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
        VALUES ('merge-back', ?, ?, ?, ?, ?)`);
      db.transaction(() => {
        for (let i = 0; i < 300; i += 1) {
          const otherThread = `other-thread-${i}`;
          const id = `noise-merge-${i}`;
          insertNoise.run(id, parent.projectId, otherThread, 10_000 + i, JSON.stringify({
            ...baseMerge, id, parentThreadId: otherThread, forkThreadId: `other-fork-${i}`,
          }));
        }
      })();

      // Attach and complete a turn on parent delivering the merge-back.
      const delivery = runtime.controller.queue({
        conversationId: parent.id,
        content: "Deliver merge-back despite 300 other-thread rows",
        context: { conversationContextPacketIds: [prepared.packetId] },
        contextRequestId: randomUUID(),
      });
      runtime.controller.start(delivery.turn.id);
      expect(runtime.store.orchestration.mergeBacks.get(prepared.mergeBackId)?.state).toBe("dispatched");
      runtime.provider.resolve({ text: "Delivered!" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.mergeBacks.get(prepared.mergeBackId)?.state).toBe("delivered");
    } finally {
      runtime.store.close();
    }
  });
});

describe("D.5: Visible notice on provider-side native fork failure and conversation-only rollback with missing checkpoint", () => {
  it("records and broadcasts a visible non-blocking notice without leaking stderr/secrets when a native fork fails to portable", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finishTurn(runtime, "first");
      const parent = runtime.store.conversation(runtime.conversationId);
      const forkInput = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: first.turn.id, activate: false };
      const child = runtime.store.orchestration.forks.create(forkInput, { actorId: "human", commandId: "fork-d5", command: { ...forkInput } });
      const broadcasted: AgentActivity[] = [];
      const deps = {
        store: runtime.store,
        turns: runtime.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
        providers: {
          resolveModelRoute: runtime.provider.resolveModelRoute,
          isRunning: (id: string) => runtime.provider.isRunning(id),
          nativeConversation: vi.fn(async (request: NativeConversationRequest): Promise<NativeConversationResult> => ({
            operationId: request.operationId,
            identity: request.source.identity,
            targetConversationId: request.kind === "fork" ? request.targetConversationId : undefined,
            status: "failed",
            reason: "provider-failure",
            mutationMayHaveOccurred: false,
          })),
        },
        broadcast: ({ activity }: { type: "agent.activity"; activity: AgentActivity }) => { broadcasted.push(activity); },
      };

      await prepareForkSession(deps, child.id, new AbortController().signal);
      expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("portable");

      const activities = database(runtime).prepare("SELECT kind, title, detail, status, turn_id FROM activities WHERE conversation_id = ?")
        .all(child.id) as { kind: string; title: string; detail: string | null; status: string; turn_id: string | null }[];
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        kind: "status",
        title: NATIVE_FORK_FALLBACK_NOTICE_TITLE,
        status: "completed",
        turn_id: null,
      });
      expect(activities[0]!.detail).toContain("continue portably with copied history");
      expect(broadcasted).toHaveLength(1);
      expect(broadcasted[0]!.title).toBe(NATIVE_FORK_FALLBACK_NOTICE_TITLE);

      // Rejected with secret-bearing raw reason string must NEVER leak that raw reason into the visible notice!
      const child2 = runtime.store.orchestration.forks.create(forkInput, { actorId: "human", commandId: "fork-d5-rej", command: { ...forkInput } });
      const secretDeps = {
        ...deps,
        providers: {
          ...deps.providers,
          nativeConversation: vi.fn(async (request: NativeConversationRequest): Promise<NativeConversationResult> => ({
            operationId: request.operationId,
            identity: request.source.identity,
            targetConversationId: request.kind === "fork" ? request.targetConversationId : undefined,
            status: "rejected",
            reason: "stderr: Authorization: Bearer sk-secret-token-99999",
          })),
        },
      };
      await prepareForkSession(secretDeps, child2.id, new AbortController().signal);
      const rejActivities = database(runtime).prepare("SELECT title, detail FROM activities WHERE conversation_id = ?")
        .all(child2.id) as { title: string; detail: string | null }[];
      expect(rejActivities).toHaveLength(1);
      expect(rejActivities[0]!.title).toBe(NATIVE_FORK_FALLBACK_NOTICE_TITLE);
      expect(rejActivities[0]!.detail).toContain("continue portably with copied history");
      expect(rejActivities[0]!.detail).not.toContain("sk-secret-token-99999");
      expect(rejActivities[0]!.detail).not.toContain("stderr");

      // And the fork continues portably without blocking!
      const send = runtime.controller.queue({ conversationId: child.id, content: "Continue portably" });
      runtime.controller.start(send.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("first answer");
      runtime.provider.resolve({ text: "Portable response" });
      await flushTurnControllerTestPromises();
    } finally {
      runtime.store.close();
    }
  });

  it("allows conversation-only rollback (restoreFiles: false) even when checkpoint artifact is missing", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finishTurn(runtime, "first");
      const second = await finishTurn(runtime, "second");
      const third = await finishTurn(runtime, "third");
      // Turn 2 has NO checkpoint artifact at all (missing), and turn 3 has an unavailable checkpoint artifact.
      expect(runtime.store.turnGitArtifact(second.turn.id)).toBeNull();
      const now = new Date().toISOString();
      runtime.store.createTurnGitArtifact({ turnId: third.turn.id, status: "pending", createdAt: now });
      runtime.store.completeTurnGitArtifact(third.turn.id, {
        files: [], insertions: 0, deletions: 0, status: "unavailable", completeness: "unavailable", updatedAt: now,
      });
      expect(runtime.store.turnGitArtifact(third.turn.id)?.status).toBe("unavailable");

      const deps = {
        store: runtime.store,
        turns: runtime.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
        providers: {
          resolveModelRoute: runtime.provider.resolveModelRoute,
          isRunning: (id: string) => runtime.provider.isRunning(id),
          nativeConversation: vi.fn(async (request: NativeConversationRequest): Promise<NativeConversationResult> => ({
            operationId: request.operationId,
            identity: request.source.identity,
            status: "unsupported",
            reason: "fixture",
          })),
        },
      };
      const requestId = randomUUID();
      const result = await rollbackConversationHistory(deps, {
        conversationId: runtime.conversationId,
        turnId: first.turn.id,
        restoreFiles: false,
        source: {
          actorId: "human",
          commandId: requestId,
          command: { type: "conversation.rollback", requestId, payload: { conversationId: runtime.conversationId, turnId: first.turn.id, restoreFiles: false } },
        },
      }, new AbortController().signal);

      expect(result).toMatchObject({
        transfer: "portable",
        retainedTurnId: first.turn.id,
        rolledBackTurns: 2,
        files: { outcome: "unchanged", message: null },
      });
      expect(runtime.store.orchestration.history.rolledBack(second.turn.id)).toBe(true);
      expect(runtime.store.orchestration.history.rolledBack(third.turn.id)).toBe(true);
      expect(runtime.store.orchestration.history.rolledBack(first.turn.id)).toBe(false);
    } finally {
      runtime.store.close();
    }
  });
});
