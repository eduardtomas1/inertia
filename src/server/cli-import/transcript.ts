import { CLI_IMPORT_MAX_MESSAGES, CLI_IMPORT_MAX_TEXT, type CliMessage, type CliProvider } from "../../shared/cli-conversations";
import { SECRET_PATTERNS, redactCredentialUrls } from "../../shared/private-connect/credential-redaction";
import { redactHostToolPayload } from "../provider/host-tool-redaction";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    const block = record(entry);
    return ["text", "input_text", "output_text"].includes(String(block.type)) && typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join("\n");
}
function timestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fallback;
  const iso = new Date(parsed).toISOString();
  return /^\d{4}-/u.test(iso) ? iso : fallback;
}
export interface ParsedCliTranscript {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: string;
  messages: CliMessage[];
  omittedMessages: number;
}

/** Select visible main-session text only; never import tools, thinking, images or credentials. */
export function parseCliTranscript(source: string, provider: CliProvider, fallbackDate: string, secrets: readonly string[] = []): ParsedCliTranscript {
  let sessionId = "";
  let cwd = "";
  const messages: Array<CliMessage & { id?: string }> = [];
  const codexTurnStarts: number[] = [];
  const messageIndexes = new Map<string, number>();
  const parents = new Map<string, string | null>();
  let lastId: string | null = null;
  const lines = source.split("\n");
  if (lines.length > 100_000) throw new Error("The CLI transcript has too many records.");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let item: RecordValue;
    try { item = record(JSON.parse(line)); } catch {
      // A CLI can be in the middle of appending its final record.
      if (index === lines.length - 1) break;
      throw new Error("The CLI transcript contains an unreadable record.");
    }
    let role: unknown;
    let content = "";
    let id: string | undefined;
    if (provider === "codex") {
      const payload = record(item.payload);
      if (item.type === "session_meta") {
        if (sessionId && sessionId !== payload.id) throw new Error("The CLI session identity changed.");
        sessionId = typeof payload.id === "string" ? payload.id : "";
        cwd = typeof payload.cwd === "string" ? payload.cwd : "";
        if (record(payload.source).subagent) throw new Error("Subagent sessions are not supported.");
        if (payload.model_provider && payload.model_provider !== "openai") throw new Error("Only native Codex sessions are supported.");
      }
      if (item.type === "event_msg" && payload.type === "thread_rolled_back") {
        let remaining = typeof payload.num_turns === "number" ? payload.num_turns : 0;
        if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("Invalid CLI rollback record.");
        while (codexTurnStarts.length && remaining > 0) {
          messages.length = codexTurnStarts.pop()!;
          remaining -= 1;
        }
        if (remaining > 0) messages.length = 0;
      }
      // event_msg mirrors response_item; selecting one prevents duplicate messages.
      if (item.type !== "response_item" || payload.type !== "message") continue;
      role = payload.role;
      content = textContent(payload.content);
      if (role === "user" && /^(?:# AGENTS\.md instructions|<environment_context>)/u.test(content.trim())) continue;
      // Image-only requests still define turns even though their media is omitted.
      if (role === "user") codexTurnStarts.push(messages.length);
    } else {
      if (item.isSidechain === true) continue;
      if (typeof item.sessionId === "string") {
        if (sessionId && item.sessionId !== sessionId) throw new Error("The CLI session identity changed.");
        sessionId = item.sessionId;
      }
      if (typeof item.cwd === "string" && !cwd) cwd = item.cwd;
      if (typeof item.uuid === "string") {
        id = item.uuid;
        if ("parentUuid" in item) parents.set(id, typeof item.parentUuid === "string" ? item.parentUuid : null);
        if (item.type === "user" || item.type === "assistant") lastId = id;
      }
      if (!["user", "assistant"].includes(String(item.type)) || item.isMeta === true) continue;
      const message = record(item.message);
      role = message.role ?? item.type;
      content = textContent(message.content);
    }
    if ((role !== "user" && role !== "assistant") || !content.trim()) continue;
    let clean = redactCredentialUrls(redactHostToolPayload(content, secrets));
    for (const pattern of SECRET_PATTERNS) clean = clean.replace(pattern, "[redacted credential]");
    clean = clean.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
    const message = { role, content: clean.slice(0, 32 * 1024), createdAt: timestamp(item.timestamp, fallbackDate), ...(id ? { id } : {}) } satisfies CliMessage;
    const existing = id ? messageIndexes.get(id) ?? -1 : -1;
    if (existing >= 0) messages[existing] = message;
    else { if (id) messageIndexes.set(id, messages.length); messages.push(message); }
  }
  if (!uuid.test(sessionId) || !cwd || cwd.includes("\0")) throw new Error("The CLI transcript has no valid session or workspace.");
  let visible = messages;
  if (provider === "claude" && lastId && parents.size) {
    const lineage = new Set<string>();
    let cursor: string | null = lastId;
    while (cursor && !lineage.has(cursor)) { lineage.add(cursor); cursor = parents.get(cursor) ?? null; }
    visible = messages.filter((entry) => !entry.id || lineage.has(entry.id));
  }
  if (visible.length === 0) throw new Error("The CLI transcript has no visible messages.");
  const title = (visible.find((entry) => entry.role === "user")?.content ?? "Imported conversation").replace(/\s+/gu, " ").trim().slice(0, 160);
  const selected: CliMessage[] = [];
  let bytes = 0;
  for (const entry of visible.slice(-CLI_IMPORT_MAX_MESSAGES).reverse()) {
    const size = Buffer.byteLength(entry.content);
    if (bytes + size > CLI_IMPORT_MAX_TEXT) break;
    selected.unshift({ role: entry.role, content: entry.content, createdAt: entry.createdAt });
    bytes += size;
  }
  return { sessionId, cwd, title, updatedAt: visible.at(-1)!.createdAt, messages: selected, omittedMessages: visible.length - selected.length };
}
