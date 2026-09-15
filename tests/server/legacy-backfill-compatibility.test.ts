import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { parse } from "@babel/parser";
import Database from "better-sqlite3";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  backfillLegacyAgentTurns,
  backfillLegacyAgentTurnsBounded,
  DatabaseMigrationError,
  formatMigrationDiagnostic,
  runDatabaseMigrations,
  type DatabaseMigration,
  type DatabaseMigrationDiagnostic,
  type LegacyBackfillDiagnostics,
} from "../../src/server/database-migrations";
import { boundedMathMax, boundedMathMin } from "../../src/server/persistence/migrations/bounded-math";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";

const RUNNER_PATH = "src/server/persistence/migrations/runner.ts";
const REDUCTIONS_PATH = "src/server/persistence/migrations/bounded-math.ts";
const LARGE_ACTIVITY_COUNT = 150_000;
const MIDWAY_ASSIGNMENT = 75_000;
const REPRODUCTION_TURN_ID = `legacy-turn-${createHash("sha256").update("u").digest("hex").slice(0, 32)}`;
const PINNED_HELPERS = [
  "buildResponseGroups",
  "chooseRunId",
  "groupByConversation",
  "hasTable",
  "isoTimestamp",
  "isWithinGroup",
  "normalizedConversation",
  "parseTimestamp",
  "publishedReleasesForSchema",
  "requireLegacyOwnershipSchema",
  "stableIdentifier",
  "tableColumns",
  "validRunId",
] as const;
const SUBSTITUTIONS = [
  ["backfillLegacyAgentTurns(", "backfillLegacyAgentTurnsBounded(", 2],
  ["Math.min(...eventTimes)", "boundedMathMin(eventTimes)", 1],
  ["Math.max(startedAtMillis, ...eventTimes)", "boundedMathMax([startedAtMillis], eventTimes)", 1],
] as const;
const DUMPED_TABLES = [
  ["agent_turns", "id"],
  ["messages", "id"],
  ["activities", "id"],
  ["agent_reasonings", "id"],
  ["checkpoints", "id"],
  ["agent_plans", "conversation_id"],
  ["thread_usage", "conversation_id"],
  ["workspace_runs", "id"],
] as const;
const REPRODUCTION_SQL = `
  INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
    VALUES ('p', 'Synthetic legacy project', '/synthetic', '#888888', 'ready', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
  INSERT INTO conversations (id, project_id, title, created_at, updated_at)
    VALUES ('c', 'p', 'Synthetic legacy conversation', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
  INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES ('u', 'c', 'user', 'Synthetic request', '2025-01-01T00:00:00.000Z');
  WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ${LARGE_ACTIVITY_COUNT})
  INSERT INTO activities (id, conversation_id, run_id, kind, title, status, created_at)
    SELECT 'a-' || n, 'c', 'legacy-run', 'status', 'Synthetic event', 'completed', '2025-01-01T00:00:01.000Z' FROM numbers;
`;

type Declaration = { text: string; node: unknown };
type Row = Record<string, unknown>;

let emptyImage: Buffer;
let largeImage: Buffer;
let workRoot: string;

function reopen(image: Buffer): Database.Database {
  const database = new Database(image);
  database.pragma("foreign_keys = ON");
  return database;
}

function schema17Image(seed: (database: Database.Database) => void = () => undefined): Buffer {
  const database = reopen(emptyImage);
  try {
    seed(database);
    return database.serialize();
  } finally {
    database.close();
  }
}

function functionDeclarations(source: string): Map<string, Declaration> {
  const program = parse(source, { sourceType: "module", plugins: ["typescript"] }).program;
  const declarations = new Map<string, Declaration>();
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "FunctionDeclaration" || !declaration.id) continue;
    if (declaration.start === null || declaration.end === null) continue;
    declarations.set(declaration.id.name, {
      text: source.slice(declaration.start, declaration.end),
      node: declaration,
    });
  }
  return declarations;
}

function significantTokens(text: string): string[] {
  const tokens = parse(text, { sourceType: "module", plugins: ["typescript"], tokens: true }).tokens ?? [];
  return tokens
    .filter((token: { type: unknown }) => typeof token.type !== "string")
    .map((token: { type: { label: string }; value?: unknown }) => `${token.type.label}\0${String(token.value ?? "")}`);
}

