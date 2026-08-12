import type Database from "better-sqlite3";

/** Schema 56 removes filesystem capabilities from durable message payloads. */
export function validAttachmentCapabilities(
  database: Database.Database,
): boolean {
  const rows = database.prepare(`
    SELECT attachments_json FROM messages
    WHERE attachments_json <> '[]'
  `).all() as Array<{ attachments_json: unknown }>;
  for (const { attachments_json: encoded } of rows) {
    if (typeof encoded !== "string") return false;
    let attachments: unknown;
    try {
      attachments = JSON.parse(encoded);
    } catch {
      return false;
    }
    if (!Array.isArray(attachments)) return false;
    for (const attachment of attachments) {
      if (
        typeof attachment !== "object"
        || attachment === null
        || !("id" in attachment)
        || typeof attachment.id !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
          .test(attachment.id)
        || !("path" in attachment)
        || attachment.path !== attachment.id
      ) return false;
    }
  }
  return true;
}
