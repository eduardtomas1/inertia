import type Database from "better-sqlite3";

/** Schema 65 requires the persisted interval boundary and exact range index. */
export function systemSuspendTimingSchemaIsValid(
  database: Database.Database,
): boolean {
  const turnColumns = database.prepare("PRAGMA table_info(agent_turns)").all() as Array<{
    dflt_value: string | null;
    name: string;
    notnull: number;
    type: string;
  }>;
  const suspendedDuration = turnColumns.find(
    ({ name }) => name === "suspended_duration_ms",
  );
  const intervalColumns = database.prepare(
    "PRAGMA table_info(system_suspend_intervals)",
  ).all() as Array<{
    name: string;
    pk: number;
    type: string;
  }>;
  const sequence = intervalColumns.find(({ name }) => name === "sequence");
  const intervalColumnNames = new Set(intervalColumns.map(({ name }) => name));
  if (
    !suspendedDuration
    || suspendedDuration.type.trim().toUpperCase() !== "INTEGER"
    || suspendedDuration.notnull !== 1
    || suspendedDuration.dflt_value?.trim() !== "0"
    || !sequence
    || sequence.type.trim().toUpperCase() !== "INTEGER"
    || sequence.pk !== 1
    || ["id", "suspended_at", "resumed_at"].some(
      (column) => !intervalColumnNames.has(column),
    )
  ) return false;
  const invalidDuration = database.prepare(`
    SELECT 1
    FROM agent_turns
    WHERE typeof(suspended_duration_ms) != 'integer'
      OR suspended_duration_ms < 0
      OR suspended_duration_ms > 9007199254740991
    LIMIT 1
  `).get();
  if (invalidDuration) return false;
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
