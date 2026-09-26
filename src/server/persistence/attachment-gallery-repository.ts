import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { ATTACHMENT_GALLERY_PAGE_SIZE, attachmentGalleryResultSchema, type AttachmentGalleryResult } from "../../shared/attachment-gallery";

const cursorSchema = z.strictObject({
  conversationId: z.string().uuid(), watermark: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  direction: z.enum(["older", "newer"]),
  boundary: z.tuple([z.string().min(1).max(100), z.string().min(1).max(512), z.number().int().nonnegative()]),
});
type Cursor = z.infer<typeof cursorSchema>;
interface GalleryRow { id: string; name: string; mimeType: string; size: number; at: string; messageId: string; position: number }
export class AttachmentGalleryError extends Error {}

/** Independent gallery metadata; never reads message content, paths, or snapshot context. */
export class AttachmentGalleryRepository {
  private readonly secret = randomBytes(32);
  constructor(private readonly database: Database.Database) {}

  list(conversationId: string, token?: string): AttachmentGalleryResult {
    return this.database.transaction(() => {
      if (!this.database.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId)) throw new AttachmentGalleryError("This chat is no longer available.");
      const cursor = token ? this.decode(token, conversationId) : null;
      const watermark = cursor?.watermark ?? (this.database.prepare("SELECT COALESCE(MAX(rowid), 0) AS id FROM messages WHERE conversation_id = ?").get(conversationId) as { id: number }).id;
      const direction = cursor?.direction ?? "older";
      const order = direction === "older" ? "DESC" : "ASC";
      // Deduplicate by retained attachment identity using metadata only. SQL
      // bounds every projected string before any rows reach the JS heap.
      const rows = this.database.prepare(`WITH occurrences AS (
        SELECT json_extract(item.value, '$.id') AS id,
          substr(json_extract(item.value, '$.name'), 1, 512) AS name,
          substr(json_extract(item.value, '$.mimeType'), 1, 128) AS mimeType,
          CASE WHEN json_type(item.value, '$.size') = 'integer' THEN json_extract(item.value, '$.size') ELSE NULL END AS size,
          substr(message.created_at, 1, 100) AS at, substr(message.id, 1, 512) AS messageId,
          CAST(item.key AS INTEGER) AS position,
          ROW_NUMBER() OVER (PARTITION BY json_extract(item.value, '$.id')
            ORDER BY message.created_at DESC, message.id DESC, CAST(item.key AS INTEGER) DESC) AS occurrence
        FROM messages AS message, json_each(CASE WHEN json_valid(message.attachments_json) THEN message.attachments_json ELSE '[]' END) AS item
        WHERE message.conversation_id = ? AND message.role = 'user' AND message.rowid <= ?
          AND item.type = 'object'
          AND length(json_extract(item.value, '$.id')) = 36
      ) SELECT id, name, mimeType, size, at, messageId, position FROM occurrences
        WHERE occurrence = 1 ${cursor ? `AND (at, messageId, position) ${direction === "older" ? "<" : ">"} (?, ?, ?)` : ""}
        ORDER BY at ${order}, messageId ${order}, position ${order} LIMIT ?`)
        .all(conversationId, watermark, ...(cursor?.boundary ?? []), ATTACHMENT_GALLERY_PAGE_SIZE + 1) as GalleryRow[];
      const more = rows.length > ATTACHMENT_GALLERY_PAGE_SIZE;
      const page = rows.slice(0, ATTACHMENT_GALLERY_PAGE_SIZE);
      if (direction === "newer") page.reverse();
      const boundary = (row: GalleryRow): Cursor["boundary"] => [row.at, row.messageId, row.position];
      const encode = (row: GalleryRow, next: Cursor["direction"]) => this.encode({ conversationId, watermark, direction: next, boundary: boundary(row) });
      return attachmentGalleryResultSchema.parse({
        kind: "conversation.attachments", conversationId,
        attachments: page.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
        olderCursor: page.length && (direction === "older" ? more : true) ? encode(page.at(-1)!, "older") : null,
        newerCursor: page.length && (direction === "newer" ? more : cursor !== null) ? encode(page[0]!, "newer") : null,
      });
    })();
  }

  private encode(cursor: Cursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    return `${payload}.${createHmac("sha256", this.secret).update(payload).digest("base64url")}`;
  }

  private decode(token: string, conversationId: string): Cursor {
    if (token.length > 4096) throw new AttachmentGalleryError("This attachment page is invalid. Load newest attachments again.");
    const [payload, signature, extra] = token.split(".");
    const expected = createHmac("sha256", this.secret).update(payload ?? "").digest();
    const supplied = Buffer.from(signature ?? "", "base64url");
    if (extra !== undefined || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AttachmentGalleryError("This attachment page has expired. Load newest attachments again.");
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (cursor.conversationId !== conversationId) throw new AttachmentGalleryError("This attachment page belongs to another chat.");
    return cursor;
  }
}
