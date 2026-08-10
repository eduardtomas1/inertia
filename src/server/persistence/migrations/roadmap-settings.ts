import type { DatabaseMigrationDefinition } from "./catalog";

export const roadmapSettingsMigrationDefinitions: readonly DatabaseMigrationDefinition[] = [
  {
    name: "PersistThreadOrganization",
    up: (database) => {
      const conversationColumns = database
        .prepare("PRAGMA table_info(conversations)")
        .all() as Array<{ name: string }>;
      if (!conversationColumns.some(({ name }) => name === "pinned_at")) {
        database.exec("ALTER TABLE conversations ADD COLUMN pinned_at TEXT");
      }
      if (!conversationColumns.some(({ name }) => name === "snoozed_until")) {
        database.exec("ALTER TABLE conversations ADD COLUMN snoozed_until TEXT");
      }
      const stateColumns = database.prepare("PRAGMA table_info(app_state)")
        .all() as Array<{ name: string }>;
      if (!stateColumns.some(({ name }) => name === "desktop_notifications")) {
        database.exec(`
          ALTER TABLE app_state
            ADD COLUMN desktop_notifications INTEGER NOT NULL DEFAULT 1
            CHECK (desktop_notifications IN (0, 1));
        `);
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS conversations_pinned_at_idx
          ON conversations(pinned_at DESC)
          WHERE pinned_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS conversations_snoozed_until_idx
          ON conversations(snoozed_until)
          WHERE snoozed_until IS NOT NULL;
      `);
    },
  },
  {
    name: "PersistProviderIdentityLabels",
    up: (database) => {
      const columns = database.prepare("PRAGMA table_info(app_state)")
        .all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "provider_identity_labels_json")) {
        database.exec(`
          ALTER TABLE app_state
            ADD COLUMN provider_identity_labels_json TEXT NOT NULL DEFAULT '{}'
            CHECK (length(provider_identity_labels_json) <= 1024);
        `);
      }
    },
  },
  {
    name: "PersistCustomKeybindings",
    up: (database) => {
      const columns = database.prepare("PRAGMA table_info(app_state)")
        .all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "keybindings_json")) {
        database.exec(`
          ALTER TABLE app_state
            ADD COLUMN keybindings_json TEXT NOT NULL
            DEFAULT '{"search":"k","new-chat":"n","toggle-sidebar":"b","toggle-terminal":"j"}'
            CHECK (length(keybindings_json) <= 512);
        `);
      }
    },
  },
  {
    name: "PersistFinalAnswerAutoScroll",
    up: (database) => {
      const columns = database.prepare("PRAGMA table_info(app_state)")
        .all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "auto_scroll_to_final_answer")) {
        database.exec(`
          ALTER TABLE app_state
            ADD COLUMN auto_scroll_to_final_answer INTEGER NOT NULL DEFAULT 1
            CHECK (auto_scroll_to_final_answer IN (0, 1));
        `);
      }
    },
  },
];
