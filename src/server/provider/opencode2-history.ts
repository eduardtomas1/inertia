import { objectValue, type JsonObject } from "../codex/protocol";
import type { OpenCode2Client } from "./opencode2-client";

export type OpenCode2Api = Pick<OpenCode2Client, "request">;
export function openCode2Id(value: unknown, prefix: "ses_" | "msg_"): value is string {
  return typeof value === "string" && value.startsWith(prefix) && value.length <= 512 && /^[a-zA-Z0-9_-]+$/u.test(value);
}
export function openCode2Data(value: unknown): unknown {
  const envelope = objectValue(value);
  if (!envelope || !("data" in envelope)) throw new Error("Invalid OpenCode 2 response envelope.");
  return envelope.data;
}
export function openCode2SessionPath(sessionId: string): string {
  if (!openCode2Id(sessionId, "ses_")) throw new Error("Invalid OpenCode 2 session identity.");
  return `/api/session/${encodeURIComponent(sessionId)}`;
}
export async function readOpenCode2History(client: OpenCode2Api, sessionId: string): Promise<JsonObject[]> {
  const result: JsonObject[] = []; const identities = new Set<string>(); const cursors = new Set<string>();
  let cursor: string | undefined; let bytes = 0;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "200", ...(cursor === undefined ? { order: "asc" } : { cursor }) });
    const response = objectValue(await client.request("GET", `${openCode2SessionPath(sessionId)}/message?${query}`));
    const data = response?.data; const pagination = objectValue(response?.cursor);
    if (!Array.isArray(data) || data.length > 200 || !pagination) throw new Error("Invalid OpenCode 2 history page.");
    bytes += Buffer.byteLength(JSON.stringify(data), "utf8");
    if (bytes > 32 * 1024 * 1024) throw new Error("OpenCode 2 history exceeded its safety limit.");
    for (const raw of data) {
      const message = objectValue(raw);
      if (!message || !openCode2Id(message.id, "msg_") || identities.has(message.id)
        || typeof message.type !== "string" || message.type.length > 64) throw new Error("Invalid OpenCode 2 history identity.");
      // Preserve native and newer compaction payloads without inventing missing fields.
      identities.add(message.id); result.push(message);
    }
    if (pagination.next === undefined) return result;
    if (!data.length || typeof pagination.next !== "string" || !pagination.next || pagination.next.length > 16_384
      || cursors.has(pagination.next)) throw new Error("Invalid OpenCode 2 history cursor.");
    cursors.add(pagination.next); cursor = pagination.next;
  }
  throw new Error("OpenCode 2 history exceeded its page limit.");
}

export function openCode2SettledMessage(message: JsonObject): boolean {
  if (message.type === "idle") return ["succeeded", "failed", "interrupted"].includes(String(message.outcome));
  if (message.type === "compaction") return message.status === "completed" || message.status === "failed";
  return message.type === "assistant" && typeof objectValue(message.time)?.completed === "number"
    && Array.isArray(message.content) && message.content.every((raw) => {
      const item = objectValue(raw);
      return item && (item.type !== "tool" || ["completed", "error", "succeeded", "failed"].includes(String(objectValue(item.state)?.status)));
    });
}