function spreadArgumentCalls(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((total: number, child) => total + spreadArgumentCalls(child), 0);
  if (!node || typeof node !== "object") return 0;
  const record = node as Record<string, unknown>;
  const isCall = record.type === "CallExpression"
    || record.type === "OptionalCallExpression"
    || record.type === "NewExpression";
  let total = isCall
    && Array.isArray(record.arguments)
    && record.arguments.some((argument) => (argument as { type?: string }).type === "SpreadElement")
    ? 1
    : 0;
  for (const [key, value] of Object.entries(record)) {
    if (key === "loc" || key.endsWith("Comments")) continue;
    total += spreadArgumentCalls(value);
  }
  return total;
}

function completeDump(database: Database.Database): Record<string, Row[]> {
  return Object.fromEntries(DUMPED_TABLES.map(([table, key]) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all() as Row[],
  ]));
}

function completeDigest(database: Database.Database): string {
  const hash = createHash("sha256");
  for (const [table, key] of DUMPED_TABLES) {
    for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate()) {
      hash.update(JSON.stringify([table, row]));
    }
  }
  return hash.digest("hex");
}

function releasedAndBounded(image: Buffer, sourceSchemaVersion = 17): {
  released: { diagnostics: LegacyBackfillDiagnostics; rows: Record<string, Row[]> };
  bounded: { diagnostics: LegacyBackfillDiagnostics; rows: Record<string, Row[]> };
} {
  const released = reopen(image);
  const bounded = reopen(image);
  try {
    return {
      released: {
        diagnostics: backfillLegacyAgentTurns(released, { sourceSchemaVersion }),
        rows: completeDump(released),
      },
      bounded: {
        diagnostics: backfillLegacyAgentTurnsBounded(bounded, { sourceSchemaVersion }),
        rows: completeDump(bounded),
      },
    };
  } finally {
    released.close();
    bounded.close();
  }
}

function count(database: Database.Database, sql: string, ...parameters: unknown[]): number {
  return (database.prepare(sql).get(...parameters) as { count: number }).count;
}

function schemaVersion(database: Database.Database): number {
  return count(database, "SELECT MAX(version) AS count FROM schema_migrations");
}

function expectUntouchedReproduction(database: Database.Database): void {
  expect(schemaVersion(database)).toBe(17);
  expect(count(database, "SELECT COUNT(*) AS count FROM activities")).toBe(LARGE_ACTIVITY_COUNT);
  expect(count(database, "SELECT COUNT(*) AS count FROM activities WHERE turn_id IS NOT NULL")).toBe(0);
  expect(count(database, "SELECT COUNT(*) AS count FROM agent_turns")).toBe(0);
  expect(database.pragma("foreign_key_check")).toEqual([]);
}

