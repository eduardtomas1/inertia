import type Database from "better-sqlite3";

import type { UsageDashboard } from "../../shared/contracts";
import {
  projectUsageDashboard,
  type UsageDashboardRange,
  type UsageDashboardTurn,
  validateUsageDashboardRange,
} from "../usage-dashboard";
import {
  legacyModelSelection,
  parseAgentTurnContinuationIdentity,
  parseAgentTurnUsage,
  parseModelSelection,
} from "./codecs";
import type { AgentTurnRow } from "./rows";

export type { UsageDashboardRange } from "../usage-dashboard";

type UsageDashboardTurnRow = Pick<
  AgentTurnRow,
  | "provider_id"
  | "model_selection_json"
  | "continuation_identity_json"
  | "harness_id"
  | "backend_profile_id"
  | "model"
  | "model_alias"
  | "reasoning_effort"
  | "provider_session_before"
  | "provider_session_after"
  | "started_at"
  | "completed_at"
  | "status"
  | "usage_start_json"
  | "usage_completion_json"
  | "configuration_revision"
  | "association"
>;

function usageDashboardTurnFromRow(
  row: UsageDashboardTurnRow,
): UsageDashboardTurn {
  const modelSelection = parseModelSelection(
    row.model_selection_json,
    () => legacyModelSelection({
      providerId: row.provider_id,
      harnessId: row.harness_id,
      backendProfileId: row.backend_profile_id,
      model: row.model,
      modelAlias: row.model_alias,
      reasoningEffort: row.reasoning_effort,
      configurationRevision: row.configuration_revision,
    }),
  );
  return {
    providerId: row.provider_id,
    modelSelection,
    continuationIdentity: parseAgentTurnContinuationIdentity(
      row.continuation_identity_json,
      modelSelection,
    ),
    model: modelSelection.modelId,
    providerSessionBefore: row.provider_session_before,
    providerSessionAfter: row.provider_session_after,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    usageAtStart: parseAgentTurnUsage(row.usage_start_json),
    usageAtCompletion: parseAgentTurnUsage(row.usage_completion_json),
    association: row.association,
  };
}

export class UsageDashboardRepository {
  constructor(private readonly database: Database.Database) {}

  read(range: UsageDashboardRange): UsageDashboard {
    validateUsageDashboardRange(range);
    const fromInclusive = new Date(range.fromInclusive).toISOString();
    const toExclusive = new Date(range.toExclusive).toISOString();
    const rows = this.database.prepare(`
      SELECT provider_id, model_selection_json, continuation_identity_json,
        harness_id, backend_profile_id, model, model_alias, reasoning_effort,
        provider_session_before, provider_session_after, started_at,
        completed_at, status,
        usage_start_json, usage_completion_json, configuration_revision,
        association
      FROM agent_turns
      WHERE completed_at >= ?
        AND completed_at < ?
        AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND association = 'authoritative'
      ORDER BY completed_at ASC, id ASC
    `).all(fromInclusive, toExclusive) as UsageDashboardTurnRow[];
    return projectUsageDashboard(rows.map(usageDashboardTurnFromRow), range);
  }
}
