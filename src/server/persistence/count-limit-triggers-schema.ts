import type Database from "better-sqlite3";

/**
 * Serialized into the off-thread backup validator, so it must stay
 * self-contained and use only the prepare/get surface shared with node:sqlite.
 * Tasks (schema 96) always need their trigger; initiatives need theirs from
 * schema 99 and initiative notes from schema 100, the versions that create
 * those tables.
 */
export function countLimitTriggersAreValid(
  database: Database.Database,
  version: number,
): boolean {
  const triggerIsValid = (name: string, table: string, scoped = false): boolean => {
    const trigger = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = ?
    `).get(name) as { sql: unknown } | undefined;
    const normalized = typeof trigger?.sql === "string"
      ? trigger.sql.replace(/\s+/gu, " ").toLowerCase()
      : "";
    return normalized.includes(`before insert on ${table}`)
      && normalized.includes(`count(*) from ${table}`)
      && (!scoped || normalized.includes("initiative_id = new.initiative_id"))
      && /raise\s*\(\s*abort/u.test(normalized);
  };
  return triggerIsValid("todos_count_limit", "todos")
    && (version < 99 || triggerIsValid("initiatives_count_limit", "initiatives"))
    && (version < 100 || triggerIsValid("initiative_notes_count_limit", "initiative_notes", true));
}
