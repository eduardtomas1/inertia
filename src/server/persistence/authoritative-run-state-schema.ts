import type Database from "better-sqlite3";

export function authoritativeRunStateSchemaIsValid(
  database: Database.Database,
): boolean {
  const columns = new Set((database.prepare(
    "PRAGMA table_info(agent_turns)",
  ).all() as Array<{ name: string }>).map(({ name }) => name));
  if (["run_state", "provider_state", "run_state_revision"].some(
    (column) => !columns.has(column),
  )) return false;
  const index = (database.prepare("PRAGMA index_list(agent_turns)").all() as Array<{
    name: string;
    partial: number;
    unique: number;
  }>).find(({ name }) => name === "agent_turns_run_state_requested_idx");
  if (!index || index.partial !== 0 || index.unique !== 0) return false;
  const indexColumns = (database.prepare(
    "PRAGMA index_xinfo(agent_turns_run_state_requested_idx)",
  ).all() as Array<{
    coll: string;
    desc: number;
    key: number;
    name: string | null;
    seqno: number;
  }>).filter(({ key }) => key === 1)
    .sort((left, right) => left.seqno - right.seqno)
    .map(({ coll, desc, name }) => `${name}:${coll}:${desc}`);
  if (indexColumns.join(",") !== [
    "run_state:BINARY:0",
    "requested_at:BINARY:0",
    "id:BINARY:0",
  ].join(",")) return false;
  return !database.prepare(`
    SELECT 1 FROM agent_turns
    WHERE status != CASE
      WHEN run_state IN ('delegated', 'retrying', 'cancelling') THEN 'running'
      ELSE run_state
    END
      OR provider_state != trim(provider_state)
    LIMIT 1
  `).get();
}
