import type Database from "better-sqlite3";

/** Schema 66 requires the persisted interval boundary and exact range index. */
export function systemSuspendTimingSchemaIsValid(
  database: Database.Database,
): boolean {
  const executableSchemaSql = (value: unknown): string => (
    typeof value === "string"
      ? value
          .replace(/'(?:''|[^'])*'/gu, " ")
          .replace(/--[^\r\n]*/gu, " ")
          .replace(/\/\*[\s\S]*?\*\//gu, " ")
          .replace(/\s+/gu, " ")
          .trim()
          .toLowerCase()
      : ""
  );
  const turnColumns = database.prepare("PRAGMA table_info(agent_turns)").all() as Array<{
    dflt_value: string | null;
    name: string;
    notnull: number;
    type: string;
  }>;
  const suspendedDuration = turnColumns.find(
    ({ name }) => name === "suspended_duration_ms",
  );
  const agentTurnDefinition = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'agent_turns'
  `).get() as { sql: unknown } | undefined;
  const normalizedAgentTurnDefinition = executableSchemaSql(
    agentTurnDefinition?.sql,
  );
  const intervalColumns = database.prepare(
    "PRAGMA table_info(system_suspend_intervals)",
  ).all() as Array<{
    dflt_value: string | null;
    name: string;
    notnull: number;
    pk: number;
    type: string;
  }>;
  const expectedIntervalColumns = [
    ["sequence", "INTEGER", 0, 1],
    ["id", "TEXT", 1, 0],
    ["suspended_at", "TEXT", 1, 0],
    ["resumed_at", "TEXT", 1, 0],
  ] as const;
  if (
    !suspendedDuration
    || suspendedDuration.type.trim().toUpperCase() !== "INTEGER"
    || suspendedDuration.notnull !== 1
    || suspendedDuration.dflt_value?.trim() !== "0"
    || !/check\s*\(\s*suspended_duration_ms\s*>=\s*0\s+and\s+suspended_duration_ms\s*<=\s*9007199254740991\s*\)/u
      .test(normalizedAgentTurnDefinition)
    || intervalColumns.length !== expectedIntervalColumns.length
    || expectedIntervalColumns.some(([name, type, notnull, pk], ordinal) => {
      const column = intervalColumns[ordinal];
      return column?.name !== name
        || column.type.trim().toUpperCase() !== type
        || column.notnull !== notnull
        || column.pk !== pk
        || column.dflt_value !== null;
    })
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
  const tableDefinition = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'system_suspend_intervals'
  `).get() as { sql: unknown } | undefined;
  const normalizedDefinition = executableSchemaSql(tableDefinition?.sql);
  if ([
    "check (length(id) = 36)",
    "check (length(suspended_at) between 20 and 40)",
    "check (length(resumed_at) between 20 and 40)",
    "check (resumed_at >= suspended_at)",
  ].some((check) => !normalizedDefinition.includes(check))) return false;
  const indexes = database.prepare(
    "PRAGMA index_list(system_suspend_intervals)",
  ).all() as Array<{
    name: string;
    origin: string;
    partial: number;
    unique: number;
  }>;
  const identifierIndex = indexes.find(
    ({ origin, unique }) => origin === "u" && unique === 1,
  );
  const identifierIndexColumns = identifierIndex
    ? (database.prepare(`PRAGMA index_info(${JSON.stringify(identifierIndex.name)})`)
      .all() as Array<{ name: string }>).map(({ name }) => name)
    : [];
  if (identifierIndexColumns.join(",") !== "id") return false;
  const invalidInterval = database.prepare(`
    SELECT 1
    FROM system_suspend_intervals
    WHERE typeof(sequence) != 'integer'
      OR sequence <= 0
      OR typeof(id) != 'text'
      OR length(id) != 36
      OR substr(id, 9, 1) != '-'
      OR substr(id, 14, 1) != '-'
      OR substr(id, 19, 1) != '-'
      OR substr(id, 24, 1) != '-'
      OR replace(id, '-', '') GLOB '*[^0-9a-fA-F]*'
      OR substr(id, 15, 1) NOT GLOB '[1-8]'
      OR substr(id, 20, 1) NOT GLOB '[89aAbB]'
      OR typeof(suspended_at) != 'text'
      OR typeof(resumed_at) != 'text'
      OR strftime('%Y-%m-%dT%H:%M:%fZ', suspended_at) != suspended_at
      OR strftime('%Y-%m-%dT%H:%M:%fZ', resumed_at) != resumed_at
      OR resumed_at < suspended_at
    LIMIT 1
  `).get();
  if (invalidInterval) return false;
  const overlappingInterval = database.prepare(`
    SELECT 1
    FROM system_suspend_intervals AS current
    WHERE current.suspended_at < COALESCE((
      SELECT previous.resumed_at
      FROM system_suspend_intervals AS previous
      WHERE previous.sequence < current.sequence
      ORDER BY previous.sequence DESC
      LIMIT 1
    ), current.suspended_at)
    LIMIT 1
  `).get();
  if (overlappingInterval) return false;
  const index = indexes.find(
    ({ name }) => name === "system_suspend_intervals_range_idx",
  );
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
