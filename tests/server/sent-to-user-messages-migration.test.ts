// @inertia-test-suite portable

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";
import {
  SENT_TO_USER_MESSAGES_SCHEMA_VERSION,
  sentToUserMessagesMigration,
} from "../../src/server/persistence/migrations/sent-to-user-messages";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { removeOrchestratorV2FromFixture } from "../support/legacy-project-settings-schema";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("appends messages to the user as schema 118, a system-only flag on existing messages", async () => {
  expect(SENT_TO_USER_MESSAGES_SCHEMA_VERSION).toBe(118);
  expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(SENT_TO_USER_MESSAGES_SCHEMA_VERSION);
  expect(runtimeMigrationCatalog().find(({ version }) => version === 118)?.name).toBe(sentToUserMessagesMigration.name);
  const directory = await mkdtemp(join(tmpdir(), "inertia-sent-to-user-migration-"));
  directories.push(directory);
  const path = join(directory, "inertia.sqlite");

  // A chat written by the previous schema keeps every message, unflagged.
  const store117 = new RuntimeStore(path, directory, { recoverInterruptedRuns: false });
  const project = store117.createProject("Messages", directory);
  const conversation = store117.createConversation(project.id, "Before", {
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
  });
  const { turn } = store117.beginAgentTurn({
    conversationId: conversation.id, runId: "run-before", content: "Draft it.", providerId: "codex",
    modelSelection: conversation.modelSelection, reasoningEffort: "",
    interactionMode: "build", accessMode: "supervised",
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  });
  const notice = store117.createMessage(conversation.id, "Provider reconnected.", "system", [], turn.id);
  store117.close();
  const legacy = new Database(path);
  // Orchestrator V2's later migrations go too, so this is a schema 117 database.
  removeOrchestratorV2FromFixture(legacy);
  legacy.exec("DELETE FROM schema_migrations WHERE version >= 118");
  legacy.exec("ALTER TABLE messages DROP COLUMN sent_to_user");
  expect((legacy.pragma("table_info(messages)") as Array<{ name: string }>).map(({ name }) => name)).not.toContain("sent_to_user");
  legacy.close();

  const store = new RuntimeStore(path, directory, { recoverInterruptedRuns: false });
  try {
    const messages = store.conversationDetail(conversation.id)!.messages;
    expect(messages.map(({ id }) => id)).toEqual([turn.userMessageId, notice.id]);
    expect(messages.some((message) => "sentToUser" in message)).toBe(false);
  } finally {
    store.close();
  }

  const database = new Database(path);
  try {
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    expect(database.prepare("SELECT COUNT(*) FROM messages WHERE sent_to_user <> 0").pluck().get()).toBe(0);
    expect(() => database.prepare("UPDATE messages SET sent_to_user = 1 WHERE id = ?").run(turn.userMessageId))
      .toThrow(/CHECK constraint failed/u);
    expect(() => database.prepare("UPDATE messages SET sent_to_user = 2 WHERE id = ?").run(notice.id))
      .toThrow(/CHECK constraint failed/u);
    expect(() => database.prepare("UPDATE messages SET sent_to_user = NULL WHERE id = ?").run(notice.id))
      .toThrow(/NOT NULL/u);
    database.prepare("UPDATE messages SET sent_to_user = 1 WHERE id = ?").run(notice.id);
  } finally {
    database.close();
  }
});

it("tolerates a sent-to-user column that already exists, and refuses one of another shape", () => {
  const database = new Database(":memory:");
  try {
    migrateRuntimeDatabase(database, SENT_TO_USER_MESSAGES_SCHEMA_VERSION - 1);
    database.exec("ALTER TABLE messages ADD COLUMN sent_to_user INTEGER NOT NULL DEFAULT 0");
    expect(() => migrateRuntimeDatabase(database)).not.toThrow();
    const columns = (database.pragma("table_info(messages)") as Array<{ name: string }>).map(({ name }) => name);
    expect(columns.filter((name) => name === "sent_to_user")).toHaveLength(1);
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
  } finally {
    database.close();
  }
  const mismatched = new Database(":memory:");
  try {
    migrateRuntimeDatabase(mismatched, SENT_TO_USER_MESSAGES_SCHEMA_VERSION - 1);
    mismatched.exec("ALTER TABLE messages ADD COLUMN sent_to_user TEXT");
    expect(() => migrateRuntimeDatabase(mismatched)).toThrow(/Database migration 118 \(PersistSentToUserMessages\)/u);
  } finally {
    mismatched.close();
  }
});
