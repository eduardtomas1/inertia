import type Database from "better-sqlite3";

export function todosCountLimitTriggerIsValid(
  database: Database.Database,
): boolean {
  const trigger = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'todos_count_limit'
  `).get() as { sql: unknown } | undefined;
  const normalized = typeof trigger?.sql === "string"
    ? trigger.sql.replace(/\s+/gu, " ").toLowerCase()
    : "";
  return normalized.includes("before insert on todos")
    && normalized.includes("count(*) from todos")
    && /raise\s*\(\s*abort/u.test(normalized);
}
