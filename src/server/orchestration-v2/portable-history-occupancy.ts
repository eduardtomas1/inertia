import type Database from "better-sqlite3";

import type { InheritedCoverage } from "../../shared/orchestration-backings";
import { MAX_PORTABLE_COMMAND_INPUT_BYTES, MAX_PORTABLE_COMMAND_OUTPUT_BYTES } from "../persistence/turn-context-facts";

export interface OccupancyCoverageInput {
  readonly coveredItemIds?: readonly string[];
  readonly coveredThroughOrdinal?: number;
  readonly uncoveredItemIds?: readonly string[];
  readonly inheritedCoverage?: InheritedCoverage;
  readonly legacyCovered?: boolean;
}

const IMAGE_ALLOWANCE = 8_192;
const ATTACHMENT_ALLOWANCE = 4_096;
const ACTIVITY_ITEM_BYTES = MAX_PORTABLE_COMMAND_INPUT_BYTES + MAX_PORTABLE_COMMAND_OUTPUT_BYTES + 256;

/** Stored history is mostly prose and tool output, about four UTF-8 bytes per token (T3 `estimateTextTokens`). */
const tokens = (bytes: string) => `((${bytes}) + 3) / 4`;

function hasAnyCoverage(coverage: OccupancyCoverageInput): boolean {
  return (coverage.coveredItemIds?.length ?? 0) > 0
    || (coverage.coveredThroughOrdinal !== undefined && coverage.coveredThroughOrdinal > 0)
    || coverage.legacyCovered === true
    || coverage.inheritedCoverage !== undefined;
}

function turnCoveredPredicate(
  turnIdExpr: string,
  threadIdExpr: string,
  itemIdExpr: string,
  coverage: {
    coveredJson: string;
    uncoveredJson: string;
    coveredThroughOrdinal: number | undefined;
    legacyCovered: boolean;
  },
  includeTurnless = false,
): { sql: string; parameters: (string | number)[] } {
  const arms: string[] = [`${itemIdExpr} IN (SELECT value FROM json_each(?))`];
  const parameters: (string | number)[] = [coverage.uncoveredJson, coverage.coveredJson];
  if (coverage.coveredThroughOrdinal !== undefined && coverage.coveredThroughOrdinal > 0) {
    arms.push(`(${turnIdExpr} IS NOT NULL AND ${turnIdExpr} NOT IN (SELECT id FROM orchestration_v2_entities
        WHERE kind = 'rolled-back-turn' AND thread_id = ${threadIdExpr})
      AND EXISTS (SELECT 1 FROM agent_turns AS cov_turn
        JOIN orchestration_v2_entities AS cov_run ON cov_run.kind = 'run' AND cov_run.id = cov_turn.run_id
          AND cov_run.thread_id = ${threadIdExpr}
        WHERE cov_turn.id = ${turnIdExpr} AND cov_turn.conversation_id = ${threadIdExpr}
          AND json_extract(cov_run.payload_json, '$.ordinal') <= ?))`);
    parameters.push(coverage.coveredThroughOrdinal);
  }
  if (coverage.legacyCovered) {
    const nonV2Turn = `(${turnIdExpr} IS NOT NULL AND ${turnIdExpr} NOT IN (SELECT id FROM orchestration_v2_entities
        WHERE kind = 'rolled-back-turn' AND thread_id = ${threadIdExpr})
      AND NOT EXISTS (SELECT 1 FROM agent_turns AS leg_turn
        JOIN orchestration_v2_entities AS leg_run ON leg_run.kind = 'run' AND leg_run.id = leg_turn.run_id
          AND leg_run.thread_id = ${threadIdExpr}
        WHERE leg_turn.id = ${turnIdExpr} AND leg_turn.conversation_id = ${threadIdExpr}
          AND json_extract(leg_run.payload_json, '$.ordinal') IS NOT NULL))`;
    arms.push(includeTurnless ? `(${turnIdExpr} IS NULL OR ${nonV2Turn})` : nonV2Turn);
  }
  return {
    sql: `${itemIdExpr} NOT IN (SELECT value FROM json_each(?)) AND (${arms.join(" OR ")})`,
    parameters,
  };
}

/**
 * Estimated tokens of covered transcript, activity and inherited items: each
 * item's UTF-8 bytes / 4, rounded up per item, plus whole attachment
 * allowances for user messages. The new prompt and restored history are
 * still budgeted at one byte per token.
 */
