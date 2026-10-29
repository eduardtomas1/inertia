import type { DatabaseMigrationDefinition } from "./catalog";

export const ORCHESTRATION_V2_SCHEMA_VERSION = 107;

export const orchestrationV2Migration: DatabaseMigrationDefinition = {
  name: "OrchestrationV2EventStore",
  up: `
    CREATE TABLE orchestration_v2_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      command_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)
        AND length(CAST(payload_json AS BLOB)) <= 1048576),
      UNIQUE(thread_id, revision)
    );
    CREATE INDEX orchestration_v2_events_project
      ON orchestration_v2_events(project_id, sequence);
    CREATE TABLE orchestration_v2_entities (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)
        AND length(CAST(payload_json AS BLOB)) <= 1048576),
      PRIMARY KEY(kind, id)
    );
    CREATE INDEX orchestration_v2_entities_thread
      ON orchestration_v2_entities(thread_id, kind, id);
    CREATE INDEX orchestration_v2_entities_project
      ON orchestration_v2_entities(project_id, kind, id);
    CREATE TABLE orchestration_v2_receipts (
      actor_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      first_sequence INTEGER,
      last_sequence INTEGER,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)
        AND length(CAST(result_json AS BLOB)) <= 262144),
      created_at TEXT NOT NULL,
      PRIMARY KEY(actor_id, command_id)
    );
    CREATE TABLE orchestration_v2_effects (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL REFERENCES orchestration_v2_events(sequence),
      kind TEXT NOT NULL,
      replay_policy TEXT NOT NULL CHECK (replay_policy IN ('process-bound','replay-safe')),
      runtime_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','failed','retired')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at TEXT NOT NULL,
      claim_id TEXT,
      claimed_at TEXT,
      settled_at TEXT,
      failure_code TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)
        AND length(CAST(payload_json AS BLOB)) <= 1048576),
      CHECK ((state = 'running' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
        OR (state <> 'running' AND claim_id IS NULL AND claimed_at IS NULL))
    );
    CREATE INDEX orchestration_v2_effects_dispatch
      ON orchestration_v2_effects(state, available_at, sequence);
    CREATE INDEX orchestration_v2_effects_thread
      ON orchestration_v2_effects(thread_id, sequence, state);
  `,
};
