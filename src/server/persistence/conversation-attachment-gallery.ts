import type Database from "better-sqlite3";
import { CONVERSATION_ATTACHMENT_GALLERY_LIMIT, isConversationAttachmentGallery,
  type ConversationAttachmentGalleryItem } from "../../shared/conversation-attachment-gallery";

export function conversationAttachmentGallery(database: Database.Database, conversationId: string): ConversationAttachmentGalleryItem[] {
  const rows = database.prepare(`
      SELECT json_extract(item.value, '$.id') AS id,
        json_extract(item.value, '$.name') AS name,
        json_extract(item.value, '$.mimeType') AS mimeType,
        json_extract(item.value, '$.size') AS size
      FROM messages AS message INDEXED BY messages_conversation_created_idx,
        json_each(CASE WHEN json_valid(message.attachments_json) THEN message.attachments_json ELSE '[]' END) AS item
      WHERE message.conversation_id = ? AND message.role = 'user' AND item.type = 'object'
        AND length(json_extract(item.value, '$.id')) BETWEEN 1 AND 200
        AND length(json_extract(item.value, '$.name')) BETWEEN 1 AND 1024
        AND length(json_extract(item.value, '$.mimeType')) BETWEEN 1 AND 200
      ORDER BY message.created_at DESC, message.id DESC, CAST(item.key AS INTEGER) DESC
  `).iterate(conversationId);
  const entries: ConversationAttachmentGalleryItem[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (!isConversationAttachmentGallery([row])) continue;
    const entry = row as ConversationAttachmentGalleryItem;
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    entries.push(entry);
    if (entries.length === CONVERSATION_ATTACHMENT_GALLERY_LIMIT) break;
  }
  return entries;
}
