import type Database from "better-sqlite3";

import { quotedSqlIdentifier } from "./sql-identifiers";

const TURN_ASSOCIATION_TABLES = [
  "messages",
  "activities",
  "agent_reasonings",
  "agent_plans",
  "thread_usage",
  "checkpoints",
] as const;
const TURN_ASSOCIATION_COLUMNS = ["turn_id"] as const;

export function ensureTurnAssociationColumns(
  database: Database.Database,
): void {
  for (const table of TURN_ASSOCIATION_TABLES) {
    const tableSql = quotedSqlIdentifier(table, TURN_ASSOCIATION_TABLES);
    const columnSql = quotedSqlIdentifier(
      "turn_id",
      TURN_ASSOCIATION_COLUMNS,
    );
    const columns = database
      .prepare(`PRAGMA table_info(${tableSql})`)
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "turn_id")) continue;
    database.exec(
      `ALTER TABLE ${tableSql} ADD COLUMN ${columnSql} TEXT REFERENCES agent_turns(id) ON DELETE SET NULL`,
    );
  }
}