function expectUpgradedReproduction(database: Database.Database): void {
  expect(schemaVersion(database)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
  expect(database.prepare(`
    SELECT id, run_id, user_message_id, terminal_assistant_message_id, requested_at,
      started_at, completed_at, status, terminal_reason, association
    FROM agent_turns
  `).all()).toEqual([{
    id: REPRODUCTION_TURN_ID,
    run_id: "legacy-run",
    user_message_id: "u",
    terminal_assistant_message_id: null,
    requested_at: "2025-01-01T00:00:00.000Z",
    started_at: "2025-01-01T00:00:00.000Z",
    completed_at: "2025-01-01T00:00:01.000Z",
    status: "completed",
    terminal_reason: "legacy-backfill-completed",
    association: "inferred",
  }]);
  expect(count(database, "SELECT COUNT(*) AS count FROM activities WHERE turn_id = ?", REPRODUCTION_TURN_ID))
    .toBe(LARGE_ACTIVITY_COUNT);
  expect(count(database, "SELECT COUNT(*) AS count FROM messages WHERE turn_id = ?", REPRODUCTION_TURN_ID)).toBe(1);
  expect(database.pragma("foreign_key_check")).toEqual([]);
  expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walDatabase(name: string): string {
  const path = join(workRoot, name);
  writeFileSync(path, largeImage);
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.close();
  return path;
}

async function bundle(name: string, contents: string): Promise<string> {
  const outfile = join(workRoot, `${name}.mjs`);
  await build({
    stdin: { contents, resolveDir: process.cwd(), loader: "ts", sourcefile: `${name}.ts` },
    outfile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: "import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);" },
    logLevel: "silent",
  });
  return outfile;
}

function catalogWith(
  ...replacements: ReadonlyArray<DatabaseMigration>
): DatabaseMigration[] {
  const catalog = runtimeMigrationCatalog().slice(0, 17);
  return [...catalog, ...replacements];
}

function migrate(
  database: Database.Database,
  migrations: readonly DatabaseMigration[],
): { diagnostic: DatabaseMigrationDiagnostic | null; error: DatabaseMigrationError | null } {
  let diagnostic: DatabaseMigrationDiagnostic | null = null;
  try {
    runDatabaseMigrations(database, migrations, { onDiagnostic: (value) => { diagnostic = value; } });
    return { diagnostic, error: null };
  } catch (error) {
    if (!(error instanceof DatabaseMigrationError)) throw error;
    return { diagnostic, error };
  }
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedAmbiguousLegacyProfile(database: Database.Database, seed: number): void {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const between = (minimum: number, maximum: number): number => minimum + Math.floor(next() * (maximum - minimum + 1));
  const base = Date.UTC(2025, 1, 1);
  const timestamp = (second: number): string => {
    const roll = next();
    if (roll < 0.05) return "not-a-time";
    if (roll < 0.07) return "";
    if (roll < 0.2) return new Date(base + second * 1000).toISOString().replace(".000Z", "Z");
    return new Date(base + second * 1000).toISOString();
  };
  database.prepare(`
    INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
    VALUES ('p', 'Synthetic', '/synthetic', '#888888', 'ready', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
  `).run();
  const insertConversation = database.prepare(`
    INSERT INTO conversations (
      id, project_id, title, created_at, updated_at, provider_id, model,
      reasoning_effort, interaction_mode, access_mode
    ) VALUES (?, 'p', 'Synthetic', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', ?, ?, ?, ?, ?)
  `);
  const insertMessage = database.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, 'Synthetic', ?)",
  );
  const insertActivity = database.prepare(`
    INSERT INTO activities (id, conversation_id, run_id, kind, title, status, created_at)
    VALUES (?, ?, ?, 'status', 'Synthetic', ?, ?)
  `);
  const insertReasoning = database.prepare(`
    INSERT INTO agent_reasonings (id, conversation_id, run_id, content, status, created_at)
    VALUES (?, ?, ?, 'Synthetic', ?, ?)
  `);
  const insertPlan = database.prepare(
    "INSERT INTO agent_plans (conversation_id, run_id, steps_json, updated_at) VALUES (?, ?, '[]', ?)",
  );
  const insertUsage = database.prepare(
    "INSERT INTO thread_usage (conversation_id, used_tokens, updated_at) VALUES (?, 1, ?)",
  );
  const insertCheckpoint = database.prepare(`
    INSERT INTO checkpoints (id, conversation_id, ref, label, turn_index, created_at)
    VALUES (?, ?, 'ref', 'Synthetic', ?, ?)
  `);
  const insertWorkspaceRun = database.prepare(`
    INSERT INTO workspace_runs (id, kind, project_id, conversation_id, label, status, started_at, finished_at)
    VALUES (?, ?, 'p', ?, 'Synthetic', ?, ?, ?)
  `);
  const insertTurn = database.prepare(`
    INSERT INTO agent_turns (
      id, conversation_id, run_id, user_message_id, provider_id, harness_id, backend_profile_id,
      model, reasoning_effort, interaction_mode, access_mode, requested_at, started_at, completed_at,
      status, configuration_revision, association, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'codex', 'legacy-codex', 'legacy-codex', 'model', '', 'build', 'supervised',
      ?, ?, ?, 'completed', 0, ?, ?, ?)
  `);
  const conversations = between(1, 3);
  for (let conversation = 0; conversation < conversations; conversation += 1) {
    const conversationId = `c${conversation}`;
    insertConversation.run(
      conversationId,
      pick(["codex", "claude", "cursor", "opencode", "unknown-provider"]),
      pick(["", "model-a", "  spaced model  "]),
      pick(["", "high", "  low  "]),
      pick(["build", "plan", "unexpected"]),
      pick(["supervised", "auto-edit", "full", "unexpected"]),
    );
    const runs = [0, 1, 2, 3, 4].map((index) => `run-${seed}-${conversation}-${index}`);
    const runChoices = [...runs, ...runs, ` ${runs[0]} `, "", "x".repeat(201)];
    let second = between(0, 5);
    const users: string[] = [];
    const messageCount = between(2, 12);
    for (let index = 0; index < messageCount; index += 1) {
      second += pick([0, 0, 1, 3, 7, 15]);
      const role = index === 0 && next() < 0.3 ? "assistant" : pick(["user", "user", "assistant", "assistant", "system"]);
      const id = `${conversationId}-m${index}`;
      insertMessage.run(id, conversationId, role, timestamp(second));
      if (role === "user") users.push(id);
    }
    const span = second + 10;
    const activityCount = between(0, 40);
    for (let index = 0; index < activityCount; index += 1) {
      insertActivity.run(
        `${conversationId}-a${index}`,
        conversationId,
        pick(runChoices),
        pick(["running", "completed", "completed", "failed"]),
        timestamp(between(0, span)),
      );
    }
    const reasoningCount = between(0, 10);
    for (let index = 0; index < reasoningCount; index += 1) {
      insertReasoning.run(
        `${conversationId}-r${index}`,
        conversationId,
        pick(runChoices),
        pick(["running", "completed", "failed"]),
        timestamp(between(0, span)),
      );
    }
    if (next() < 0.6) insertPlan.run(conversationId, pick(runChoices), timestamp(between(0, span)));
    if (next() < 0.6) insertUsage.run(conversationId, timestamp(between(0, span)));
    const checkpointCount = between(0, 4);
    for (let index = 0; index < checkpointCount; index += 1) {
      insertCheckpoint.run(`${conversationId}-k${index}`, conversationId, between(0, 6), timestamp(between(0, span)));
    }
    const workspaceRuns = [...new Set(Array.from({ length: between(0, 3) }, () => pick(runs)))];
    for (const runId of workspaceRuns) {
      insertWorkspaceRun.run(
        runId,
        pick(["agent", "agent", "check"]),
        conversationId,
        pick(["running", "waiting", "succeeded", "failed", "cancelled"]),
        timestamp(between(0, span)),
        next() < 0.3 ? null : timestamp(between(0, span)),
      );
    }
    if (users.length > 0 && next() < 0.35) {
      const userMessageId = pick(users);
      const turnId = `existing-${seed}-${conversation}`;
      const at = new Date(base).toISOString();
      insertTurn.run(
        turnId,
        conversationId,
        pick([runs[0], `existing-run-${seed}-${conversation}`]),
        userMessageId,
        at,
        at,
        at,
        pick(["inferred", "authoritative"]),
        at,
        at,
      );
      if (next() < 0.5) database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turnId, userMessageId);
      database.prepare(
        "UPDATE activities SET turn_id = ? WHERE id IN (SELECT id FROM activities WHERE conversation_id = ? ORDER BY id LIMIT 2)",
      ).run(turnId, conversationId);
    }
  }
}

