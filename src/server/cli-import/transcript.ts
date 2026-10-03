import { CLI_IMPORT_MAX_MESSAGES, CLI_IMPORT_MAX_TEXT, CLI_OPENING_MAX_TEXT, type CliConversationOpening, type CliMessage, type CliProvider } from "../../shared/cli-conversations";
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
  opening: CliConversationOpening;
}

const TITLE_MAX_TEXT = 160;
const UNTITLED = "Untitled conversation";
const WRAPPER_TAG = /<([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+|heartbeat)(?:\s[^<>]*)?>/gu;

function excerpt(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= limit) return flat;
  const space = flat.slice(0, limit + 1).lastIndexOf(" ");
  return (space > 0 ? flat.slice(0, space) : flat.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "")).trimEnd();
}

function delegatedInput(inner: string): string {
  const open = /<input(?:\s[^<>]*)?>/u.exec(inner);
  const close = inner.lastIndexOf("</input>");
  if (!open || close < open.index + open[0].length) return "";
  return withoutWrappers(inner.slice(open.index + open[0].length, close));
}

function withoutWrappers(text: string): string {
  const pattern = new RegExp(WRAPPER_TAG);
  const unclosed = new Set<string>();
  let result = "";
  let copied = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const tag = match[1]!;
    if (unclosed.has(tag)) continue;
    const closing = text.indexOf(`</${tag}>`, pattern.lastIndex);
    if (closing < 0) { unclosed.add(tag); continue; }
    result += text.slice(copied, match.index);
    if (tag === "codex_delegation") result += delegatedInput(text.slice(pattern.lastIndex, closing));
    copied = closing + tag.length + 3;
    pattern.lastIndex = copied;
  }
  return result + text.slice(copied);
}

function userProse(text: string, provider: CliProvider): string {
  if (provider === "codex" && text.trim().startsWith("# AGENTS.md instructions")) return "";
  const prose = withoutWrappers(text).trim();
  return /^\[Request interrupted by user[^\]]*\]$/u.test(prose) ? "" : prose;
}

