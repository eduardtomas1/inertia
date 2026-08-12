import type Database from "better-sqlite3";

/** Schema 57 requires the exact range index used by Usage aggregation. */
export function validUsageDashboardIndex(database: Database.Database): boolean {
  const index = (database.prepare(
    "PRAGMA index_list(agent_turns)",
  ).all() as Array<{
    name: string;
    partial: number;
    unique: number;
  }>).find(({ name }) => name === "agent_turns_usage_dashboard_completed_idx");
  if (!index || index.partial !== 0 || index.unique !== 0) return false;
  const columns = (database.prepare(
    "PRAGMA index_xinfo(agent_turns_usage_dashboard_completed_idx)",
  ).all() as Array<{
    coll: string;
    desc: number;
    key: number;
    name: string | null;
    seqno: number;
  }>)
    .filter(({ key }) => key === 1)
    .sort((left, right) => left.seqno - right.seqno)
    .map(({ coll, desc, name }) => `${name}:${coll}:${desc}`);
  return columns.join(",") === [
    "association:BINARY:0",
    "completed_at:BINARY:0",
    "id:BINARY:0",
  ].join(",");
}
