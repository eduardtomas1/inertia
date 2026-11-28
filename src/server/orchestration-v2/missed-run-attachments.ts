import type Database from "better-sqlite3";

import { chatAttachmentKind } from "../../shared/attachments";
import type { ChatAttachment } from "../../shared/contracts";
import { isAgentTurnTerminalStatus, type AgentTurnStatus } from "../../shared/turn-lifecycle";
import { parseStoredAttachments } from "../persistence/codecs";

/**
 * How many of the chat's newest turns the walk reads, each with one bounded attachment list (the window the backing
 * and delegation reads use). A prompt carries at most 32 images to a provider and drops the oldest first, so
 * a streak of refused starts longer than this loses only its oldest images, as the provider limit would.
 */
export const MISSED_RUN_WALK_LIMIT = 64;

const TERMINAL = "('completed','failed','cancelled','interrupted')";

/**
 * SQL: the turn aliased `turn`, of the run aliased `run`, was stopped by the user before its provider accepted it
 * (C1: Codex marks the run `not-delivered` with a recorded `run-interrupt` of `cause: 'user'`).
 */
const userStoppedBeforeAcceptance = (turn: string, run: string) => `(${turn}.status = 'cancelled'
  AND json_extract(${run}.payload_json, '$.delivery') = 'not-delivered'
  AND EXISTS (SELECT 1 FROM orchestration_v2_entities AS interrupt
    WHERE interrupt.kind = 'run-interrupt' AND interrupt.thread_id = ${turn}.conversation_id
      AND json_extract(interrupt.payload_json, '$.runId') = ${run}.id
      AND json_extract(interrupt.payload_json, '$.cause') = 'user'))`;

/**
 * SQL: the turn aliased `turn`, of the run aliased `run`, ended in a way a missed run can (T3 `missedRuns`,
 * `c5fa33b27`, and C1): failed or interrupted, cancelled after its provider dropped the prompt (`promptDropped`),
 * or a Codex run the user stopped before provider acceptance (`not-delivered` with a user `run-interrupt`).
 */
const missedStatus = (turn: string, run: string) => `(${turn}.status IN ('failed','interrupted')
  OR (${turn}.status = 'cancelled' AND COALESCE(json_extract(${run}.payload_json, '$.promptDropped'), 0) = 1)
  OR ${userStoppedBeforeAcceptance(turn, run)})`;

/** SQL: the turn aliased `turn` is rolled back. */
const rolledBack = (turn: string) => `EXISTS (SELECT 1 FROM orchestration_v2_entities AS rollback
  WHERE rollback.kind = 'rolled-back-turn' AND rollback.id = ${turn}.id)`;

/** SQL: the turn aliased `turn` withheld its prompt from the provider (a goal start). */
const promptWithheld = (turn: string) => `COALESCE((SELECT CASE WHEN json_valid(manifest.manifest_json)
  THEN json_extract(manifest.manifest_json, '$.promptWithheld') END
  FROM turn_execution_manifests AS manifest WHERE manifest.turn_id = ${turn}.id), 0) = 1`;

/** SQL: the run aliased `run` delivered no prompt: either `delivery` marker (T3 missed run). */
const missedRun = (run: string) => `COALESCE(json_extract(${run}.payload_json, '$.delivery'), '')
  IN ('not-delivered', 'prompt-not-delivered')`;

/**
 * SQL: the user message aliased `message` belongs to a missed run among its chat's newest `MISSED_RUN_WALK_LIMIT`
 * turns that no later prompted, delivered run on the same provider instance has superseded, so the next prompted
 * start may still carry its images. It keeps a rolled-back missed run's images: slightly more than the walk can
 * carry, never less. An image of an instance the chat no longer uses stays until that many newer turns exist.
 * Turns order by `requested_at`, ties by insertion (`rowid`).
 */
