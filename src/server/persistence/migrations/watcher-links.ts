import type { DatabaseMigrationDefinition } from "./catalog";

/**
 * Schema v99: read-only watcher links and their checks. The migration is one
 * self-contained statement list so its lineage digest needs no helper source.
 * `agent_context_reads` is rebuilt to admit the `watched` access kind.
 */
export const watcherLinksMigration: DatabaseMigrationDefinition = {
  name: "PersistWatcherLinks",
  foreignKeys: "off",
  up: `
    CREATE TABLE watcher_links (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      watcher_conversation_id TEXT NOT NULL UNIQUE
        REFERENCES conversations(id) ON DELETE CASCADE
        CHECK (length(watcher_conversation_id) = 36),
      watched_conversation_id TEXT
        REFERENCES conversations(id) ON DELETE SET NULL
        CHECK (watched_conversation_id IS NULL OR length(watched_conversation_id) = 36),
      project_id TEXT NOT NULL
        REFERENCES projects(id) ON DELETE CASCADE
        CHECK (length(project_id) = 36),
      preset TEXT NOT NULL CHECK (preset IN ('reviewer', 'scope-guard', 'explainer')),
      instructions TEXT NOT NULL DEFAULT ''
        CHECK (length(instructions) <= 2000 AND instr(instructions, char(0)) = 0),
      sharing_json TEXT NOT NULL CHECK (
        json_valid(sharing_json) AND json_type(sharing_json) = 'object'
        AND length(CAST(sharing_json AS BLOB)) <= 512
      ),
      budgets_json TEXT NOT NULL CHECK (
        json_valid(budgets_json) AND json_type(budgets_json) = 'object'
        AND length(CAST(budgets_json AS BLOB)) <= 512
      ),
      private_connect TEXT NOT NULL DEFAULT 'inherit'
        CHECK (private_connect IN ('inherit', 'hidden')),
      delivery TEXT NOT NULL DEFAULT 'manual' CHECK (delivery IN ('manual', 'auto')),
      status TEXT NOT NULL
        CHECK (status IN ('watching', 'waking', 'idle', 'paused', 'detached')),
      pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN (
        'user', 'wake-budget', 'usage-limit', 'write-detected', 'write-attempts',
        'route-unavailable', 'watched-archived', 'watcher-archived'
      )),
      pause_detail TEXT CHECK (
        pause_detail IS NULL OR (length(pause_detail) <= 1000 AND instr(pause_detail, char(0)) = 0)
      ),
      detached_reason TEXT CHECK (
        detached_reason IS NULL OR detached_reason IN ('user', 'watched-deleted')
      ),
      cursor_turn_id TEXT CHECK (cursor_turn_id IS NULL OR length(cursor_turn_id) BETWEEN 1 AND 200),
      cursor_activity_at TEXT CHECK (
        cursor_activity_at IS NULL OR length(cursor_activity_at) BETWEEN 20 AND 40
      ),
      cursor_activity_id TEXT CHECK (
        cursor_activity_id IS NULL OR length(cursor_activity_id) BETWEEN 1 AND 200
      ),
      cursor_message_at TEXT CHECK (
        cursor_message_at IS NULL OR length(cursor_message_at) BETWEEN 20 AND 40
      ),
      pending_running_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(pending_running_ids_json) AND json_type(pending_running_ids_json) = 'array'
        AND json_array_length(pending_running_ids_json) <= 64
        AND length(CAST(pending_running_ids_json AS BLOB)) <= 16384
      ),
      wakes_this_turn INTEGER NOT NULL DEFAULT 0 CHECK (wakes_this_turn >= 0),
      wake_allowance INTEGER NOT NULL DEFAULT 0 CHECK (wake_allowance >= 0),
      write_attempts_this_turn INTEGER NOT NULL DEFAULT 0 CHECK (write_attempts_this_turn >= 0),
      command_attempts_this_turn INTEGER NOT NULL DEFAULT 0 CHECK (command_attempts_this_turn >= 0),
      wakes_total INTEGER NOT NULL DEFAULT 0 CHECK (wakes_total >= 0),
      events_seen INTEGER NOT NULL DEFAULT 0 CHECK (events_seen >= 0),
      events_pending INTEGER NOT NULL DEFAULT 0 CHECK (events_pending >= 0),
      findings_total INTEGER NOT NULL DEFAULT 0 CHECK (findings_total >= 0),
      final_pass_turn_id TEXT CHECK (
        final_pass_turn_id IS NULL OR length(final_pass_turn_id) BETWEEN 1 AND 200
      ),
      last_wake_at TEXT CHECK (last_wake_at IS NULL OR length(last_wake_at) BETWEEN 20 AND 40),
      last_watched_output_at TEXT CHECK (
        last_watched_output_at IS NULL OR length(last_watched_output_at) BETWEEN 20 AND 40
      ),
      quiet_since TEXT CHECK (quiet_since IS NULL OR length(quiet_since) BETWEEN 20 AND 40),
      feed_revision INTEGER NOT NULL DEFAULT 0 CHECK (feed_revision >= 0),
      created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
      updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
      CHECK (watched_conversation_id IS NULL OR watched_conversation_id <> watcher_conversation_id),
      CHECK (watched_conversation_id IS NOT NULL OR status = 'detached'),
      CHECK ((status = 'paused') = (pause_reason IS NOT NULL)),
      CHECK (pause_detail IS NULL OR status = 'paused'),
      CHECK ((status = 'detached') = (detached_reason IS NOT NULL))
    );
    CREATE UNIQUE INDEX watcher_links_active_watched_idx
      ON watcher_links(watched_conversation_id)
      WHERE status <> 'detached';
    CREATE INDEX watcher_links_project_idx ON watcher_links(project_id, status);

    CREATE TABLE watcher_wakes (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      link_id TEXT NOT NULL
        REFERENCES watcher_links(id) ON DELETE CASCADE
        CHECK (length(link_id) = 36),
      watcher_turn_id TEXT UNIQUE
        REFERENCES agent_turns(id) ON DELETE SET NULL
        CHECK (watcher_turn_id IS NULL OR length(watcher_turn_id) BETWEEN 1 AND 200),
      watched_turn_id TEXT CHECK (
        watched_turn_id IS NULL OR length(watched_turn_id) BETWEEN 1 AND 200
      ),
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      trigger TEXT NOT NULL CHECK (
        trigger IN ('activity', 'plan', 'error', 'turn-end', 'manual', 'initial')
      ),
      state TEXT NOT NULL CHECK (state IN ('dispatching', 'running', 'settled')),
      outcome TEXT CHECK (outcome IS NULL OR outcome IN (
        'silent', 'finding', 'failed', 'cancelled', 'usage-limited', 'permission-declined',
        'write-attempt', 'command-attempt', 'write-detected'
      )),
      events_covered INTEGER NOT NULL DEFAULT 0 CHECK (events_covered >= 0),
      items_truncated INTEGER NOT NULL DEFAULT 0 CHECK (items_truncated >= 0),
      items_omitted INTEGER NOT NULL DEFAULT 0 CHECK (items_omitted >= 0),
      digest_bytes INTEGER NOT NULL DEFAULT 0 CHECK (digest_bytes BETWEEN 0 AND 65536),
      guard_state TEXT CHECK (guard_state IS NULL OR guard_state IN (
        'clean', 'inconclusive', 'changed', 'unavailable', 'skipped'
      )),
      guard_paths_json TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(guard_paths_json) AND json_type(guard_paths_json) = 'array'
        AND length(CAST(guard_paths_json AS BLOB)) <= 8192
      ),
      finding_preview TEXT CHECK (
        finding_preview IS NULL OR length(CAST(finding_preview AS BLOB)) <= 8192
      ),
      finding_message_id TEXT CHECK (
        finding_message_id IS NULL OR length(finding_message_id) BETWEEN 1 AND 200
      ),
      delivery_mode TEXT CHECK (delivery_mode IS NULL OR delivery_mode IN ('queue', 'steer')),
      delivery_state TEXT CHECK (
        delivery_state IS NULL OR delivery_state IN ('queued', 'sent', 'dismissed', 'failed')
      ),
      delivery_detail TEXT CHECK (delivery_detail IS NULL OR length(delivery_detail) <= 1000),
      delivery_id TEXT CHECK (delivery_id IS NULL OR length(delivery_id) = 36),
      delivered_message_id TEXT CHECK (
        delivered_message_id IS NULL OR length(delivered_message_id) BETWEEN 1 AND 200
      ),
      queued_message_id TEXT CHECK (
        queued_message_id IS NULL OR length(queued_message_id) BETWEEN 1 AND 200
      ),
      delivered_at TEXT CHECK (delivered_at IS NULL OR length(delivered_at) BETWEEN 20 AND 40),
      created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
      settled_at TEXT CHECK (settled_at IS NULL OR length(settled_at) BETWEEN 20 AND 40),
      UNIQUE (link_id, sequence),
      CHECK ((state = 'settled') = (outcome IS NOT NULL)),
      CHECK ((state = 'settled') = (settled_at IS NOT NULL)),
      CHECK ((delivery_state IS NULL) = (delivered_at IS NULL)),
      CHECK (delivery_state IS NULL OR finding_preview IS NOT NULL),
      CHECK (delivery_state IS NOT NULL OR (
        delivery_mode IS NULL AND delivery_id IS NULL AND delivery_detail IS NULL
      )),
      CHECK (delivery_state IS NULL OR (delivery_state = 'dismissed') = (delivery_mode IS NULL))
    );
    CREATE INDEX watcher_wakes_link_idx ON watcher_wakes(link_id, sequence DESC);

    ALTER TABLE messages ADD COLUMN watcher_note_json TEXT
      CHECK (watcher_note_json IS NULL OR (
        role = 'user' AND json_valid(watcher_note_json)
        AND json_type(watcher_note_json) = 'object'
        AND length(CAST(watcher_note_json AS BLOB)) <= 1024
      ));
    ALTER TABLE queued_messages ADD COLUMN watcher_note_json TEXT
      CHECK (watcher_note_json IS NULL OR (
        json_valid(watcher_note_json)
        AND json_type(watcher_note_json) = 'object'
        AND length(CAST(watcher_note_json AS BLOB)) <= 1024
      ));

    CREATE TABLE agent_context_reads_v99 (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      target_conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE
        CHECK (length(target_conversation_id) = 36),
      target_turn_id TEXT NOT NULL
        REFERENCES agent_turns(id) ON DELETE CASCADE
        CHECK (length(target_turn_id) BETWEEN 1 AND 200),
      target_user_message_id TEXT NOT NULL
        REFERENCES messages(id) ON DELETE CASCADE
        CHECK (length(target_user_message_id) BETWEEN 1 AND 200),
      source_conversation_id TEXT NOT NULL CHECK (length(source_conversation_id) = 36),
      source_conversation_title TEXT NOT NULL
        CHECK (length(source_conversation_title) BETWEEN 1 AND 120),
      source_turn_id TEXT CHECK (
        source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 200
      ),
      access TEXT NOT NULL CHECK (access IN ('own', 'referenced', 'approved', 'watched')),
      page_count INTEGER NOT NULL CHECK (page_count >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO agent_context_reads_v99 (
      id, target_conversation_id, target_turn_id, target_user_message_id,
      source_conversation_id, source_conversation_title, source_turn_id,
      access, page_count, created_at, updated_at
    )
    SELECT
      id, target_conversation_id, target_turn_id, target_user_message_id,
      source_conversation_id, source_conversation_title, source_turn_id,
      access, page_count, created_at, updated_at
    FROM agent_context_reads;
    DROP TABLE agent_context_reads;
    ALTER TABLE agent_context_reads_v99 RENAME TO agent_context_reads;
    CREATE UNIQUE INDEX agent_context_reads_identity_idx
      ON agent_context_reads(
        target_turn_id,
        source_conversation_id,
        ifnull(source_turn_id, '')
      );
    CREATE INDEX agent_context_reads_target_idx
      ON agent_context_reads(target_conversation_id, target_user_message_id);

    CREATE TRIGGER watcher_links_active_limit
      BEFORE INSERT ON watcher_links
      WHEN NEW.status <> 'detached'
        AND (SELECT COUNT(*) FROM watcher_links WHERE status <> 'detached') >= 8
      BEGIN
        SELECT RAISE(ABORT, 'watcher count limit exceeded');
      END;
    CREATE TRIGGER watcher_links_detached_final
      BEFORE UPDATE OF status ON watcher_links
      WHEN OLD.status = 'detached' AND NEW.status <> 'detached'
      BEGIN
        SELECT RAISE(ABORT, 'A detached watcher cannot be attached again.');
      END;
    CREATE TRIGGER watcher_wakes_retention
      AFTER INSERT ON watcher_wakes
      BEGIN
        DELETE FROM watcher_wakes
        WHERE link_id = NEW.link_id AND sequence <= NEW.sequence - 500;
      END;
    CREATE TRIGGER watcher_links_watched_delete
      BEFORE DELETE ON conversations
      BEGIN
        SELECT RAISE(ABORT, 'Stop the watcher''s current check before deleting this chat.')
        WHERE EXISTS (
          SELECT 1
          FROM watcher_links AS link
          JOIN agent_turns AS turn ON turn.conversation_id = link.watcher_conversation_id
          WHERE link.watched_conversation_id = OLD.id
            AND link.status <> 'detached'
            AND turn.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
        );
        UPDATE watcher_links
        SET status = 'detached',
            detached_reason = CASE
              WHEN status = 'detached' THEN detached_reason ELSE 'watched-deleted'
            END,
            pause_reason = NULL,
            pause_detail = NULL,
            watched_conversation_id = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE watched_conversation_id = OLD.id;
      END;
  `,
};