beforeAll(async () => {
  workRoot = mkdtempSync(join(process.cwd(), ".legacy-backfill-test-"));
  const empty = new Database(":memory:");
  try {
    empty.pragma("foreign_keys = ON");
    migrateRuntimeDatabase(empty, 17);
    emptyImage = empty.serialize();
  } finally {
    empty.close();
  }
  largeImage = schema17Image((database) => database.exec(REPRODUCTION_SQL));
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe("bounded legacy backfill contract", () => {
  it("derives the bounded helper from the released helper by substituting only its spread reductions", () => {
    const source = readFileSync(resolve(RUNNER_PATH), "utf8").replaceAll("\r\n", "\n");
    const declarations = functionDeclarations(source);
    const released = declarations.get("backfillLegacyAgentTurns");
    const bounded = declarations.get("backfillLegacyAgentTurnsBounded");
    if (!released || !bounded) throw new Error("The legacy backfill helpers are unavailable.");
    let derived = released.text;
    for (const [from, to, occurrences] of SUBSTITUTIONS) {
      expect(derived.split(from).length - 1).toBe(occurrences);
      derived = derived.replaceAll(from, to);
    }
    expect(significantTokens(bounded.text)).toEqual(significantTokens(derived));
    expect(spreadArgumentCalls(released.node)).toBe(2);
    expect(spreadArgumentCalls(bounded.node)).toBe(0);
    const reductions = functionDeclarations(readFileSync(resolve(REDUCTIONS_PATH), "utf8").replaceAll("\r\n", "\n"));
    for (const helper of ["boundedMathMin", "boundedMathMax"]) {
      const declaration = reductions.get(helper);
      if (!declaration) throw new Error(`${helper} is unavailable.`);
      expect(spreadArgumentCalls(declaration.node)).toBe(0);
    }
    for (const helper of [...PINNED_HELPERS, "applyReleasedLegacyBackfill"]) {
      const declaration = declarations.get(helper);
      if (!declaration) throw new Error(`${helper} is unavailable.`);
      expect(spreadArgumentCalls(declaration.node)).toBe(0);
    }
  });

  it("reduces exactly like Math.min and Math.max for every number class", () => {
    const next = random(368);
    const large = Array.from({ length: 20_000 }, (_, index) =>
      index % 97 === 0 ? 42 : Math.round((next() - 0.5) * 2e12));
    const cases: number[][] = [
      [],
      [5],
      [-7],
      [Number.NaN],
      [1, Number.NaN, 3],
      [Number.NaN, Number.NEGATIVE_INFINITY],
      [Number.POSITIVE_INFINITY, Number.NaN],
      [-0],
      [0],
      [-0, 0],
      [0, -0],
      [-0, -0, 0],
      [-5, -1, -3],
      [2, 2, 2],
      [3, 1, 3, 1],
      [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE],
      [1.5, -2.25, 1e21, -1e-7],
      [Date.UTC(2000, 0, 1), Date.UTC(2025, 0, 1), 8.64e15, -8.64e15],
      large,
    ];
    for (const values of cases) {
      expect(boundedMathMin(values)).toBe(Math.min(...values));
      expect(boundedMathMax(values)).toBe(Math.max(...values));
      for (let split = 0; split <= Math.min(values.length, 6); split += 1) {
        expect(boundedMathMin(values.slice(0, split), values.slice(split))).toBe(Math.min(...values));
        expect(boundedMathMax(values.slice(0, split), values.slice(split))).toBe(Math.max(...values));
      }
      for (const floor of [0, -0, 7, Number.NaN, Number.NEGATIVE_INFINITY]) {
        expect(boundedMathMax([floor], values)).toBe(Math.max(floor, ...values));
      }
    }
    expect(boundedMathMin()).toBe(Number.POSITIVE_INFINITY);
    expect(boundedMathMax()).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("bounded legacy backfill equivalence", () => {
  it("matches the released helper on every published fixture", () => {
    const manifest = JSON.parse(readFileSync(resolve("tests/fixtures/database/manifest.json"), "utf8")) as {
      fixtures: Array<{ tag: string; schemaVersion: number; file: string }>;
    };
    expect(manifest.fixtures).toHaveLength(6);
    for (const fixture of manifest.fixtures) {
      const path = join(workRoot, `fixture-${fixture.tag}.sqlite`);
      copyFileSync(resolve("tests/fixtures/database", fixture.file), path);
      const database = new Database(path);
      let image: Buffer;
      try {
        database.pragma("foreign_keys = ON");
        migrateRuntimeDatabase(database, 17);
        image = database.serialize();
      } finally {
        database.close();
      }
      const result = releasedAndBounded(image, fixture.schemaVersion);
      expect(result.released.diagnostics.turnsCreated).toBe(2);
      expect(result.bounded).toEqual(result.released);
    }
  });

  it("matches the released helper on ambiguous, malformed and pre-owned legacy associations", () => {
    const statuses = new Set<unknown>();
    const totals = { reused: 0, deterministic: 0, inferredReused: 0, orphanActivities: 0, orphanAssistants: 0, groups: 0 };
    let malformedTimestamps = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const image = schema17Image((database) => seedAmbiguousLegacyProfile(database, seed));
      const probe = reopen(image);
      malformedTimestamps += count(probe, `
        SELECT (SELECT COUNT(*) FROM messages WHERE created_at IN ('', 'not-a-time'))
          + (SELECT COUNT(*) FROM activities WHERE created_at IN ('', 'not-a-time'))
          + (SELECT COUNT(*) FROM workspace_runs WHERE finished_at IS NULL) AS count
      `);
      probe.close();
      const result = releasedAndBounded(image);
      expect(result.bounded, `seed ${seed}`).toEqual(result.released);
      for (const turn of result.released.rows.agent_turns!) statuses.add(turn.status);
      totals.reused += result.released.diagnostics.runIdsReused;
      totals.deterministic += result.released.diagnostics.deterministicRunIdsCreated;
      totals.inferredReused += result.released.diagnostics.inferredTurnsReused;
      totals.orphanActivities += result.released.diagnostics.orphans.activities;
      totals.orphanAssistants += result.released.diagnostics.orphans.assistantMessages;
      totals.groups += result.released.diagnostics.responseGroups;
    }
    expect([...statuses].sort()).toEqual(["cancelled", "completed", "failed", "interrupted"]);
    expect(malformedTimestamps).toBeGreaterThan(0);
    for (const total of Object.values(totals)) expect(total).toBeGreaterThan(0);
  });

  it("matches the released helper below the argument limit with many large responses", () => {
    const image = schema17Image((database) => database.exec(`
      INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
        VALUES ('p', 'Synthetic', '/synthetic', '#888888', 'ready', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      INSERT INTO conversations (id, project_id, title, created_at, updated_at)
        VALUES ('c', 'p', 'Synthetic', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      WITH RECURSIVE turns(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM turns WHERE n < 3)
      INSERT INTO messages (id, conversation_id, role, content, created_at)
        SELECT 'u' || n, 'c', 'user', 'Synthetic', strftime('%Y-%m-%dT%H:%M:%fZ', '2025-01-01', '+' || (n * 1000) || ' seconds') FROM turns;
      WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM numbers WHERE n < 19999)
      INSERT INTO activities (id, conversation_id, run_id, kind, title, status, created_at)
        SELECT 'a' || n, 'c', 'run-' || (n % 4), 'status', 'Synthetic', CASE WHEN n = 7 THEN 'failed' ELSE 'completed' END,
          strftime('%Y-%m-%dT%H:%M:%fZ', '2025-01-01', '+' || ((n % 4) * 1000 + 1 + (n % 900)) || ' seconds') FROM numbers;
    `));
    const result = releasedAndBounded(image);
    expect(result.released.diagnostics.associated.activities).toBe(20_000);
    expect(result.bounded).toEqual(result.released);
  });
});

describe("bounded legacy backfill fallback", { timeout: 240_000 }, () => {
  it("reproduces the released argument-limit failure without changing the profile", () => {
    const database = reopen(largeImage);
    try {
      expect(() => backfillLegacyAgentTurns(database, { sourceSchemaVersion: 17 })).toThrow(RangeError);
      expectUntouchedReproduction(database);
    } finally {
      database.close();
    }
  });

  it("upgrades the large schema-17 reproduction through the bounded fallback", () => {
    const database = reopen(largeImage);
    try {
      const { diagnostic, error } = migrate(database, runtimeMigrationCatalog());
      expect(error).toBeNull();
      expect(diagnostic).toMatchObject({
        outcome: "succeeded",
        sourceSchemaVersion: 17,
        targetSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
        compatibility: "bounded-legacy-backfill",
        legacyBackfill: {
          responseGroups: 1,
          turnsCreated: 1,
          runIdsReused: 1,
          associated: { messages: 1, activities: LARGE_ACTIVITY_COUNT },
          orphans: { activities: 0 },
        },
      });
      const line = formatMigrationDiagnostic(diagnostic!);
      expect(line).toContain("compatibility=bounded-legacy-backfill");
      expect(line).toContain("inferredTurns=1");
      expect(line).not.toMatch(/synthetic|legacy-run|\/synthetic/iu);
      expectUpgradedReproduction(database);
    } finally {
      database.close();
    }
  });

  it("produces the released helper's exact rows when that helper has an enlarged stack", async () => {
    const workerPath = await bundle("released-backfill-worker", `
      import { parentPort, workerData } from "node:worker_threads";
      import Database from "better-sqlite3";
      import { backfillLegacyAgentTurns } from "./${RUNNER_PATH}";
      const database = new Database(Buffer.from(workerData.image));
      database.pragma("foreign_keys = ON");
      const diagnostics = backfillLegacyAgentTurns(database, { sourceSchemaVersion: 17 });
      parentPort.postMessage({ diagnostics, image: database.serialize() });
      database.close();
    `);
    const released = await new Promise<{ diagnostics: LegacyBackfillDiagnostics; image: Uint8Array }>((settle, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { image: largeImage },
        resourceLimits: { stackSizeMb: 64 },
      });
      worker.once("message", settle);
      worker.once("error", reject);
    });
    const releasedDatabase = reopen(Buffer.from(released.image));
    const boundedDatabase = reopen(largeImage);
    try {
      const boundedDiagnostics = backfillLegacyAgentTurnsBounded(boundedDatabase, { sourceSchemaVersion: 17 });
      expect(boundedDiagnostics).toEqual(released.diagnostics);
      expect(completeDigest(boundedDatabase)).toBe(completeDigest(releasedDatabase));
      expect(count(boundedDatabase, "SELECT COUNT(*) AS count FROM activities WHERE turn_id = ?", REPRODUCTION_TURN_ID))
        .toBe(LARGE_ACTIVITY_COUNT);
    } finally {
      releasedDatabase.close();
      boundedDatabase.close();
    }
  });

  it("rolls the whole upgrade back byte-for-byte when the fallback fails midway, then retries", () => {
    const path = walDatabase("midway-failure.sqlite");
    const before = sha256File(path);
    const database = new Database(path);
    let assignments = 0;
    try {
      database.pragma("foreign_keys = ON");
      database.function("inject_midway_failure", () => {
        assignments += 1;
        if (assignments === MIDWAY_ASSIGNMENT) throw new Error("Injected midway failure");
        return null;
      });
      database.exec(`
        CREATE TEMP TRIGGER inject_midway_failure AFTER UPDATE OF turn_id ON main.activities
        BEGIN SELECT inject_midway_failure(); END
      `);
      const { error } = migrate(database, runtimeMigrationCatalog());
      expect(error?.diagnostic).toMatchObject({ outcome: "failed", failedVersion: 18, compatibility: null });
      expect(error?.cause).toMatchObject({ message: expect.stringContaining("Injected midway failure") });
      expect(assignments).toBe(MIDWAY_ASSIGNMENT);
      expectUntouchedReproduction(database);
    } finally {
      database.close();
    }
    expect(sha256File(path)).toBe(before);

    const retry = new Database(path);
    try {
      retry.pragma("foreign_keys = ON");
      const { diagnostic, error } = migrate(retry, runtimeMigrationCatalog());
      expect(error).toBeNull();
      expect(diagnostic?.compatibility).toBe("bounded-legacy-backfill");
      expectUpgradedReproduction(retry);
    } finally {
      retry.close();
    }
  });

  it("recovers an upgrade killed during the fallback and retries safely", async () => {
    const path = walDatabase("interrupted.sqlite");
    const interruptionReceipt = join(workRoot, "interrupted-at.txt");
    const before = sha256File(path);
    const childPath = await bundle("interrupted-upgrade", `
      import { writeFileSync } from "node:fs";
      import Database from "better-sqlite3";
      import { migrateRuntimeDatabase } from "./src/server/persistence/migrations/runtime-catalog.ts";
      const database = new Database(process.argv[2]);
      database.pragma("foreign_keys = ON");
      let assignments = 0;
      database.function("interrupt_midway", () => {
        assignments += 1;
        if (assignments === ${MIDWAY_ASSIGNMENT}) {
          writeFileSync(process.argv[3], String(assignments), { flag: "wx" });
          process.kill(process.pid, "SIGKILL");
        }
        return null;
      });
      database.exec("CREATE TEMP TRIGGER interrupt_midway AFTER UPDATE OF turn_id ON main.activities BEGIN SELECT interrupt_midway(); END");
      migrateRuntimeDatabase(database);
      process.stdout.write("completed");
    `);
    const child = spawnSync(process.execPath, [childPath, path, interruptionReceipt], { encoding: "utf8", timeout: 180_000 });
    expect(child.error).toBeUndefined();
    expect(readFileSync(interruptionReceipt, "utf8")).toBe(String(MIDWAY_ASSIGNMENT));
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
    expect(child.status === 0).toBe(false);
    if (process.platform !== "win32") expect(child.signal).toBe("SIGKILL");
    expect(sha256File(path)).toBe(before);

    const recovered = new Database(path);
    try {
      recovered.pragma("foreign_keys = ON");
      expect(recovered.pragma("integrity_check", { simple: true })).toBe("ok");
      expectUntouchedReproduction(recovered);
      const { diagnostic, error } = migrate(recovered, runtimeMigrationCatalog());
      expect(error).toBeNull();
      expect(diagnostic?.compatibility).toBe("bounded-legacy-backfill");
      expectUpgradedReproduction(recovered);
    } finally {
      recovered.close();
    }
  });
});

describe("closed legacy backfill compatibility", () => {
  const smallImage = (): Buffer => schema17Image((database) => seedAmbiguousLegacyProfile(database, 7));

  it("replaces only a released-identity RangeError and discards that attempt's partial writes", () => {
    const image = smallImage();
    const expected = releasedAndBounded(image).released;
    const database = reopen(image);
    try {
      const { diagnostic, error } = migrate(database, catalogWith({
        version: 18,
        name: "BackfillLegacyAgentTurns",
        up: (target, context) => {
          backfillLegacyAgentTurns(target, { sourceSchemaVersion: context.sourceSchemaVersion });
          throw new RangeError("Maximum call stack size exceeded");
        },
      }));
      expect(error).toBeNull();
      expect(diagnostic?.compatibility).toBe("bounded-legacy-backfill");
      expect(diagnostic?.legacyBackfill).toEqual(expected.diagnostics);
      expect(completeDump(database)).toEqual(expected.rows);
    } finally {
      database.close();
    }
  });

  it("propagates RangeErrors outside the released identity and every other released failure", () => {
    const failures: Array<[readonly DatabaseMigration[], number, unknown]> = [
      [catalogWith({
        version: 18,
        name: "OtherBackfill",
        up: (target) => {
          backfillLegacyAgentTurns(target, { sourceSchemaVersion: 17 });
          throw new RangeError("Other migration overflow");
        },
      }), 18, RangeError],
      [[...runtimeMigrationCatalog().slice(0, 18), {
        version: 19,
        name: "LaterMigration",
        up: () => { throw new RangeError("Later migration overflow"); },
      }], 19, RangeError],
      [catalogWith({
        version: 18,
        name: "BackfillLegacyAgentTurns",
        up: (target) => {
          backfillLegacyAgentTurns(target, { sourceSchemaVersion: 17 });
          throw new TypeError("Released non-range failure");
        },
      }), 18, TypeError],
    ];
    for (const [migrations, failedVersion, errorType] of failures) {
      const database = reopen(smallImage());
      try {
        const { error } = migrate(database, migrations);
        expect(error?.diagnostic).toMatchObject({ outcome: "failed", failedVersion, compatibility: null });
        expect(error?.cause).toBeInstanceOf(errorType);
        expect(schemaVersion(database)).toBe(17);
        expect(count(database, "SELECT COUNT(*) AS count FROM agent_turns")).toBe(0);
      } finally {
        database.close();
      }
    }
  });

  it("rolls every step back when the fallback itself fails", () => {
    const image = smallImage();
    const database = reopen(image);
    try {
      database.exec(`
        CREATE TEMP TRIGGER reject_fallback_turns BEFORE INSERT ON main.agent_turns
        BEGIN SELECT RAISE(ABORT, 'Injected fallback failure'); END
      `);
      const { error } = migrate(database, [...catalogWith({
        version: 18,
        name: "BackfillLegacyAgentTurns",
        up: () => { throw new RangeError("Maximum call stack size exceeded"); },
      }), {
        version: 19,
        name: "LaterMigration",
        up: "CREATE TABLE later_marker (id INTEGER PRIMARY KEY);",
      }]);
      expect(error?.diagnostic).toMatchObject({ outcome: "failed", failedVersion: 18, compatibility: null });
      expect(error?.cause).toMatchObject({ message: expect.stringContaining("Injected fallback failure") });
      expect(schemaVersion(database)).toBe(17);
      expect(completeDump(database)).toEqual(completeDump(reopen(image)));
    } finally {
      database.close();
    }
  });
});
