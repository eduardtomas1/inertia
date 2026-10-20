import type Database from "better-sqlite3";

/**
 * Serialized into the off-thread backup validator, so it must stay
 * self-contained and use only the prepare/get surface shared with node:sqlite.
 * Schema 100 rebuilt `turn_execution_context_refs` so its kind CHECK accepts
 * `initiative`; a database that claims that version but still has the older
 * table would refuse every turn that shares initiative context, so it is
 * inconsistent. Required by version, never by probing.
 */
export function executionContextKindsAreValid(
  database: Database.Database,
  version: number,
): boolean {
  if (version < 100) return true;
  const table = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'turn_execution_context_refs'
  `).get() as { sql: unknown } | undefined;
  if (typeof table?.sql !== "string") return false;
  const normalized = table.sql.replace(/\s+/gu, " ").toLowerCase();
  const kinds = /kind text not null check \( ?kind in \(([^)]*)\) ?\)/u.exec(normalized)?.[1] ?? "";
  return kinds.split(",").map((kind) => kind.trim()).includes("'initiative'");
}
