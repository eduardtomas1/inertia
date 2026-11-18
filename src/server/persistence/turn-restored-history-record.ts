import type Database from "better-sqlite3";

/**
 * Nothing reached the provider, so no history was restored: drop a turn's
 * restored-history record. A withheld count stays, with nothing restored,
 * because it records an endpoint crossing (`historyStayedOnEndpoint`), not a
 * delivery; a rejected-resume marker stays for the two-strike rule
 * (`savedSessionKeepsFailing`). The route-handoff marker
 * (`latestProviderHandoffOnRoute`) needs no protection: it skips runs settled
 * as not delivered itself.
 */
export function dropRestoredHistoryRecord(database: Database.Database, turnId: string): void {
  database.prepare(`UPDATE agent_turns SET session_recovery_json = CASE
      WHEN NOT json_valid(session_recovery_json) THEN NULL
      WHEN json_extract(session_recovery_json, '$.withheldMessageCount') IS NOT NULL
        THEN json_set(session_recovery_json, '$.restoredMessageCount', 0, '$.omittedMessageCount', 0)
      WHEN json_extract(session_recovery_json, '$.resumeRejected') IS NOT NULL THEN '{"resumeRejected":true}'
      ELSE NULL END
    WHERE id = ? AND session_recovery_json IS NOT NULL`).run(turnId);
}