export function pendingMissedRunAttachmentSql(message: string): string {
  return `EXISTS (SELECT 1 FROM agent_turns AS missed_turn
    JOIN orchestration_v2_entities AS missed_run ON missed_run.kind = 'run' AND missed_run.id = missed_turn.run_id
    WHERE missed_turn.id = ${message}.turn_id AND missed_turn.user_message_id = ${message}.id
      AND ${missedStatus("missed_turn", "missed_run")}
      AND ${missedRun("missed_run")}
      AND (SELECT COUNT(*) FROM (SELECT 1 FROM agent_turns AS newer
        WHERE newer.conversation_id = missed_turn.conversation_id
          AND (newer.requested_at, newer.rowid) > (missed_turn.requested_at, missed_turn.rowid)
        LIMIT ${MISSED_RUN_WALK_LIMIT})) < ${MISSED_RUN_WALK_LIMIT}
      AND NOT EXISTS (SELECT 1 FROM agent_turns AS later
        JOIN orchestration_v2_entities AS later_run ON later_run.kind = 'run' AND later_run.id = later.run_id
        WHERE later.conversation_id = missed_turn.conversation_id
          AND (later.requested_at, later.rowid) > (missed_turn.requested_at, missed_turn.rowid)
          AND later.status IN ${TERMINAL}
          AND json_extract(later_run.payload_json, '$.providerInstanceId')
            = json_extract(missed_run.payload_json, '$.providerInstanceId')
          AND NOT ${missedRun("later_run")}
          AND NOT ${promptWithheld("later")} AND NOT ${rolledBack("later")}))`;
}

interface WalkRow {
  status: AgentTurnStatus;
  has_run: number;
  instance: string | null;
  delivery: string | null;
  prompt_dropped: number | null;
  user_stopped_unaccepted: number;
  rolled_back: number;
  withheld: number;
  attachments_json: string | null;
}

/**
 * The image attachments of this chat's runs on `providerInstanceId` whose prompt its provider never received
 * (`not-delivered`, or `prompt-not-delivered` when only injected history reached it), oldest run first, each
 * message's own order (T3 `prepareRetryHandoff` attachments). The walk goes newest first (ties by insertion) and
 * stops at the first delivered run whose prompt reached the provider. A cancelled run contributes only when its provider
 * dropped the prompt (`promptDropped`, T3 `c5fa33b27`), as a failed one does. A run on another instance, a goal start
 * (its prompt was withheld), a run still in flight and a run the user stopped before its provider accepted it neither
 * contribute nor stop it; a rolled-back run contributes nothing and
 * does not stop it either, since its rollback took back what it carried. A turn V2 never admitted (imported or
 * pre-V2 history) has no delivery record and is passed over too. Only images: documents became prompt text through
 * extraction that a retry cannot redo here.
 */
export function missedRunImageAttachments(database: Database.Database, input: {
  threadId: string;
  providerInstanceId: string;
}): ChatAttachment[] {
  const rows = database.prepare(`SELECT turn.status, run.payload_json IS NOT NULL AS has_run,
      json_extract(run.payload_json, '$.providerInstanceId') AS instance,
      json_extract(run.payload_json, '$.delivery') AS delivery,
      json_extract(run.payload_json, '$.promptDropped') AS prompt_dropped,
      ${userStoppedBeforeAcceptance("turn", "run")} AS user_stopped_unaccepted,
      ${rolledBack("turn")} AS rolled_back, ${promptWithheld("turn")} AS withheld,
      message.attachments_json
    FROM agent_turns AS turn
    LEFT JOIN orchestration_v2_entities AS run ON run.kind = 'run' AND run.id = turn.run_id
      AND run.thread_id = turn.conversation_id
    LEFT JOIN messages AS message ON message.id = turn.user_message_id
      AND message.conversation_id = turn.conversation_id
    WHERE turn.conversation_id = ?
    ORDER BY turn.requested_at DESC, turn.rowid DESC
    LIMIT ?`).all(input.threadId, MISSED_RUN_WALK_LIMIT) as WalkRow[];
  const newestFirst: ChatAttachment[][] = [];
  for (const row of rows) {
    if (row.has_run !== 1 || row.instance !== input.providerInstanceId || !isAgentTurnTerminalStatus(row.status)
      || row.rolled_back === 1) continue;
    if (row.delivery === "not-delivered" || row.delivery === "prompt-not-delivered") {
      if (row.status === "cancelled" && row.prompt_dropped !== 1 && row.user_stopped_unaccepted !== 1) continue;
      newestFirst.push(parseStoredAttachments(row.attachments_json ?? "[]")
        .filter(({ mimeType }) => chatAttachmentKind(mimeType) === "image"));
      continue;
    }
    if (row.withheld === 1) continue;
    break;
  }
  return newestFirst.reverse().flat();
}
