import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type { AgentTurn } from "../../src/shared/contracts";
import type { DelegatedCompletionWake, DelegatedTask } from "../../src/shared/orchestration-delegation";
import type { DelegationRepository } from "../../src/server/orchestration-v2/delegation-repository";
import {
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
} from "./turn-controller-runtime";

export interface DelegationFixture {
  runtime: TurnControllerTestRuntime;
  database: Database.Database;
  delegation: DelegationRepository;
  parentId: string;
  live: Map<string, number>;
  conversation(title: string): string;
  queue(conversationId: string, content: string): AgentTurn;
  finish(turn: AgentTurn, result?: { text?: string; status?: "completed" | "failed" }): Promise<AgentTurn>;
  turn(turnId: string): AgentTurn;
  crash(turn: AgentTurn, reason?: string): void;
  delegate(sourceTurn: AgentTurn, options?: { wake?: DelegatedCompletionWake; title?: string; parentId?: string }):
    { task: DelegatedTask; childId: string; childTurn: AgentTurn };
  followUp(original: DelegatedTask, sourceTurn: AgentTurn, existingTurn?: AgentTurn): { task: DelegatedTask; childTurn: AgentTurn };
  operation(sourceTurn: AgentTurn, childId: string, tool: string, target: AgentTurn): string;
  wake(parentId: string, generation: number): AgentTurn;
  close(): void;
}

let sequence = 0;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createDelegationFixture(): Promise<DelegationFixture> {
  const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
  const database = (runtime.store as unknown as { database: Database.Database }).database;
  const delegation = runtime.store.orchestration.delegation;
  const live = new Map<string, number>();
  delegation.useLiveNativeChildren((conversationId, turnId) => live.get(`${conversationId}:${turnId}`) ?? 0);
  const parent = runtime.store.conversation(runtime.conversationId);
  const fixture: DelegationFixture = {
    runtime, database, delegation, parentId: parent.id, live,
    conversation(title) {
      return runtime.store.createConversation(parent.projectId, title, { providerId: "codex", model: "gpt-test",
        reasoningEffort: "high", interactionMode: "build", accessMode: "supervised" }).id;
    },
    queue(conversationId, content) {
      return runtime.controller.queue({ conversationId, content }).turn;
    },
    async finish(turn, result = {}) {
      runtime.controller.start(turn.id);
      runtime.provider.resolve(result.status === "failed" ? { status: "failed" } : { text: result.text ?? `${turn.id} answer` });
      await flushTurnControllerTestPromises();
      return runtime.store.agentTurn(turn.id);
    },
    turn(turnId) {
      return runtime.store.agentTurn(turnId);
    },
    crash(turn, reason = "runtime-crash") {
      database.prepare(`UPDATE agent_turns SET status = 'interrupted', terminal_reason = ?,
        started_at = COALESCE(started_at, requested_at), completed_at = COALESCE(started_at, requested_at)
        WHERE id = ?`).run(reason, turn.id);
    },
    operation(sourceTurn, childId, tool, target) {
      const id = digest(`operation-${++sequence}`);
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO agent_thread_operations (id, source_conversation_id, source_turn_id, source_run_id,
        tool_call_id_hash, tool_name, request_fingerprint, status, child_conversation_id, input_chars, created_at, updated_at,
        target_turn_id, target_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, 0, ?, ?, ?, ?)`)
        .run(id, sourceTurn.conversationId, sourceTurn.id, sourceTurn.runId, digest(`call-${sequence}`), tool, digest("request"),
          childId, now, now, target.id, target.runId);
      return id;
    },
    delegate(sourceTurn, options = {}) {
      const parentId = options.parentId ?? sourceTurn.conversationId;
      const childId = fixture.conversation(options.title ?? `Child ${++sequence}`);
      database.prepare(`INSERT INTO agent_managed_conversations (child_conversation_id, source_conversation_id, source_turn_id,
        source_run_id, root_conversation_id, source_harness_id, depth, created_at) VALUES (?, ?, ?, ?, ?, 'codex-app-server', ?, ?)`)
        .run(childId, parentId, sourceTurn.id, sourceTurn.runId, parentId,
          runtime.store.agentThreadManagement.managed(parentId) ? 2 : 1, new Date().toISOString());
      const childTurn = fixture.queue(childId, `Task for ${childId}`);
      const operationId = fixture.operation(sourceTurn, childId, "inertia_delegate_task", childTurn);
      const task = delegation.create({ operationId, kind: "original", originalTaskId: null, parentConversationId: parentId,
        sourceTurnId: sourceTurn.id, sourceRunId: sourceTurn.runId, childConversationId: childId,
        firstChildTurnId: childTurn.id, firstChildRunId: childTurn.runId, title: options.title ?? "Investigate the cache",
        role: "research", route: { providerId: "codex", harnessId: "codex-app-server", modelId: "gpt-test", reasoningEffort: "high" },
        accessMode: "supervised", interactionMode: "build", workspace: "project", completionWake: options.wake ?? "always" });
      return { task, childId, childTurn };
    },
    followUp(original, sourceTurn, existingTurn) {
      const childTurn = existingTurn ?? fixture.queue(original.childConversationId, "Follow-up");
      const operationId = fixture.operation(sourceTurn, original.childConversationId, "inertia_send_message", childTurn);
      const task = delegation.create({ operationId, kind: "follow-up", originalTaskId: original.taskId,
        parentConversationId: original.parentConversationId, sourceTurnId: sourceTurn.id, sourceRunId: sourceTurn.runId,
        childConversationId: original.childConversationId, firstChildTurnId: childTurn.id, firstChildRunId: childTurn.runId,
        title: "Follow-up", role: null, route: original.route, accessMode: original.accessMode,
        interactionMode: original.interactionMode, workspace: original.workspace, completionWake: "always" });
      return { task, childTurn };
    },
    wake(parentId, generation) {
      const row = database.prepare(`SELECT id, content, delegated_completion_json FROM queued_messages WHERE conversation_id = ?
        AND json_extract(delegated_completion_json, '$.generation') = ? AND state IN ('waiting','blocked')`)
        .get(parentId, generation) as { id: string; content: string; delegated_completion_json: string };
      const turn = fixture.queue(parentId, row.content);
      database.prepare("UPDATE messages SET delegated_completion_json = ? WHERE id = ?").run(row.delegated_completion_json, turn.userMessageId);
      database.prepare(`UPDATE queued_messages SET state = 'accepted', turn_id = ?, user_message_id = ? WHERE id = ?`)
        .run(turn.id, turn.userMessageId, row.id);
      return turn;
    },
    close() {
      runtime.store.close();
    },
  };
  return fixture;
}

export function queuedDeliveries(fixture: DelegationFixture, parentId = fixture.parentId) {
  return fixture.runtime.store.queuedMessages.list(parentId).filter(({ delegatedCompletion }) => delegatedCompletion);
}

export function delegationEvents(fixture: DelegationFixture, parentId = fixture.parentId): string[] {
  return (fixture.database.prepare(`SELECT type FROM orchestration_v2_events WHERE thread_id = ? AND type LIKE 'delegation.%'
    ORDER BY sequence`).all(parentId) as { type: string }[]).map(({ type }) => type);
}
