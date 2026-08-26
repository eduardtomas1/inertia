import type Database from "better-sqlite3";

/** Schema 65 requires the persisted interval boundary and exact range index. */
export function systemSuspendTimingSchemaIsValid(
  database: Database.Database,
): boolean {
  const turnColumns = new Set(
    (database.prepare("PRAGMA table_info(agent_turns)").all() as Array<{
      name: string;
    }>).map(({ name }) => name),
  );
  const intervalColumns = new Set(
    (database.prepare("PRAGMA table_info(system_suspend_intervals)").all() as Array<{
      name: string;
    }>).map(({ name }) => name),
  );
  if (
    !turnColumns.has("suspended_duration_ms")
    || ["id", "suspended_at", "resumed_at"].some(
      (column) => !intervalColumns.has(column),
    )
  ) return false;
  const index = (database.prepare(
    "PRAGMA index_list(system_suspend_intervals)",
  ).all() as Array<{
    name: string;
    partial: number;
    unique: number;
  }>).find(({ name }) => name === "system_suspend_intervals_range_idx");
  if (!index || index.partial !== 0 || index.unique !== 0) return false;
  const columns = (database.prepare(
    "PRAGMA index_xinfo(system_suspend_intervals_range_idx)",
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
    "suspended_at:BINARY:0",
    "resumed_at:BINARY:0",
  ].join(",");
}
