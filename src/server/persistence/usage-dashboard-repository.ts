import type Database from "better-sqlite3";

import type { UsageDashboard } from "../../shared/contracts";
import { projectUsageDashboard, type UsageDashboardRange } from "../usage-dashboard";
import { agentTurnFromRow } from "./codecs";
import type { AgentTurnRow } from "./rows";

export type { UsageDashboardRange } from "../usage-dashboard";

export class UsageDashboardRepository {
  constructor(private readonly database: Database.Database) {}

  read(range: UsageDashboardRange): UsageDashboard {
    const rows = this.database.prepare(`
      SELECT *
      FROM agent_turns
      WHERE completed_at >= ?
        AND completed_at < ?
        AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND association = 'authoritative'
      ORDER BY completed_at ASC, id ASC
    `).all(range.fromInclusive, range.toExclusive) as AgentTurnRow[];
    return projectUsageDashboard(rows.map(agentTurnFromRow), range);
  }
}
