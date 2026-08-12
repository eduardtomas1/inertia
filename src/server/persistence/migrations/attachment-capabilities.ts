import {
  parseAttachments,
  rendererSafeAttachments,
} from "../codecs";
import type { DatabaseMigrationDefinition } from "./catalog";

export const sanitizePersistedAttachmentCapabilities: DatabaseMigrationDefinition = {
  name: "SanitizePersistedAttachmentCapabilities",
  up: (database) => {
    const messages = database.prepare(`
      SELECT id, attachments_json
      FROM messages
      WHERE attachments_json <> '[]'
    `).all() as Array<{ id: string; attachments_json: string }>;
    const update = database.prepare(`
      UPDATE messages
      SET attachments_json = ?
      WHERE id = ?
    `);
    for (const message of messages) {
      update.run(
        JSON.stringify(rendererSafeAttachments(
          parseAttachments(message.attachments_json),
        )),
        message.id,
      );
    }
  },
};
