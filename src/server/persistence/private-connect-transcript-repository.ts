import type Database from "better-sqlite3";
import type { AgentActivity, AgentPlan, ChatMessage, SubagentTrace } from "../../shared/contracts";
import { PRIVATE_CONNECT_RUNTIME_LIMITS } from "../../shared/private-connect/runtime-contract";
import { PRIVATE_CONNECT_INSPECTION_BYTES } from "../../shared/private-connect/sanitizer";
import { planFromRow } from "./codecs";
import { ConversationHistoryRepository } from "./conversation-history-repository";
import type { AgentPlanRow } from "./rows";

export interface PrivateConnectTranscript {
  messages: Pick<ChatMessage, "id" | "turnId" | "role" | "content" | "createdAt">[];
  activities: Pick<AgentActivity, "id" | "turnId" | "kind" | "title" | "status" | "createdAt">[];
  subagents: Pick<SubagentTrace, "id" | "turnId" | "providerId" | "providerName" | "status" | "updatedAt">[];
  plans: AgentPlan[];
}

/** Reads the same recent tails exposed remotely, without materializing unrelated history. */
export class PrivateConnectTranscriptRepository {
  private readonly content: ConversationHistoryRepository;
  constructor(private readonly database: Database.Database) {
    this.content = new ConversationHistoryRepository(database);
  }

  load(conversationId: string): PrivateConnectTranscript {
    return this.database.transaction(() => {
      const messageRows = this.database.prepare(`SELECT id, turn_id AS turnId, role, created_at AS createdAt FROM messages
        WHERE conversation_id = ? AND role IN ('user', 'assistant') ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(conversationId, PRIVATE_CONNECT_RUNTIME_LIMITS.transcriptMessages) as Omit<PrivateConnectTranscript["messages"][number], "content">[];
      const activityIds = this.database.prepare(`SELECT id FROM activities WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(conversationId, PRIVATE_CONNECT_RUNTIME_LIMITS.activities) as { id: string }[];
      const subagentIds = this.database.prepare(`SELECT id FROM subagent_traces WHERE conversation_id = ? ORDER BY created_at DESC, sequence DESC, id DESC LIMIT ?`)
        .all(conversationId, PRIVATE_CONNECT_RUNTIME_LIMITS.subagents) as { id: string }[];
      const latestPlan = this.database.prepare(`SELECT run_id FROM agent_plans WHERE conversation_id = ? ORDER BY updated_at DESC, run_id DESC LIMIT 1`)
        .get(conversationId) as { run_id: string } | undefined;
      let metadataBytes = 0;
      const boundedRows = <T>(table: string, identity: string, ids: string[], fields: string, sizedFields: string, order: string): T[] => {
        if (!ids.length) return [];
        const predicate = `conversation_id = ? AND ${identity} IN (${ids.map(() => "?").join(",")})`;
        metadataBytes += (this.database.prepare(`SELECT COALESCE(SUM(${sizedFields}), 0) AS bytes FROM ${table} WHERE ${predicate}`)
          .get(conversationId, ...ids) as { bytes: number }).bytes;
        if (metadataBytes > 1024 * 1024) throw new Error("The remote transcript contains oversized metadata.");
        return this.database.prepare(`SELECT ${fields} FROM ${table} WHERE ${predicate} ORDER BY ${order}`).all(conversationId, ...ids) as T[];
      };
      const activities = boundedRows<PrivateConnectTranscript["activities"][number]>("activities", "id", activityIds.map(({ id }) => id),
        "id, turn_id AS turnId, kind, title, status, created_at AS createdAt", "COALESCE(length(CAST(title AS BLOB)), 0)", "created_at, id");
      const subagents = boundedRows<PrivateConnectTranscript["subagents"][number]>("subagent_traces", "id", subagentIds.map(({ id }) => id),
        "id, turn_id AS turnId, provider_id AS providerId, provider_name AS providerName, status, updated_at AS updatedAt", "COALESCE(length(CAST(provider_name AS BLOB)), 0)", "created_at, sequence, id");
      const plans = boundedRows<AgentPlanRow>("agent_plans", "run_id", latestPlan ? [latestPlan.run_id] : [],
        "conversation_id, run_id, turn_id, NULL AS explanation, steps_json", "COALESCE(length(CAST(steps_json AS BLOB)), 0)", "updated_at, run_id").map(planFromRow);
      return {
        messages: messageRows.reverse().map((message) => ({ ...message,
          content: this.content.textPreview(conversationId, "message", message.id, PRIVATE_CONNECT_INSPECTION_BYTES) })),
        activities, subagents, plans,
      };
    })();
  }
}
