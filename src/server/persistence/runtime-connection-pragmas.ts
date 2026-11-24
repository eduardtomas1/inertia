import type Database from "better-sqlite3";

export const RUNTIME_MMAP_SIZE_BYTES = 268435456;

export function applyRuntimeConnectionPragmas(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("cache_size = -16000");
  database.pragma(`mmap_size = ${RUNTIME_MMAP_SIZE_BYTES}`);
  database.pragma("temp_store = MEMORY");
}

export function optimizeRuntimeConnection(database: Database.Database): void {
  if (!database.open || database.readonly || database.inTransaction) return;
  if (database.pragma("query_only", { simple: true }) !== 0) return;
  try {
    const shadows = shadowTableNames(database);
    const shadowSet = new Set(shadows);
    database.pragma("analysis_limit = 1000");
    const planned = database.pragma("optimize = 0x10003") as Array<{ optimize?: string }>;
    for (const row of planned) {
      if (typeof row.optimize !== "string") continue;
      const table = analyzedMainTableName(row.optimize);
      if (table !== null && shadowSet.has(table)) continue;
      database.exec(row.optimize);
    }
    forgetShadowTableStatistics(database, shadows);
  } catch {
    return;
  }
}

function shadowTableNames(database: Database.Database): string[] {
  return (database.pragma("table_list") as Array<{ schema: string; name: string; type: string }>)
    .filter(({ schema, type }) => schema === "main" && type === "shadow")
    .map(({ name }) => name);
}

function analyzedMainTableName(sql: string): string | null {
  const match = /^ANALYZE "main"\."((?:""|[^"])+)"$/.exec(sql.trim());
  return match ? match[1]!.replaceAll('""', '"') : null;
}

function forgetShadowTableStatistics(database: Database.Database, shadows: readonly string[]): void {
  if (shadows.length === 0 || !database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'").get()) return;
  const removed = database.prepare(`DELETE FROM sqlite_stat1 WHERE tbl IN (${shadows.map(() => "?").join(", ")})`).run(...shadows).changes;
  if (removed > 0) database.exec("ANALYZE sqlite_schema");
}

export function openRuntimeConnection(
  database: Database.Database,
  migrate: (database: Database.Database) => void,
): void {
  if (database.pragma("page_count", { simple: true }) === 0) {
    database.pragma("auto_vacuum = INCREMENTAL");
  }
  applyRuntimeConnectionPragmas(database);
  migrate(database);
  optimizeRuntimeConnection(database);
}
