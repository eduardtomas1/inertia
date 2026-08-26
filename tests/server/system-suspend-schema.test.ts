import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { systemSuspendTimingSchemaIsValid } from "../../src/server/persistence/system-suspend-schema";

const databases: Database.Database[] = [];

function databaseWithSuspendedDuration(
  definition = "INTEGER NOT NULL DEFAULT 0",
): Database.Database {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE agent_turns (
      id TEXT PRIMARY KEY,
      suspended_duration_ms ${definition}
    );
    CREATE TABLE system_suspend_intervals (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      suspended_at TEXT NOT NULL,
      resumed_at TEXT NOT NULL
    );
    CREATE INDEX system_suspend_intervals_range_idx
    ON system_suspend_intervals(suspended_at ASC, resumed_at ASC);
  `);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("system suspend timing recovery schema", () => {
  it("accepts the current suspended-duration contract", () => {
    const database = databaseWithSuspendedDuration();
    database.prepare(`
      INSERT INTO agent_turns (id, suspended_duration_ms)
      VALUES (?, ?)
    `).run("turn", 15_000);

    expect(systemSuspendTimingSchemaIsValid(database)).toBe(true);
  });

  it.each([
    ["nullable", "INTEGER DEFAULT 0"],
    ["missing its default", "INTEGER NOT NULL"],
    ["using a text affinity", "TEXT NOT NULL DEFAULT 0"],
    ["using a nonzero default", "INTEGER NOT NULL DEFAULT 1"],
  ])("rejects a suspended-duration column that is %s", (_label, definition) => {
    expect(systemSuspendTimingSchemaIsValid(
      databaseWithSuspendedDuration(definition),
    )).toBe(false);
  });

  it.each([
    ["negative", -1],
    ["unsafe", 9_007_199_254_740_992],
    ["text", "fifteen seconds"],
  ])("rejects an existing %s suspended duration", (_label, value) => {
    const database = databaseWithSuspendedDuration();
    database.prepare(`
      INSERT INTO agent_turns (id, suspended_duration_ms)
      VALUES (?, ?)
    `).run("turn", value);

    expect(systemSuspendTimingSchemaIsValid(database)).toBe(false);
  });
});
