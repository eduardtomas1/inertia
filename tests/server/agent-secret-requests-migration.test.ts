// @inertia-test-suite portable

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  AGENT_SECRET_REQUESTS_SCHEMA_VERSION,
  agentSecretRequestsMigration,
} from "../../src/server/persistence/migrations/agent-secret-requests";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("appends agent secret requests as schema 116 with role and file token checks", async () => {
  expect(AGENT_SECRET_REQUESTS_SCHEMA_VERSION).toBe(116);
  expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(AGENT_SECRET_REQUESTS_SCHEMA_VERSION);
  expect(runtimeMigrationCatalog().find(({ version }) => version === 116)?.name).toBe(agentSecretRequestsMigration.name);
  const directory = await mkdtemp(join(tmpdir(), "inertia-agent-secret-requests-migration-"));
  directories.push(directory);
  const path = join(directory, "inertia.sqlite");
  const legacy = new Database(path);
  migrateRuntimeDatabase(legacy, 115);
  expect((legacy.pragma("table_info(messages)") as Array<{ name: string }>).map(({ name }) => name)).not.toContain("secret_request_json");
  legacy.close();
  const store = new RuntimeStore(path, directory, { recoverInterruptedRuns: false });
  const project = store.createProject("Secrets", directory);
  const conversation = store.createConversation(project.id, "Secrets", {
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
  });
  const runId = randomUUID();
  const { turn } = store.beginAgentTurn({
    conversationId: conversation.id, runId, content: "Log in.", providerId: "codex",
    modelSelection: store.conversation(conversation.id).modelSelection, reasoningEffort: "",
    interactionMode: "build", accessMode: "supervised",
    configurationRevision: store.conversation(conversation.id).modelSelection.backendConfigurationRevision,
    association: "authoritative",
  });
  const system = store.createMessage(conversation.id, "Asked for a secret: Key", "system", [], turn.id);
  store.close();
  const database = new Database(path);
  try {
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(116);
    const reference = JSON.stringify({ requestId: randomUUID() });
    expect(() => database.prepare("UPDATE messages SET secret_request_json = ? WHERE id = ?").run(reference, turn.userMessageId))
      .toThrow(/CHECK constraint failed/u);
    expect(() => database.prepare("UPDATE messages SET secret_request_json = ? WHERE id = ?").run("not json", system.id))
      .toThrow(/CHECK constraint failed/u);
    database.prepare("UPDATE messages SET secret_request_json = ? WHERE id = ?").run(reference, system.id);
    const insert = (id: string, status: string, fileToken: string | null) => database.prepare(`INSERT INTO agent_secret_requests (
        id, conversation_id, turn_id, run_id, message_id, provider_id, title, description, file_name, file_token,
        ttl_hours, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'codex', 'Key', 'Paste it.', 'secret', ?, 24, ?, '2026-10-29T10:00:00.000Z', '2026-10-30T10:00:00.000Z')`)
      .run(id, conversation.id, turn.id, runId, system.id, fileToken, status);
    expect(() => insert(randomUUID(), "saved", "A".repeat(32))).toThrow(/CHECK constraint failed/u);
    expect(() => insert(randomUUID(), "saved", "a".repeat(31))).toThrow(/CHECK constraint failed/u);
    expect(() => insert(randomUUID(), "saved", null)).toThrow(/CHECK constraint failed/u);
    expect(() => insert(randomUUID(), "forgotten", null)).toThrow(/CHECK constraint failed/u);
    insert(randomUUID(), "saved", "0123456789abcdef0123456789abcdef");
    expect(database.prepare("SELECT COUNT(*) FROM agent_secret_requests").pluck().get()).toBe(1);
  } finally {
    database.close();
  }
});

it("tolerates a secret request column that already exists", () => {
  const database = new Database(":memory:");
  try {
    migrateRuntimeDatabase(database, AGENT_SECRET_REQUESTS_SCHEMA_VERSION - 1);
    database.exec("ALTER TABLE messages ADD COLUMN secret_request_json TEXT");
    expect(() => migrateRuntimeDatabase(database)).not.toThrow();
    const columns = (database.pragma("table_info(messages)") as Array<{ name: string }>).map(({ name }) => name);
    expect(columns.filter((name) => name === "secret_request_json")).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) FROM agent_secret_requests").pluck().get()).toBe(0);
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
  } finally {
    database.close();
  }
});
