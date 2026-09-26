import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ClientCommand, MessageSendAcceptance, ServerEvent } from "../../shared/contracts";
import { parseServerEvent } from "../../shared/contracts/server-event-schema";
export class MessageSendReceiptError extends Error {}

interface ReceiptRow {
  conversation_id: string; fingerprint: string;
  status: "dispatching" | "accepted" | "rejected" | "uncertain";
  response_json: string | null;
}
type SendCommand = Extract<ClientCommand, { type: "message.send" }>;

/** No prompt text is retained: identities bind to a digest and an acknowledgement. */
export class MessageSendReceiptRepository {
  constructor(private readonly database: Database.Database) {}

  begin(command: SendCommand): ServerEvent | null {
    return this.database.transaction(() => {
      const fingerprint = createHash("sha256").update(JSON.stringify(command.payload)).digest("hex");
      const row = this.read(command.requestId);
      if (row && (row.fingerprint !== fingerprint || row.conversation_id !== command.payload.conversationId)) {
        throw new MessageSendReceiptError("This send identity already belongs to a different message.");
      }
      if (row?.status === "accepted") return this.response(row);
      if (row && row.status !== "rejected") {
        throw new MessageSendReceiptError("This message may already have reached the provider. Check this chat before sending new work.");
      }
      this.database.prepare(`INSERT INTO message_send_receipts (request_id, conversation_id, fingerprint, status, updated_at)
        VALUES (?, ?, ?, 'dispatching', ?) ON CONFLICT(request_id) DO UPDATE SET status = 'dispatching', updated_at = excluded.updated_at`)
        .run(command.requestId, command.payload.conversationId, fingerprint, new Date().toISOString());
      return null;
    })();
  }

  accept(requestId: string, response: ServerEvent): void {
    this.database.prepare("UPDATE message_send_receipts SET status = 'accepted', response_json = ?, updated_at = ? WHERE request_id = ? AND status = 'dispatching'")
      .run(JSON.stringify(response), new Date().toISOString(), requestId);
  }

  fail(requestId: string, uncertain: boolean): void {
    this.database.prepare("UPDATE message_send_receipts SET status = ?, updated_at = ? WHERE request_id = ? AND status = 'dispatching'")
      .run(uncertain ? "uncertain" : "rejected", new Date().toISOString(), requestId);
  }

  accepted(requestId: string, conversationId: string): MessageSendAcceptance | null {
    const row = this.read(requestId);
    if (row?.status !== "accepted" || row.conversation_id !== conversationId) return null;
    const response = this.response(row);
    return response.type === "request.result" && response.result.kind === "message.accepted" ? response.result : null;
  }

  recoverInterrupted(): void {
    this.database.prepare("UPDATE message_send_receipts SET status = 'uncertain', updated_at = ? WHERE status = 'dispatching'")
      .run(new Date().toISOString());
  }

  private read(id: string): ReceiptRow | undefined {
    return this.database.prepare("SELECT conversation_id, fingerprint, status, response_json FROM message_send_receipts WHERE request_id = ?").get(id) as ReceiptRow | undefined;
  }

  private response(row: ReceiptRow): ServerEvent {
    try {
      const response = parseServerEvent(JSON.parse(row.response_json ?? "null"));
      if (response.type === "request.ok" || (response.type === "request.result" && response.result.kind === "message.accepted")) return response;
    } catch { /* A corrupt receipt must never permit a new delivery. */ }
    throw new MessageSendReceiptError("The saved send receipt could not be read. Check this chat before retrying.");
  }
}
