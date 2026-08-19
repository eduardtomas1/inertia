import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

export const AGENT_THREAD_MAX_DEPTH = 2;
export const AGENT_THREAD_MAX_CREATES_PER_TURN = 4;
export const AGENT_THREAD_MAX_MUTATIONS_PER_TURN = 8;
export const AGENT_THREAD_MAX_INPUT_CHARS_PER_TURN = 65_536;

export type AgentThreadMutationTool =
  | "inertia_create_conversation"
  | "inertia_send_message"
  | "inertia_stop_conversation"
  | "inertia_archive_conversation";

export type AgentThreadOperationStatus =
  | "approval-pending"
  | "approved"
  | "creating"
  | "dispatching"
  | "completed"
  | "denied"
  | "failed"
  | "interrupted";

export interface AgentManagedConversation {
  childConversationId: string;
  sourceConversationId: string | null;
  sourceTurnId: string | null;
  sourceRunId: string;
  rootConversationId: string;
  sourceHarnessId: string;
  depth: number;
  createdAt: string;
}

export interface AgentThreadOperation {
  id: string;
  sourceConversationId: string | null;
  sourceTurnId: string | null;
  sourceRunId: string;
  toolCallIdHash: string;
  toolName: AgentThreadMutationTool;
  requestFingerprint: string;
  status: AgentThreadOperationStatus;
  childConversationId: string | null;
  inputChars: number;
  resultJson: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentThreadOperationRow {
  id: string;
  source_conversation_id: string | null;
  source_turn_id: string | null;
  source_run_id: string;
  tool_call_id_hash: string;
  tool_name: AgentThreadMutationTool;
  request_fingerprint: string;
  status: AgentThreadOperationStatus;
  child_conversation_id: string | null;
  input_chars: number;
  result_json: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentManagedConversationRow {
  child_conversation_id: string;
  source_conversation_id: string | null;
  source_turn_id: string | null;
  source_run_id: string;
  root_conversation_id: string;
  source_harness_id: string;
  depth: number;
  created_at: string;
}

export function agentThreadDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function operationFromRow(row: AgentThreadOperationRow): AgentThreadOperation {
  return {
    id: row.id,
    sourceConversationId: row.source_conversation_id,
    sourceTurnId: row.source_turn_id,
    sourceRunId: row.source_run_id,
    toolCallIdHash: row.tool_call_id_hash,
    toolName: row.tool_name,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    childConversationId: row.child_conversation_id,
    inputChars: row.input_chars,
    resultJson: row.result_json,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function managedFromRow(row: AgentManagedConversationRow): AgentManagedConversation {
  return {
    childConversationId: row.child_conversation_id,
    sourceConversationId: row.source_conversation_id,
    sourceTurnId: row.source_turn_id,
    sourceRunId: row.source_run_id,
    rootConversationId: row.root_conversation_id,
    sourceHarnessId: row.source_harness_id,
    depth: row.depth,
    createdAt: row.created_at,
  };
}

export class AgentThreadManagementRepository {
  constructor(private readonly database: Database.Database) {}

  recoverInterrupted(now = new Date().toISOString()): number {
    return this.database.prepare(`
      UPDATE agent_thread_operations
      SET status = 'interrupted',
          failure_message = 'The host restarted before this operation settled.',
          updated_at = ?
      WHERE status IN ('approval-pending', 'approved', 'creating', 'dispatching')
    `).run(now).changes;
  }

  managed(conversationId: string): AgentManagedConversation | null {
    const row = this.database.prepare(`
      SELECT * FROM agent_managed_conversations
      WHERE child_conversation_id = ?
    `).get(conversationId) as AgentManagedConversationRow | undefined;
    return row ? managedFromRow(row) : null;
  }

  managedBy(
    sourceConversationId: string,
    childConversationId: string,
  ): AgentManagedConversation | null {
    const row = this.database.prepare(`
      SELECT * FROM agent_managed_conversations
      WHERE child_conversation_id = ? AND source_conversation_id = ?
    `).get(
      childConversationId,
      sourceConversationId,
    ) as AgentManagedConversationRow | undefined;
    return row ? managedFromRow(row) : null;
  }

  targetsActedOnByTurn(
    sourceConversationId: string,
    sourceTurnId: string,
  ): string[] {
    return (this.database.prepare(`
      SELECT child_conversation_id, MAX(updated_at) AS last_acted_at
      FROM agent_thread_operations
      WHERE source_conversation_id = ?
        AND source_turn_id = ?
        AND child_conversation_id IS NOT NULL
      GROUP BY child_conversation_id
      ORDER BY last_acted_at DESC, child_conversation_id DESC
      LIMIT ?
    `).all(
      sourceConversationId,
      sourceTurnId,
      AGENT_THREAD_MAX_MUTATIONS_PER_TURN,
    ) as Array<{ child_conversation_id: string }>).map(
      ({ child_conversation_id: conversationId }) => conversationId,
    );
  }

  operation(id: string): AgentThreadOperation | null {
    const row = this.database.prepare(`
      SELECT * FROM agent_thread_operations WHERE id = ?
    `).get(id) as AgentThreadOperationRow | undefined;
    return row ? operationFromRow(row) : null;
  }

  reserve(input: {
    sourceConversationId: string;
    sourceTurnId: string;
    sourceRunId: string;
    toolCallId: string;
    toolName: AgentThreadMutationTool;
    requestFingerprint: string;
    inputChars: number;
    now: string;
  }): { kind: "reserved"; operation: AgentThreadOperation }
    | { kind: "replay"; operation: AgentThreadOperation }
    | { kind: "conflict"; operation: AgentThreadOperation }
    | { kind: "limit"; reason: string } {
    const toolCallIdHash = agentThreadDigest(input.toolCallId);
    const id = agentThreadDigest([
      input.sourceConversationId,
      input.sourceRunId,
      input.sourceTurnId,
      toolCallIdHash,
    ].join("\0"));
    return this.database.transaction(() => {
      const existing = this.operation(id);
      if (existing) {
        return existing.requestFingerprint === input.requestFingerprint
          && existing.toolName === input.toolName
          ? { kind: "replay" as const, operation: existing }
          : { kind: "conflict" as const, operation: existing };
      }
      const totals = this.database.prepare(`
        SELECT COUNT(*) AS mutations,
          SUM(CASE WHEN tool_name = 'inertia_create_conversation' THEN 1 ELSE 0 END) AS creates,
          COALESCE(SUM(input_chars), 0) AS input_chars
        FROM agent_thread_operations
        WHERE source_turn_id = ?
      `).get(input.sourceTurnId) as {
        mutations: number;
        creates: number;
        input_chars: number;
      };
      if (totals.mutations >= AGENT_THREAD_MAX_MUTATIONS_PER_TURN) {
        return { kind: "limit" as const, reason: "This turn reached its managed-chat action limit." };
      }
      if (
        input.toolName === "inertia_create_conversation"
        && totals.creates >= AGENT_THREAD_MAX_CREATES_PER_TURN
      ) {
        return { kind: "limit" as const, reason: "This turn reached its managed-chat creation limit." };
      }
      if (
        totals.input_chars + input.inputChars
        > AGENT_THREAD_MAX_INPUT_CHARS_PER_TURN
      ) {
        return { kind: "limit" as const, reason: "This turn reached its managed-chat input budget." };
      }
      this.database.prepare(`
        INSERT INTO agent_thread_operations (
          id, source_conversation_id, source_turn_id, source_run_id,
          tool_call_id_hash, tool_name, request_fingerprint, status,
          child_conversation_id, input_chars, result_json, failure_message,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approval-pending', NULL, ?, NULL, NULL, ?, ?)
      `).run(
        id,
        input.sourceConversationId,
        input.sourceTurnId,
        input.sourceRunId,
        toolCallIdHash,
        input.toolName,
        input.requestFingerprint,
        input.inputChars,
        input.now,
        input.now,
      );
      return { kind: "reserved" as const, operation: this.operation(id)! };
    })();
  }

  transition(
    id: string,
    expected: readonly AgentThreadOperationStatus[],
    status: AgentThreadOperationStatus,
    update: {
      childConversationId?: string | null;
      resultJson?: string | null;
      failureMessage?: string | null;
    },
    now: string,
  ): AgentThreadOperation {
    if (expected.length < 1) throw new Error("An operation transition needs an expected state.");
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.database.prepare(`
      UPDATE agent_thread_operations
      SET status = ?,
          child_conversation_id = COALESCE(?, child_conversation_id),
          result_json = ?, failure_message = ?, updated_at = ?
      WHERE id = ? AND status IN (${placeholders})
    `).run(
      status,
      update.childConversationId ?? null,
      update.resultJson ?? null,
      update.failureMessage ?? null,
      now,
      id,
      ...expected,
    );
    if (result.changes !== 1) {
      throw new Error("The managed-chat operation no longer owns its expected state.");
    }
    return this.operation(id)!;
  }

  attachManaged(input: {
    childConversationId: string;
    sourceConversationId: string;
    sourceTurnId: string;
    sourceRunId: string;
    sourceHarnessId: string;
    now: string;
  }, operationId?: string): AgentManagedConversation {
    return this.database.transaction(() => {
      const parent = this.managed(input.sourceConversationId);
      const depth = (parent?.depth ?? 0) + 1;
      if (depth > AGENT_THREAD_MAX_DEPTH) {
        throw new Error("Managed chats cannot create another chat at this depth.");
      }
      const rootConversationId = parent?.rootConversationId
        ?? input.sourceConversationId;
      this.database.prepare(`
        INSERT INTO agent_managed_conversations (
          child_conversation_id, source_conversation_id, source_turn_id,
          source_run_id, root_conversation_id, source_harness_id,
          depth, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.childConversationId,
        input.sourceConversationId,
        input.sourceTurnId,
        input.sourceRunId,
        rootConversationId,
        input.sourceHarnessId,
        depth,
        input.now,
      );
      if (operationId) {
        this.transition(
          operationId,
          ["creating"],
          "dispatching",
          { childConversationId: input.childConversationId },
          input.now,
        );
      }
      return this.managed(input.childConversationId)!;
    })();
  }
}
