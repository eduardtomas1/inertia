import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { QUEUE_ITEMS_SCHEMA_VERSION, queueItemsMigration } from "../../src/server/persistence/migrations/queue-items";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { queuedIntentDigest } from "../../src/server/persistence/queued-message-repository";
import {
  QUEUE_ITEM_PROJECTION,
  QUEUE_STATE_PROJECTION,
} from "../../src/shared/orchestration-queue";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { WatcherNoteAttribution } from "../../src/shared/watcher";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSchema130Database() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-m131-"));
  directories.push(directory);
  const path = join(directory, "inertia.sqlite");
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  migrateRuntimeDatabase(db, QUEUE_ITEMS_SCHEMA_VERSION - 1);
  expect((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v).toBe(130);
  return { directory, path, db };
}

describe("Migration 131 (PersistQueueItemOrderDeliveryAndSelection) and boot adoption", () => {
  it("backfills legacy rows, purges orphan receipts, enforces constraints, adopts legacy rows, and rebuilds cleanly", () => {
    const { directory, path, db } = createSchema130Database();
    const now = "2026-11-01T10:00:00.000Z";
    const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.4" });
    const projectId = randomUUID();
    const liveConvId = randomUUID();
    const deletedConvId = randomUUID();
    const deletedProjectId = randomUUID();

    db.prepare(`INSERT INTO projects (id, name, path, normalized_path, repository_relative_path, git_repository_limit, color, status, created_at, updated_at)
      VALUES (?, 'Proj', ?, ?, '.', 16, '#6f76d9', 'ready', ?, ?)`).run(projectId, directory, directory, now, now);
    db.prepare(`INSERT INTO conversations (id, project_id, title, provider_id, model_selection_json, model, reasoning_effort,
      interaction_mode, access_mode, status, last_viewed_at, created_at, updated_at)
      VALUES (?, ?, 'Live chat', 'codex', ?, 'gpt-5.4', '', 'build', 'supervised', 'idle', ?, ?, ?)`)
      .run(liveConvId, projectId, JSON.stringify(selection), now, now, now);

    // Seed an ended turn with an initial prompt and two unread follow-up messages (one web, one mobile).
    const turnId = randomUUID();
    const runId = randomUUID();
    const turnPromptId = randomUUID();
    const unreadWebMsgId = randomUUID();
    const unreadMobileMsgId = randomUUID();
    const rolledBackTurnId = randomUUID();
    const rolledBackRunId = randomUUID();
    const rolledBackPromptId = randomUUID();
    const rolledBackFollowUpId = randomUUID();

    const insertMsg = db.prepare(`INSERT INTO messages (id, conversation_id, role, content, attachments_json, turn_id,
      private_connect_device_id, created_at) VALUES (?, ?, 'user', ?, '[]', ?, ?, ?)`);
    const insertTurn = db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, user_message_id, provider_id,
      model_selection_json, harness_id, backend_profile_id, model, reasoning_effort, interaction_mode, access_mode,
      status, run_state, requested_at, started_at, completed_at, configuration_revision, association, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'codex', ?, 'codex-app-server', 'native:codex', 'gpt-5.4', '', 'build', 'supervised',
      'completed', 'completed', ?, ?, ?, 0, 'authoritative', ?, ?)`);

    const mobileDeviceId = randomUUID();
    insertMsg.run(turnPromptId, liveConvId, "Turn 1 prompt", null, null, now);
    insertTurn.run(turnId, runId, liveConvId, turnPromptId, JSON.stringify(selection), now, now, now, now, now);
    db.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turnId, turnPromptId);
    insertMsg.run(unreadWebMsgId, liveConvId, "Unread web follow-up", turnId, null, "2026-11-01T10:00:04.000Z");
    insertMsg.run(unreadMobileMsgId, liveConvId, "Unread mobile follow-up", turnId, mobileDeviceId, "2026-11-01T10:00:05.000Z");

    insertMsg.run(rolledBackPromptId, liveConvId, "Rolled back prompt", null, null, "2026-11-01T10:00:06.000Z");
    insertTurn.run(rolledBackTurnId, rolledBackRunId, liveConvId, rolledBackPromptId, JSON.stringify(selection),
      "2026-11-01T10:00:06.000Z", "2026-11-01T10:00:06.000Z", "2026-11-01T10:00:06.000Z",
      "2026-11-01T10:00:06.000Z", "2026-11-01T10:00:06.000Z");
    db.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(rolledBackTurnId, rolledBackPromptId);
    insertMsg.run(rolledBackFollowUpId, liveConvId, "Rolled back unread", rolledBackTurnId, null, "2026-11-01T10:00:07.000Z");

    // Mark rolledBackTurnId as rolled back in orchestration_v2_entities (simulating prior G11 rollback).
    db.prepare(`INSERT INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
      VALUES ('rolled-back-turn', ?, ?, ?, 1, ?)`).run(
      rolledBackTurnId, projectId, liveConvId, JSON.stringify({ turnId: rolledBackTurnId, rollbackId: randomUUID() }),
    );

    const routeIdentity = JSON.stringify([projectId, null, "codex", selection, "gpt-5.4", "", "build", "supervised"]);
    const insertQueue = db.prepare(`INSERT INTO queued_messages (id, conversation_id, content, attachments_json,
      intent_digest, route_identity, state, created_at, error, turn_id, user_message_id, watcher_note_json, delegated_completion_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const waitingId = randomUUID();
    const dispatchingId = randomUUID();
    const blockedId = randomUUID();
    const acceptedId = randomUUID();
    const cancelledId = randomUUID();
    const watcherId = randomUUID();
    const delegatedId = randomUUID();
    const unreadWaitingRowId = randomUUID();
    const unreadBlockedRowId = randomUUID();
    const rolledBackRowId = randomUUID();

    const imageAtt = [{ id: randomUUID(), name: "img.png", path: "/tmp/img.png", mimeType: "image/png", size: 64 }];
    const note: WatcherNoteAttribution = {
      linkId: randomUUID(),
      wakeId: randomUUID(),
      watcherConversationId: randomUUID(),
      preset: "reviewer",
      watcherLabel: "Reviewer",
      delivery: "queue",
      automatic: true,
    };
    const delegated = { parentConversationId: liveConvId, generation: 1, taskIds: ["d".repeat(64)] };

    insertQueue.run(waitingId, liveConvId, "Waiting user item", JSON.stringify(imageAtt),
      queuedIntentDigest("Waiting user item", imageAtt as never), routeIdentity, "waiting", "2026-11-01T10:00:01.000Z",
      null, null, null, null, null);
    insertQueue.run(dispatchingId, liveConvId, "Legacy dispatching item", "[]",
      queuedIntentDigest("Legacy dispatching item", []), routeIdentity, "dispatching", "2026-11-01T10:00:02.000Z",
      null, null, null, null, null);
    insertQueue.run(blockedId, liveConvId, "Blocked with invalid route", "[]",
      queuedIntentDigest("Blocked with invalid route", []), "not-json", "blocked", "2026-11-01T10:00:03.000Z",
      "Blocked detail", null, null, null, null);
    insertQueue.run(unreadWaitingRowId, liveConvId, "Unread web follow-up", "[]",
      queuedIntentDigest("Unread web follow-up", []), routeIdentity, "waiting", "2026-11-01T10:00:04.000Z",
      null, null, unreadWebMsgId, null, null);
    insertQueue.run(unreadBlockedRowId, liveConvId, "Unread mobile follow-up", "[]",
      queuedIntentDigest("Unread mobile follow-up", []), routeIdentity, "blocked", "2026-11-01T10:00:05.000Z",
      "Route changed", null, unreadMobileMsgId, null, null);
    insertQueue.run(watcherId, liveConvId, "Watcher note body", "[]",
      queuedIntentDigest("Watcher note body", []), routeIdentity, "waiting", "2026-11-01T10:00:06.000Z",
      null, null, null, JSON.stringify(note), null);
    insertQueue.run(rolledBackRowId, liveConvId, "Rolled back unread", "[]",
      queuedIntentDigest("Rolled back unread", []), routeIdentity, "waiting", "2026-11-01T10:00:07.000Z",
      null, null, rolledBackFollowUpId, null, null);
    insertQueue.run(delegatedId, liveConvId, "Delegated summary", "[]",
      queuedIntentDigest("Delegated summary", []), routeIdentity, "waiting", "2026-11-01T10:00:02.500Z",
      null, null, null, null, JSON.stringify(delegated));
    insertQueue.run(acceptedId, liveConvId, "", "[]",
      queuedIntentDigest("Accepted", []), routeIdentity, "accepted", "2026-11-01T09:59:00.000Z",
      null, turnId, turnPromptId, null, null);
    insertQueue.run(cancelledId, liveConvId, "", "[]",
      queuedIntentDigest("Cancelled", []), routeIdentity, "cancelled", "2026-11-01T09:58:00.000Z",
      null, null, null, null, null);

    // Seed receipts: live chat, deleted chat, deleted project.
    const insertReceipt = db.prepare(`INSERT INTO orchestration_v2_receipts
      (actor_id, command_id, thread_id, project_id, fingerprint, result_json, created_at, status, command_type)
      VALUES ('human', ?, ?, ?, 'fp', 'null', ?, 'accepted', 'message.send')`);
    insertReceipt.run("live-receipt", liveConvId, projectId, now);
    insertReceipt.run("deleted-chat-receipt", deletedConvId, projectId, now);
    insertReceipt.run("deleted-project-receipt", randomUUID(), deletedProjectId, now);

    // Run Migration 130.
    migrateRuntimeDatabase(db);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v)
      .toBe(CURRENT_DATABASE_SCHEMA_VERSION);

    // Check receipt purge kept live receipt and deleted orphans.
    expect(db.prepare("SELECT command_id FROM orchestration_v2_receipts ORDER BY command_id").all())
      .toEqual([{ command_id: "live-receipt" }]);

    // Check backfilled columns.
    const row = (id: string) => db.prepare("SELECT * FROM queued_messages WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row(waitingId)).toMatchObject({
      kind: "message",
      queue_position: 1,
      queue_held: 0,
      created_by: "user",
      creation_source: "web",
      follows_thread_selection: 0,
      creation_digest: queuedIntentDigest("Waiting user item", imageAtt as never),
      selection_json: JSON.stringify(selection),
    });
    expect(row(dispatchingId)).toMatchObject({ kind: "message", queue_position: 2 });
    expect(row(blockedId)).toMatchObject({ kind: "message", queue_position: 3, selection_json: null });
    expect(row(unreadWaitingRowId)).toMatchObject({
      kind: "message",
      queue_position: 4,
      steer_follow_up_of_run_id: runId,
      created_by: "user",
      creation_source: "web",
      device_id: null,
    });
    expect(row(unreadBlockedRowId)).toMatchObject({
      kind: "message",
      queue_position: 5,
      steer_follow_up_of_run_id: runId,
      created_by: "user",
      creation_source: "mobile",
      device_id: mobileDeviceId,
    });
    expect(row(watcherId)).toMatchObject({
      kind: "watcher-note",
      queue_position: 6,
      follows_thread_selection: 1,
      created_by: "system",
      creation_source: "server",
      selection_json: null,
    });
    expect(row(rolledBackRowId)).toMatchObject({
      kind: "message",
      queue_position: 7,
      steer_follow_up_of_run_id: rolledBackRunId,
    });
    expect(row(delegatedId)).toMatchObject({
      kind: "delegated-results",
      queue_position: null,
      follows_thread_selection: 1,
      created_by: "system",
      creation_source: "server",
      selection_json: null,
    });
    expect(row(acceptedId)).toMatchObject({ queue_position: null, steer_follow_up_of_run_id: null });
    expect(row(cancelledId)).toMatchObject({ queue_position: null });

    // Check CHECK constraints on new columns.
    expect(() => db.prepare("UPDATE queued_messages SET queue_position = 0 WHERE id = ?").run(waitingId)).toThrow(/CHECK/u);
    expect(() => db.prepare("UPDATE queued_messages SET kind = 'invalid' WHERE id = ?").run(waitingId)).toThrow(/CHECK/u);
    expect(() => db.prepare("UPDATE queued_messages SET created_by = 'nobody' WHERE id = ?").run(waitingId)).toThrow(/CHECK/u);
    expect(() => db.prepare("UPDATE queued_messages SET creation_source = 'cli' WHERE id = ?").run(waitingId)).toThrow(/CHECK/u);
    expect(() => db.prepare("UPDATE queued_messages SET delivery_mode = 'invalid' WHERE id = ?").run(waitingId)).toThrow(/CHECK/u);
    expect(() => db.prepare("UPDATE queued_messages SET selection_json = '[]' WHERE id = ?").run(waitingId)).toThrow(/CHECK/u);

    // Re-running Migration 130 is idempotent.
    const up = queueItemsMigration.up as (database: Database.Database) => void;
    expect(() => up(db)).not.toThrow();
    db.close();

    // Open through RuntimeStore and run boot adoption.
    const store = new RuntimeStore(path, directory, { recoverInterruptedRuns: false });
    try {
      const storeDb = (store as unknown as { database: Database.Database }).database;
      // Re-seed rolled-back-turn entity if projection maintenance rebuilt from empty events.
      storeDb.prepare(`INSERT OR REPLACE INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
        VALUES ('rolled-back-turn', ?, ?, ?, 1, ?)`).run(
        rolledBackTurnId, projectId, liveConvId, JSON.stringify({ turnId: rolledBackTurnId, rollbackId: randomUUID() }),
      );

      const firstAdopt = store.orchestration.queue.adoptLegacyRows();
      expect(firstAdopt.cancelled).toEqual([rolledBackRowId]);
      expect(firstAdopt.releasedDispatching).toEqual([dispatchingId]);
      expect(firstAdopt.adopted).toEqual([
        waitingId,
        dispatchingId,
        blockedId,
        unreadWaitingRowId,
        unreadBlockedRowId,
        watcherId,
        delegatedId,
      ]);

      // Legacy dispatching row was released to waiting.
      expect(store.orchestration.queue.getItem(dispatchingId)?.state).toBe("waiting");
      expect(store.queuedMessages.get(liveConvId, dispatchingId)?.state).toBe("waiting");
      // Rolled-back unread row was cancelled as stale.
      expect(store.orchestration.queue.getItem(rolledBackRowId)).toMatchObject({ state: "cancelled", cancelReason: "stale" });
      expect(store.queuedMessages.get(liveConvId, rolledBackRowId)?.state).toBe("cancelled");

      // Active delivery order merges delegated (t=02.5s) between dispatching (t=02s) and blocked (t=03s).
      const active = store.orchestration.queue.listActive(liveConvId);
      expect(active.map(({ id }) => id)).toEqual([
        waitingId,
        dispatchingId,
        delegatedId,
        blockedId,
        unreadWaitingRowId,
        unreadBlockedRowId,
        watcherId,
      ]);

      // Second adoption is a clean no-op.
      const secondAdopt = store.orchestration.queue.adoptLegacyRows();
      expect(secondAdopt.adopted).toEqual([]);
      expect(secondAdopt.cancelled).toEqual([]);

      // G6 rebuild reproduces identical queue-item and queue-state projections.
      const before = storeDb.prepare(`SELECT kind, id, payload_json FROM orchestration_v2_entities
        WHERE kind IN (?, ?) ORDER BY kind, id`).all(QUEUE_ITEM_PROJECTION, QUEUE_STATE_PROJECTION);
      store.orchestration.events.rebuildProjections();
      const after = storeDb.prepare(`SELECT kind, id, payload_json FROM orchestration_v2_entities
        WHERE kind IN (?, ?) ORDER BY kind, id`).all(QUEUE_ITEM_PROJECTION, QUEUE_STATE_PROJECTION);
      expect(after).toEqual(before);

      const verified = store.orchestration.events.verify({ readable: true });
      expect(verified.valid).toBe(true);
      expect(verified.unreadable).toEqual([]);
      expect(verified.queueContentMismatches).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("S21: normalizes legacy built-in antigravity-cli queued route_identity to antigravity-acp during v122->v131 upgrade", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-m131-agy-"));
    directories.push(directory);
    const path = join(directory, "inertia.sqlite");
    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    migrateRuntimeDatabase(db, 122);

    const now = "2026-11-01T10:00:00.000Z";
    const projectId = randomUUID();
    const convId = randomUUID();
    const queuedId = randomUUID();
    const legacySelection = {
      harnessId: "antigravity-cli",
      backendProfileId: "builtin:antigravity",
      backendProfileDisplayName: "Google Antigravity",
      modelId: "provider-default",
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 0,
    };
    db.prepare(`INSERT INTO projects (id, name, path, normalized_path, repository_relative_path, git_repository_limit, color, status, created_at, updated_at)
      VALUES (?, 'AgyProj', ?, ?, '.', 16, '#6f76d9', 'ready', ?, ?)`).run(projectId, directory, directory, now, now);
    db.prepare(`INSERT INTO conversations (id, project_id, title, provider_id, model_selection_json, model, reasoning_effort,
      interaction_mode, access_mode, created_at, updated_at)
      VALUES (?, ?, 'Antigravity chat', 'antigravity', ?, 'provider-default', '', 'build', 'supervised', ?, ?)`).run(
      convId, projectId, JSON.stringify(legacySelection), now, now,
    );
    const legacyRoute = JSON.stringify([projectId, null, "antigravity", legacySelection, "provider-default", "", "build", "supervised"]);
    db.prepare(`INSERT INTO queued_messages (id, conversation_id, content, attachments_json, intent_digest, route_identity, state, created_at)
      VALUES (?, ?, 'Pending Antigravity prompt', '[]', ?, ?, 'waiting', ?)`).run(
      queuedId, convId, "a".repeat(64), legacyRoute, now,
    );

    migrateRuntimeDatabase(db);
    const row = db.prepare("SELECT selection_json, route_identity FROM queued_messages WHERE id = ?").get(queuedId) as {
      selection_json: string;
      route_identity: string;
    };
    expect(JSON.parse(row.selection_json)).toMatchObject({
      harnessId: "antigravity-acp",
      backendProfileId: "builtin:antigravity",
    });
    expect(JSON.parse(row.route_identity)[3]).toMatchObject({
      harnessId: "antigravity-acp",
      backendProfileId: "builtin:antigravity",
    });
    db.close();
  });
});
