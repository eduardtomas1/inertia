import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDirectory = join(repositoryRoot, "tests", "fixtures", "database");
const releases = [
  { tag: "v0.0.1", expectedSchema: 2 },
  { tag: "v0.0.2", expectedSchema: 3 },
  { tag: "v0.0.3", expectedSchema: 4 },
  { tag: "v0.0.4", expectedSchema: 6 },
  { tag: "v0.0.5", expectedSchema: 15 },
  { tag: "v0.0.6", expectedSchema: 15 },
];

function git(...args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function migrationSqlAtTag(tag) {
  const source = git("show", `${tag}:src/server/database.ts`);
  const start = source.indexOf("const migrations = [");
  const end = source.indexOf("] as const;", start);
  if (start < 0 || end < 0) throw new Error(`Cannot find migrations in ${tag}.`);
  const migrations = [];
  const expression = /`([\s\S]*?)`/gu;
  for (const match of source.slice(start, end).matchAll(expression)) {
    migrations.push(match[1]);
  }
  return migrations;
}

function hasTable(database, table) {
  return database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;
}

function columns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name));
}

function insertSanitizedHistory(database, tag) {
  const suffix = tag.replaceAll(".", "").replace("v", "");
  const projectId = `fixture-project-${suffix}`;
  const conversationId = `fixture-conversation-${suffix}`;
  const timestamp = (seconds) => `2025-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;

  database.prepare(`
    INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    `Sanitized ${tag} project`,
    `fixture://published-schema/${tag}`,
    "#6f76d9",
    "ready",
    timestamp(0),
    timestamp(50),
  );
  database.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    conversationId,
    projectId,
    `Sanitized ${tag} conversation`,
    timestamp(0),
    timestamp(50),
  );
  database.prepare(`
    INSERT INTO app_state (
      id, theme, compact_sidebar, show_timestamps, terminal_font_size,
      active_project_id, active_conversation_id
    ) VALUES (1, 'system', 0, 1, 13, ?, ?)
  `).run(projectId, conversationId);

  const insertMessage = database.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertMessage.run(`message-orphan-${suffix}`, conversationId, "assistant", "Sanitized orphan response.", timestamp(5));
  insertMessage.run(`message-user-1-${suffix}`, conversationId, "user", "First sanitized request.", timestamp(10));
  insertMessage.run(`message-assistant-1a-${suffix}`, conversationId, "assistant", "First sanitized response part.", timestamp(20));
  insertMessage.run(`message-system-1-${suffix}`, conversationId, "system", "Sanitized system note.", timestamp(21));
  insertMessage.run(`message-assistant-1b-${suffix}`, conversationId, "assistant", "First sanitized response complete.", timestamp(22));
  insertMessage.run(`message-user-2-${suffix}`, conversationId, "user", "Second sanitized request.", timestamp(30));
  insertMessage.run(`message-assistant-2-${suffix}`, conversationId, "assistant", "Second sanitized response complete.", timestamp(40));

  const insertActivity = database.prepare(`
    INSERT INTO activities (
      id, conversation_id, run_id, kind, title, detail, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertActivity.run(`activity-orphan-${suffix}`, conversationId, `run-orphan-${suffix}`, "status", "Sanitized orphan activity", null, "completed", timestamp(6));
  insertActivity.run(`activity-1a-${suffix}`, conversationId, `run-reused-1-${suffix}`, "status", "Sanitized first run", null, "running", timestamp(12));
  insertActivity.run(`activity-1b-${suffix}`, conversationId, `run-reused-1-${suffix}`, "tool", "Sanitized first tool", null, "completed", timestamp(19));
  insertActivity.run(`activity-competing-${suffix}`, conversationId, `run-unmatched-${suffix}`, "status", "Sanitized unmatched activity", null, "completed", timestamp(18));
  insertActivity.run(`activity-2-${suffix}`, conversationId, `run-reused-2-${suffix}`, "status", "Sanitized second run", null, "completed", timestamp(35));

  const insertCheckpoint = database.prepare(`
    INSERT INTO checkpoints (
      id, conversation_id, ref, label, turn_index, files_changed,
      insertions, deletions, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertCheckpoint.run(`checkpoint-1-${suffix}`, conversationId, `fixture-ref-1-${suffix}`, "Before turn 1", 1, 1, 2, 0, timestamp(11));
  insertCheckpoint.run(`checkpoint-2-${suffix}`, conversationId, `fixture-ref-2-${suffix}`, "Before turn 2", 2, 1, 1, 1, timestamp(31));
  insertCheckpoint.run(`checkpoint-orphan-${suffix}`, conversationId, `fixture-ref-orphan-${suffix}`, "Unmatched checkpoint", 99, 0, 0, 0, timestamp(45));

  if (hasTable(database, "agent_plans")) {
    database.prepare(`
      INSERT INTO agent_plans (
        conversation_id, run_id, explanation, steps_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      conversationId,
      `run-reused-2-${suffix}`,
      "Sanitized plan.",
      JSON.stringify([{ step: "Sanitized step", status: "completed" }]),
      timestamp(34),
    );
  }

  if (hasTable(database, "agent_reasonings")) {
    const insertReasoning = database.prepare(`
      INSERT INTO agent_reasonings (
        id, conversation_id, run_id, content, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertReasoning.run(`reasoning-orphan-${suffix}`, conversationId, `reasoning-orphan-run-${suffix}`, "Sanitized orphan reasoning.", "completed", timestamp(7));
    insertReasoning.run(`reasoning-1-${suffix}`, conversationId, `run-reused-1-${suffix}`, "Sanitized first reasoning.", "completed", timestamp(17));
    insertReasoning.run(`reasoning-2-${suffix}`, conversationId, `run-reused-2-${suffix}`, "Sanitized second reasoning.", "completed", timestamp(36));
  }

  if (hasTable(database, "thread_usage")) {
    const usageColumns = columns(database, "thread_usage");
    if (usageColumns.has("total_processed_scope")) {
      database.prepare(`
        INSERT INTO thread_usage (
          conversation_id, used_tokens, total_processed_tokens,
          total_processed_scope, max_tokens, input_tokens, cached_input_tokens,
          cache_write_input_tokens, output_tokens, reasoning_output_tokens,
          compacts_automatically, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(conversationId, 120, 500, "thread", 200_000, 100, 20, 0, 40, 10, 1, timestamp(41));
    } else {
      database.prepare(`
        INSERT INTO thread_usage (
          conversation_id, used_tokens, total_processed_tokens, max_tokens,
          input_tokens, cached_input_tokens, output_tokens,
          reasoning_output_tokens, compacts_automatically, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(conversationId, 120, 500, 200_000, 100, 20, 40, 10, 1, timestamp(41));
    }
  }

  if (hasTable(database, "provider_metadata_cache")) {
    database.prepare(`
      INSERT INTO provider_metadata_cache (
        provider_id, executable, version, auth_state, models_json,
        models_updated_at, models_last_attempted_at, models_provenance,
        models_stale, rate_limits_json, rate_limits_updated_at,
        rate_limits_last_attempted_at, rate_limits_provenance, rate_limits_stale
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0)
    `).run(
      "codex",
      "fixture-version",
      "unknown",
      JSON.stringify([{ id: "fixture-model", label: "Sanitized model" }]),
      timestamp(1),
      timestamp(1),
      "persistent-cache",
      "[]",
      timestamp(1),
      timestamp(1),
      "persistent-cache",
    );
  }

  if (hasTable(database, "diff_review_summaries")) {
    database.prepare(`
      INSERT INTO diff_review_summaries (
        conversation_id, fingerprint, provider_id, overall, files_json, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversationId, "a".repeat(64), "codex", "Sanitized review.", "[]", timestamp(42));
    database.prepare(`
      INSERT INTO diff_review_states (
        conversation_id, scope, path, hunk_id, target_fingerprint,
        reviewed, stale, updated_at
      ) VALUES (?, 'file', ?, '', ?, 1, 0, ?)
    `).run(conversationId, "fixture-file.txt", "b".repeat(64), timestamp(43));
    database.prepare(`
      INSERT INTO diff_review_notes (
        id, conversation_id, path, hunk_id, line_ids_json,
        target_fingerprint, body, stale, created_at, updated_at
      ) VALUES (?, ?, ?, '', '[]', ?, ?, 0, ?, ?)
    `).run(
      `review-note-${suffix}`,
      conversationId,
      "fixture-file.txt",
      "b".repeat(64),
      "Sanitized note.",
      timestamp(43),
      timestamp(43),
    );
  }

  if (hasTable(database, "workspace_runs")) {
    const insertRun = database.prepare(`
      INSERT INTO workspace_runs (
        id, kind, project_id, conversation_id, label, detail,
        status, port, started_at, finished_at
      ) VALUES (?, 'agent', ?, ?, ?, NULL, ?, NULL, ?, ?)
    `);
    insertRun.run(`run-reused-1-${suffix}`, projectId, conversationId, "Sanitized first run", "succeeded", timestamp(11), timestamp(22));
    insertRun.run(`run-reused-2-${suffix}`, projectId, conversationId, "Sanitized second run", "succeeded", timestamp(31), timestamp(40));
  }
}

function generateFixture(outputDirectory, release) {
  const migrations = migrationSqlAtTag(release.tag);
  if (migrations.length !== release.expectedSchema) {
    throw new Error(
      `${release.tag} has ${migrations.length} migrations; expected ${release.expectedSchema}.`,
    );
  }
  const outputPath = join(outputDirectory, `${release.tag}.sqlite`);
  rmSync(outputPath, { force: true });
  const database = new Database(outputPath);
  try {
    database.pragma("journal_mode = DELETE");
    database.pragma("foreign_keys = ON");
    database.pragma("page_size = 4096");
    database.exec(
      "CREATE TABLE schema_migrations"
      + " (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const recordMigration = database.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    );
    for (const [index, sql] of migrations.entries()) {
      const version = index + 1;
      database.transaction(() => {
        database.exec(sql);
        recordMigration.run(
          version,
          `2000-01-01T00:00:${String(version).padStart(2, "0")}.000Z`,
        );
      })();
    }
    database.transaction(() => insertSanitizedHistory(database, release.tag))();
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`${release.tag} fixture failed integrity_check.`);
    database.exec("VACUUM");
  } finally {
    database.close();
  }
  const bytes = readFileSync(outputPath);
  return {
    tag: release.tag,
    commit: git("rev-parse", `${release.tag}^{commit}`),
    schemaVersion: release.expectedSchema,
    file: basename(outputPath),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function generateAll(outputDirectory) {
  mkdirSync(outputDirectory, { recursive: true });
  const fixtures = releases.map((release) => generateFixture(outputDirectory, release));
  writeFileSync(
    join(outputDirectory, "manifest.json"),
    `${JSON.stringify({ format: 1, fixtures }, null, 2)}\n`,
  );
}

function verify() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "inertia-db-fixtures-"));
  try {
    generateAll(temporaryDirectory);
    for (const release of releases) {
      const file = `${release.tag}.sqlite`;
      const expected = readFileSync(join(fixtureDirectory, file));
      const actual = readFileSync(join(temporaryDirectory, file));
      if (!expected.equals(actual)) throw new Error(`${file} is not reproducible.`);
    }
    const expectedManifest = readFileSync(join(fixtureDirectory, "manifest.json"));
    const actualManifest = readFileSync(join(temporaryDirectory, "manifest.json"));
    if (!expectedManifest.equals(actualManifest)) {
      throw new Error("Database fixture manifest is not reproducible.");
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv.includes("--verify")) verify();
else generateAll(fixtureDirectory);