function redact(text: string, secrets: readonly string[]): string {
  let clean = redactCredentialUrls(redactHostToolPayload(text, secrets));
  for (const pattern of SECRET_PATTERNS) clean = clean.replace(pattern, "[redacted credential]");
  return clean.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

function retained(visible: readonly CliMessage[], firstUser: number): CliMessage[] {
  const tail = (entries: readonly CliMessage[], count: number, budget: number): CliMessage[] => {
    const selected: CliMessage[] = [];
    let bytes = 0;
    for (const entry of entries.slice(-count).reverse()) {
      const size = Buffer.byteLength(entry.content);
      if (bytes + size > budget) break;
      selected.unshift({ role: entry.role, content: entry.content, createdAt: entry.createdAt });
      bytes += size;
    }
    return selected;
  };
  const all = tail(visible, CLI_IMPORT_MAX_MESSAGES, CLI_IMPORT_MAX_TEXT);
  if (firstUser < 0 || all.length >= visible.length - firstUser) return all;
  const first = visible[firstUser]!;
  return [{ role: first.role, content: first.content, createdAt: first.createdAt },
    ...tail(visible.slice(firstUser + 1), CLI_IMPORT_MAX_MESSAGES - 1, CLI_IMPORT_MAX_TEXT - Buffer.byteLength(first.content))];
}

export function transcriptWorkspace(head: string, provider: CliProvider): string | null | undefined {
  const lines = head.split("\n");
  lines.pop();
  for (const line of lines) {
    let item: RecordValue;
    try { item = record(JSON.parse(line)); } catch { continue; }
    if (provider === "codex") {
      if (item.type !== "session_meta") continue;
      const payload = record(item.payload);
      return !record(payload.source).subagent && typeof payload.cwd === "string" && payload.cwd ? payload.cwd : null;
    }
    if (item.isSidechain !== true && typeof item.cwd === "string" && item.cwd) return item.cwd;
  }
  return undefined;
}

export function parseCliTranscript(source: string, provider: CliProvider, fallbackDate: string, secrets: readonly string[] = []): ParsedCliTranscript {
  let sessionId = "";
  let cwd = "";
  const messages: Array<CliMessage & { id?: string }> = [];
  const codexTurnStarts: number[] = [];
  const parents = new Map<string, string | null>();
  const named: Partial<Record<"custom" | "generated" | "summary" | "thread", string>> = {};
  let lastId: string | null = null;
  const canonicalUser = provider === "codex" && /"type"\s*:\s*"user_message"/u.test(source);
  const lines = source.split("\n");
  if (lines.length > 100_000) throw new Error("The CLI transcript has too many records.");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let item: RecordValue;
    try { item = record(JSON.parse(line)); } catch {
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
      if (item.type === "event_msg" && payload.type === "thread_name_updated" && typeof payload.thread_name === "string") named.thread = payload.thread_name;
      if (item.type === "event_msg" && payload.type === "thread_rolled_back") {
        let remaining = typeof payload.num_turns === "number" ? payload.num_turns : 0;
        if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("Invalid CLI rollback record.");
        while (codexTurnStarts.length && remaining > 0) {
          messages.length = codexTurnStarts.pop()!;
          remaining -= 1;
        }
        if (remaining > 0) messages.length = 0;
      }
      if (canonicalUser && item.type === "event_msg" && payload.type === "user_message") {
        role = "user";
        content = typeof payload.message === "string" ? payload.message : "";
      } else if (item.type === "response_item" && payload.type === "message" && !(canonicalUser && payload.role === "user")) {
        role = payload.role;
        content = textContent(payload.content);
      } else continue;
      if (role === "user") {
        codexTurnStarts.push(messages.length);
        content = userProse(content, provider);
      }
    } else {
      if (item.isSidechain === true) continue;
      if (typeof item.sessionId === "string") {
        if (sessionId && item.sessionId !== sessionId) throw new Error("The CLI session identity changed.");
        sessionId = item.sessionId;
      }
      if (typeof item.cwd === "string" && !cwd) cwd = item.cwd;
      if (item.type === "custom-title" && typeof item.customTitle === "string") named.custom = item.customTitle;
      if (item.type === "ai-title" && typeof item.aiTitle === "string") named.generated = item.aiTitle;
      if (item.type === "summary" && typeof item.summary === "string") named.summary = item.summary;
      if (typeof item.uuid === "string") {
        id = item.uuid;
        if ("parentUuid" in item) {
          const parent = typeof item.parentUuid === "string" ? item.parentUuid : typeof item.logicalParentUuid === "string" ? item.logicalParentUuid : null;
          parents.set(id, parent);
        }
        if (item.type === "user" || item.type === "assistant") lastId = id;
      }
      if (!["user", "assistant"].includes(String(item.type)) || item.isMeta === true || item.isCompactSummary === true
        || item.isVisibleInTranscriptOnly === true || item.isApiErrorMessage === true) continue;
      const message = record(item.message);
      if (message.model === "<synthetic>") continue;
      role = message.role ?? item.type;
      content = textContent(message.content);
      if (role === "user") content = userProse(content, provider);
    }
    if (role !== "user" && role !== "assistant") continue;
    const clean = redact(content, secrets).slice(0, 32 * 1024);
    if (!clean.trim()) continue;
    messages.push({ role, content: clean, createdAt: timestamp(item.timestamp, fallbackDate), ...(id ? { id } : {}) });
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
  const firstUser = visible.findIndex((entry) => entry.role === "user");
  const lead = visible[firstUser] ?? visible.find((entry) => entry.role === "assistant");
  const leadText = lead?.content ?? "";
  const providerTitle = [named.custom, named.generated, named.summary, named.thread]
    .map((value) => excerpt(redact(value ?? "", secrets), TITLE_MAX_TEXT)).find(Boolean);
  const title = providerTitle ?? (excerpt(leadText, TITLE_MAX_TEXT) || UNTITLED);
  const selected = retained(visible, firstUser);
  const reply = firstUser < 0 ? undefined : visible.find((entry, index) => index > firstUser && entry.role === "assistant");
  const opening = { user: excerpt(leadText, CLI_OPENING_MAX_TEXT) || UNTITLED, assistant: reply ? excerpt(reply.content, CLI_OPENING_MAX_TEXT) : null };
  return { sessionId, cwd, title, updatedAt: visible.at(-1)!.createdAt, messages: selected, omittedMessages: visible.length - selected.length, opening };
}
