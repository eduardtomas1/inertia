import type Database from "better-sqlite3";

import type { DailyWorkDashboard, ProviderId } from "../../shared/contracts";
import {
  projectDailyWork,
  type DailyWorkConversationSource,
  type DailyWorkRange,
  validateDailyWorkRange,
} from "../daily-work";
import { agentTurnFromRow } from "./codecs";
import type { AgentTurnRow } from "./rows";
import { SystemSuspendRepository } from "./system-suspend-repository";

interface DailyWorkConversationRow {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  provider_id: ProviderId;
  created_at: string;
}

function conversationFromRow(
  row: DailyWorkConversationRow,
): DailyWorkConversationSource {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    title: row.title,
    providerId: row.provider_id,
    createdAt: row.created_at,
  };
}

export class DailyWorkRepository {
  constructor(private readonly database: Database.Database) {}

  read(range: DailyWorkRange): DailyWorkDashboard {
    validateDailyWorkRange(range);
    const generatedAt = new Date().toISOString();
    const parameters = {
      fromInclusive: new Date(range.fromInclusive).toISOString(),
      toExclusive: new Date(range.toExclusive).toISOString(),
    };
    const conversations = this.database.prepare(`
      SELECT conversations.id, conversations.project_id,
        projects.name AS project_name, conversations.title,
        conversations.provider_id, conversations.created_at
      FROM conversations
      JOIN projects ON projects.id = conversations.project_id
      WHERE (
        conversations.created_at >= @fromInclusive
        AND conversations.created_at < @toExclusive
      ) OR EXISTS (
        SELECT 1
        FROM agent_turns
        WHERE agent_turns.conversation_id = conversations.id
          AND agent_turns.association = 'authoritative'
          AND (
            (
              agent_turns.status IN ('completed', 'failed', 'cancelled', 'interrupted')
              AND agent_turns.completed_at >= @fromInclusive
              AND agent_turns.completed_at < @toExclusive
            ) OR (
              agent_turns.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
              AND agent_turns.requested_at < @toExclusive
            )
          )
      )
      ORDER BY conversations.id ASC
    `).all(parameters) as DailyWorkConversationRow[];
    const turns = this.database.prepare(`
      SELECT agent_turns.*
      FROM agent_turns
      WHERE agent_turns.association = 'authoritative'
        AND (
          (
            agent_turns.status IN ('completed', 'failed', 'cancelled', 'interrupted')
            AND agent_turns.completed_at >= @fromInclusive
            AND agent_turns.completed_at < @toExclusive
          ) OR (
            agent_turns.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
            AND agent_turns.requested_at < @toExclusive
          )
        )
      ORDER BY agent_turns.updated_at ASC, agent_turns.id ASC
    `).all(parameters) as AgentTurnRow[];
    const suspendIntervals = new SystemSuspendRepository(this.database).read(
      parameters.fromInclusive,
      parameters.toExclusive,
    );
    return projectDailyWork(
      conversations.map(conversationFromRow),
      turns.map(agentTurnFromRow),
      range,
      generatedAt,
      suspendIntervals,
    );
  }
}
