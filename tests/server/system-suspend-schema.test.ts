import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { systemSuspendTimingSchemaIsValid } from "../../src/server/persistence/system-suspend-schema";

const databases: Database.Database[] = [];

function databaseWithSuspendedDuration(
  definition = `INTEGER NOT NULL DEFAULT 0 CHECK (
    suspended_duration_ms >= 0
    AND suspended_duration_ms <= 9007199254740991
  )`,
  intervalColumns = `
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
    suspended_at TEXT NOT NULL CHECK (length(suspended_at) BETWEEN 20 AND 40),
    resumed_at TEXT NOT NULL CHECK (length(resumed_at) BETWEEN 20 AND 40),
    CHECK (resumed_at >= suspended_at)
  `,
): Database.Database {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE agent_turns (
      id TEXT PRIMARY KEY,
      suspended_duration_ms ${definition}
    );
    CREATE TABLE system_suspend_intervals (
      ${intervalColumns}
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
    database.prepare(`
      INSERT INTO system_suspend_intervals (id, suspended_at, resumed_at)
      VALUES (?, ?, ?)
    `).run(
      "11111111-1111-4111-8111-111111111111",
      "2026-08-26T08:00:00.000Z",
      "2026-08-26T08:05:00.000Z",
    );

    expect(systemSuspendTimingSchemaIsValid(database)).toBe(true);
  });

  it.each([
    ["nullable", "INTEGER DEFAULT 0"],
    ["missing its default", "INTEGER NOT NULL"],
    ["using a text affinity", "TEXT NOT NULL DEFAULT 0"],
    ["using a nonzero default", "INTEGER NOT NULL DEFAULT 1"],
    ["missing its range check", "INTEGER NOT NULL DEFAULT 0"],
    ["spoofing its range check in a comment", `INTEGER NOT NULL DEFAULT 0
      /* CHECK (suspended_duration_ms >= 0 AND
        suspended_duration_ms <= 9007199254740991) */`],
    ["spoofing its range check in a string literal", `INTEGER NOT NULL DEFAULT 0,
      note TEXT DEFAULT 'CHECK (suspended_duration_ms >= 0 AND
        suspended_duration_ms <= 9007199254740991)'`],
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
    database.pragma("ignore_check_constraints = ON");
    database.prepare(`
      INSERT INTO agent_turns (id, suspended_duration_ms)
      VALUES (?, ?)
    `).run("turn", value);
    database.pragma("ignore_check_constraints = OFF");

    expect(systemSuspendTimingSchemaIsValid(database)).toBe(false);
  });

  it.each([
    ["a non-integer sequence", `
      sequence TEXT PRIMARY KEY,
      id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
      suspended_at TEXT NOT NULL CHECK (length(suspended_at) BETWEEN 20 AND 40),
      resumed_at TEXT NOT NULL CHECK (length(resumed_at) BETWEEN 20 AND 40),
      CHECK (resumed_at >= suspended_at)
    `],
    ["a nullable identifier", `
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE CHECK (length(id) = 36),
      suspended_at TEXT NOT NULL CHECK (length(suspended_at) BETWEEN 20 AND 40),
      resumed_at TEXT NOT NULL CHECK (length(resumed_at) BETWEEN 20 AND 40),
      CHECK (resumed_at >= suspended_at)
    `],
    ["a non-unique identifier", `
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL CHECK (length(id) = 36),
      suspended_at TEXT NOT NULL CHECK (length(suspended_at) BETWEEN 20 AND 40),
      resumed_at TEXT NOT NULL CHECK (length(resumed_at) BETWEEN 20 AND 40),
      CHECK (resumed_at >= suspended_at)
    `],
    ["a nullable resume timestamp", `
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
      suspended_at TEXT NOT NULL CHECK (length(suspended_at) BETWEEN 20 AND 40),
      resumed_at TEXT CHECK (length(resumed_at) BETWEEN 20 AND 40),
      CHECK (resumed_at >= suspended_at)
    `],
  ])("rejects an interval table with %s", (_label, intervalColumns) => {
    expect(systemSuspendTimingSchemaIsValid(
      databaseWithSuspendedDuration(undefined, intervalColumns),
    )).toBe(false);
  });

  it("rejects corrupted interval values and chronology", () => {
    const invalidIdentity = databaseWithSuspendedDuration();
    invalidIdentity.prepare(`
      INSERT INTO system_suspend_intervals (id, suspended_at, resumed_at)
      VALUES (?, ?, ?)
    `).run(
      "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx",
      "2026-08-26T08:00:00.000Z",
      "2026-08-26T08:05:00.000Z",
    );
    expect(systemSuspendTimingSchemaIsValid(invalidIdentity)).toBe(false);

    const overlap = databaseWithSuspendedDuration();
    overlap.prepare(`
      INSERT INTO system_suspend_intervals (id, suspended_at, resumed_at)
      VALUES (?, ?, ?)
    `).run(
      "11111111-1111-4111-8111-111111111111",
      "2026-08-26T08:00:00.000Z",
      "2026-08-26T08:10:00.000Z",
    );
    overlap.prepare(`
      INSERT INTO system_suspend_intervals (id, suspended_at, resumed_at)
      VALUES (?, ?, ?)
    `).run(
      "22222222-2222-4222-8222-222222222222",
      "2026-08-26T08:05:00.000Z",
      "2026-08-26T08:15:00.000Z",
    );
    expect(systemSuspendTimingSchemaIsValid(overlap)).toBe(false);
  });
});