export function coveredHistoryOccupancy(
  database: Database.Database,
  threadId: string,
  coveredOrCoverage: readonly string[] | OccupancyCoverageInput,
): number {
  const input: OccupancyCoverageInput = Array.isArray(coveredOrCoverage)
    ? { coveredItemIds: coveredOrCoverage }
    : (coveredOrCoverage as OccupancyCoverageInput);
  if (!hasAnyCoverage(input)) return 0;
  const coveredJson = JSON.stringify(input.coveredItemIds ?? []);
  const uncoveredJson = JSON.stringify(input.uncoveredItemIds ?? []);
  const norm = {
    coveredJson,
    uncoveredJson,
    coveredThroughOrdinal: input.coveredThroughOrdinal,
    legacyCovered: input.legacyCovered === true,
  };

  const msgPred = turnCoveredPredicate("messages.turn_id", "messages.conversation_id", "messages.id", norm, true);
  const messages = database.prepare(`SELECT COALESCE(SUM(${tokens(`length(CAST(messages.content AS BLOB))
      + COALESCE((SELECT SUM(length(CAST(chunks.content AS BLOB))) FROM message_content_chunks chunks
        WHERE chunks.message_id = messages.id), 0)`)}
      + CASE WHEN messages.role = 'user' THEN COALESCE((SELECT SUM(CASE
          WHEN json_extract(attachment.value, '$.mimeType') LIKE 'image/%' THEN ${IMAGE_ALLOWANCE}
          ELSE ${ATTACHMENT_ALLOWANCE} END)
        FROM json_each(CASE WHEN json_valid(messages.attachments_json) THEN messages.attachments_json ELSE '[]' END) attachment), 0)
      ELSE 0 END), 0) AS tokens
    FROM messages WHERE messages.conversation_id = ? AND messages.role IN ('user','assistant') AND ${msgPred.sql}`)
    .get(threadId, ...msgPred.parameters) as { tokens: number };

  const inheritedArms: string[] = ["first.id IN (SELECT value FROM json_each(?))"];
  const inheritedArgs: (string | number)[] = [threadId, threadId, uncoveredJson, coveredJson];
  if (input.inheritedCoverage === "complete") {
    inheritedArms.push("1 = 1");
  } else if (input.inheritedCoverage !== undefined && input.inheritedCoverage.forkId === threadId) {
    inheritedArms.push("json_extract(first.payload_json, '$.ordinal') <= ?");
    inheritedArgs.push(input.inheritedCoverage.throughOrdinal);
  }
  const inherited = database.prepare(`SELECT COALESCE(SUM(${tokens("bytes")}), 0) AS tokens FROM (
      SELECT SUM(length(CAST(json_extract(part.payload_json, '$.text') AS BLOB))) AS bytes
      FROM orchestration_v2_entities part
      WHERE part.kind = 'fork-history' AND part.thread_id = ?
        AND json_extract(part.payload_json, '$.ordinal') IN (
          SELECT json_extract(first.payload_json, '$.ordinal') FROM orchestration_v2_entities first
          WHERE first.kind = 'fork-history' AND first.thread_id = ? AND json_extract(first.payload_json, '$.part') = 0
            AND first.id NOT IN (SELECT value FROM json_each(?))
            AND (${inheritedArms.join(" OR ")}))
      GROUP BY json_extract(part.payload_json, '$.ordinal'))`)
    .get(...inheritedArgs) as { tokens: number };

  const actPred = turnCoveredPredicate("activities.turn_id", "activities.conversation_id", "('activity:' || activities.id)", norm);
  const activity = database.prepare(`SELECT COALESCE(SUM(${tokens(`min(length(CAST(title AS BLOB))
      + COALESCE(length(CAST(detail AS BLOB)), 0), ${ACTIVITY_ITEM_BYTES})`)}), 0) AS tokens
    FROM activities WHERE conversation_id = ? AND ${actPred.sql}`)
    .get(threadId, ...actPred.parameters) as { tokens: number };

  const planPred = turnCoveredPredicate("agent_plans.turn_id", "agent_plans.conversation_id", "('plan:' || agent_plans.run_id)", norm);
  const plans = database.prepare(`SELECT COALESCE(SUM(${tokens(`length(CAST(COALESCE(explanation, '') AS BLOB))
      + length(CAST(steps_json AS BLOB))`)}), 0) AS tokens
    FROM agent_plans WHERE conversation_id = ? AND ${planPred.sql}`)
    .get(threadId, ...planPred.parameters) as { tokens: number };

  const filesPred = turnCoveredPredicate("turn_git_artifacts.turn_id", "turn_git_artifacts.conversation_id", "('files:' || turn_git_artifacts.id)", norm);
  const files = database.prepare(`SELECT COALESCE(SUM(${tokens("length(CAST(files_json AS BLOB))")}), 0) AS tokens
    FROM turn_git_artifacts WHERE conversation_id = ? AND ${filesPred.sql}`)
    .get(threadId, ...filesPred.parameters) as { tokens: number };

  return messages.tokens + inherited.tokens + activity.tokens + plans.tokens + files.tokens;
}
