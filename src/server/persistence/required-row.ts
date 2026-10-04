import type Database from "better-sqlite3";

import { RecordNotFoundError } from "./errors";
import { cachedStatement } from "./statement-cache";

export function requireRow<Row>(
  database: Database.Database,
  table: "projects" | "conversations" | "agent_turns",
  id: string,
  missing: string,
): Row {
  const row = cachedStatement(database, `SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  if (!row) throw new RecordNotFoundError(missing);
  return row;
}
