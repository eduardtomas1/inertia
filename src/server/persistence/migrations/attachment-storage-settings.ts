import type { DatabaseMigrationDefinition } from "./catalog";

export const attachmentStorageSettingsMigration: DatabaseMigrationDefinition = {
  name: "PersistAttachmentStorageSettings",
  up: (database) => {
    const columns = new Set((database.prepare("PRAGMA table_info(app_state)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("attachment_storage_gib")) database.exec(`
      ALTER TABLE app_state ADD COLUMN attachment_storage_gib INTEGER NOT NULL DEFAULT 16
        CHECK (attachment_storage_gib IN (2, 4, 8, 16, 32, 64));
    `);
    if (!columns.has("auto_remove_old_attachments")) database.exec(`
      ALTER TABLE app_state ADD COLUMN auto_remove_old_attachments INTEGER NOT NULL DEFAULT 0
        CHECK (auto_remove_old_attachments IN (0, 1));
    `);
  },
};
