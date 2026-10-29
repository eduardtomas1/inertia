import type { DatabaseMigrationDefinition } from "./catalog";

export const CUSTOM_AGENTS_SCHEMA_VERSION = 107;

export const customAgentsMigration: DatabaseMigrationDefinition = {
  name: "PersistCustomAgents",
  up: `
    CREATE TABLE IF NOT EXISTS custom_agents (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      name TEXT NOT NULL
        CHECK (
          length(name) BETWEEN 1 AND 60
          AND trim(name) <> ''
          AND instr(name, char(0)) = 0
          AND instr(name, char(10)) = 0
          AND instr(name, char(13)) = 0
        ),
      handle TEXT NOT NULL UNIQUE
        CHECK (
          length(handle) BETWEEN 1 AND 32
          AND handle NOT GLOB '*[^a-z0-9-]*'
          AND handle NOT GLOB '-*'
          AND handle NOT GLOB '*-'
          AND instr(handle, '--') = 0
        ),
      description TEXT NOT NULL DEFAULT ''
        CHECK (
          length(description) <= 200
          AND instr(description, char(0)) = 0
          AND instr(description, char(10)) = 0
          AND instr(description, char(13)) = 0
        ),
      icon_json TEXT NOT NULL
        CHECK (
          json_valid(icon_json)
          AND json_type(icon_json) = 'object'
          AND length(CAST(icon_json AS BLOB)) <= 49152
        ),
      accent TEXT CHECK (accent IS NULL OR length(accent) BETWEEN 1 AND 32),
      blocks_json TEXT NOT NULL DEFAULT '[]'
        CHECK (
          json_valid(blocks_json)
          AND json_type(blocks_json) = 'array'
          AND json_array_length(blocks_json) <= 16
          AND length(CAST(blocks_json AS BLOB)) <= 400000
        ),
      skills_json TEXT NOT NULL DEFAULT '[]'
        CHECK (
          json_valid(skills_json)
          AND json_type(skills_json) = 'array'
          AND json_array_length(skills_json) <= 8
          AND length(CAST(skills_json AS BLOB)) <= 8192
        ),
      position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 39),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
      updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
    );
    CREATE INDEX IF NOT EXISTS custom_agents_position_idx
      ON custom_agents(position ASC, id ASC);
    CREATE TRIGGER IF NOT EXISTS custom_agents_count_limit
      BEFORE INSERT ON custom_agents
      WHEN (SELECT COUNT(*) FROM custom_agents) >= 40
      BEGIN
        SELECT RAISE(ABORT, 'custom agent count limit exceeded');
      END;
    ALTER TABLE messages ADD COLUMN custom_agent_call_json TEXT
      CHECK (custom_agent_call_json IS NULL OR (
        role = 'user' AND json_valid(custom_agent_call_json)
        AND json_type(custom_agent_call_json) = 'object'
        AND length(CAST(custom_agent_call_json AS BLOB)) <= 65536
      ));
    ALTER TABLE subagent_traces ADD COLUMN custom_agent_id TEXT
      CHECK (custom_agent_id IS NULL OR length(custom_agent_id) = 36);
  `,
};
