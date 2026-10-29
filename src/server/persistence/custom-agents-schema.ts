import type Database from "better-sqlite3";

export const CUSTOM_AGENTS_COUNT_LIMIT_TRIGGER_FRAGMENTS = [
  "before insert on custom_agents",
  "(select count(*) from custom_agents) >= 40",
  "raise(abort,",
] as const;

export function customAgentsSchemaIsValid(database: Database.Database): boolean {
  const trigger = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'custom_agents_count_limit'
  `).get() as { sql: unknown } | undefined;
  const normalized = typeof trigger?.sql === "string"
    ? trigger.sql.replace(/\s+/gu, " ").toLowerCase()
    : "";
  if (!CUSTOM_AGENTS_COUNT_LIMIT_TRIGGER_FRAGMENTS.every((fragment) => normalized.includes(fragment))) {
    return false;
  }
  const indexes = database.prepare("PRAGMA index_list(custom_agents)").all() as Array<{
    name: string;
    unique: number;
  }>;
  return indexes.some(({ name, unique }) => unique === 1 && (
    database.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>
  ).map((column) => column.name).join(",") === "handle");
}
