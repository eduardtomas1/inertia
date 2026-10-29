import type { DatabaseMigrationDefinition } from "./catalog";

export const AGENT_SECRET_REQUESTS_SCHEMA_VERSION = 108;

export const agentSecretRequestsMigration: DatabaseMigrationDefinition = {
  name: "PersistAgentSecretRequests",
  up: `
    ALTER TABLE messages ADD COLUMN secret_request_json TEXT
      CHECK (secret_request_json IS NULL OR (role = 'system'
        AND length(secret_request_json) BETWEEN 1 AND 2048 AND json_valid(secret_request_json)));
    CREATE TABLE IF NOT EXISTS agent_secret_requests (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL CHECK (length(run_id) = 36),
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 600),
      file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 64),
      file_token TEXT CHECK (file_token IS NULL OR (length(file_token) = 32 AND file_token NOT GLOB '*[^0-9a-f]*')),
      ttl_hours INTEGER NOT NULL CHECK (ttl_hours BETWEEN 1 AND 24),
      status TEXT NOT NULL CHECK (status IN ('pending','saved','declined','ended','expired','revoked')),
      vaulted INTEGER NOT NULL DEFAULT 0 CHECK (vaulted IN (0, 1)),
      created_at TEXT NOT NULL, answered_at TEXT, expires_at TEXT,
      CHECK (status <> 'saved' OR (file_token IS NOT NULL AND expires_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS agent_secret_requests_status_expiry_idx ON agent_secret_requests(status, expires_at);
    CREATE INDEX IF NOT EXISTS agent_secret_requests_conversation_idx ON agent_secret_requests(conversation_id);
  `,
};
