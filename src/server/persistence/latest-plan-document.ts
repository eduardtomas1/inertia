import type Database from "better-sqlite3";

import type { AgentPlan } from "../../shared/contracts";
import { planFromRow } from "./codecs";
import type { AgentPlanRow } from "./rows";
import { cachedStatement } from "./statement-cache";

type LatestPlanRow = AgentPlanRow & { newest: number };

const LATEST_PLAN_DOCUMENT_SQL = `
  WITH newest AS (
    SELECT conversation_id, run_id, turn_id, explanation, steps_json FROM agent_plans
    WHERE conversation_id = ?
    ORDER BY updated_at DESC, run_id DESC LIMIT 1
  ), anchor AS (
    SELECT agent_turns.requested_at AS at, agent_turns.id AS id
    FROM agent_turns JOIN newest ON agent_turns.id = newest.turn_id
    WHERE agent_turns.conversation_id = ?
  ), gap AS (
    SELECT agent_turns.requested_at AS at, agent_turns.id AS id FROM agent_turns, anchor
    WHERE agent_turns.conversation_id = ?
      AND (agent_turns.requested_at, agent_turns.id) < (anchor.at, anchor.id)
      AND NOT EXISTS (SELECT 1 FROM agent_plans WHERE agent_plans.conversation_id = agent_turns.conversation_id
        AND agent_plans.turn_id = agent_turns.id)
    ORDER BY agent_turns.requested_at DESC, agent_turns.id DESC LIMIT 1
  ), documented AS (
    SELECT agent_plans.conversation_id, agent_plans.run_id, agent_plans.turn_id, agent_plans.explanation,
      agent_plans.steps_json
    FROM agent_plans JOIN agent_turns ON agent_turns.conversation_id = agent_plans.conversation_id
      AND agent_turns.id = agent_plans.turn_id, anchor
    WHERE agent_plans.conversation_id = ?
      AND trim(agent_plans.explanation, ' ' || char(9, 10, 13)) <> ''
      AND (agent_turns.requested_at, agent_turns.id) <= (anchor.at, anchor.id)
      AND NOT EXISTS (SELECT 1 FROM gap WHERE (gap.at, gap.id) >= (agent_turns.requested_at, agent_turns.id))
    ORDER BY agent_turns.requested_at DESC, agent_turns.id DESC LIMIT 1
  )
  SELECT *, 1 AS newest FROM newest
  UNION ALL
  SELECT *, 0 AS newest FROM documented
`;

function planKey(plan: Pick<AgentPlan, "runId" | "turnId">): string {
  return `${plan.runId}:${plan.turnId ?? "legacy"}`;
}

export function withLatestPlanDocument(
  database: Database.Database,
  conversationId: string,
  plans: AgentPlan[],
): AgentPlan[] {
  const rows = cachedStatement(database, LATEST_PLAN_DOCUMENT_SQL)
    .all(conversationId, conversationId, conversationId, conversationId) as LatestPlanRow[];
  const newest = rows.find((row) => row.newest === 1);
  const documented = rows.find((row) => row.newest === 0 && row.run_id !== newest?.run_id);
  const loaded = new Set(plans.map(planKey));
  const missing = (row: AgentPlanRow | undefined): AgentPlan[] =>
    row && !loaded.has(planKey({ runId: row.run_id, turnId: row.turn_id })) ? [planFromRow(row)] : [];
  const before = missing(documented);
  const after = missing(newest);
  return before.length || after.length ? [...before, ...plans, ...after] : plans;
}
