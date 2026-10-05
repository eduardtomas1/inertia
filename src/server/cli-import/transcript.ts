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
  omittedBytes: number;
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
    if (tag.endsWith("_delegation")) result += delegatedInput(text.slice(pattern.lastIndex, closing));
    copied = closing + tag.length + 3;
    pattern.lastIndex = copied;
  }
  return result + text.slice(copied);
}

function userProse(text: string, provider: CliProvider): string {
  const prose = withoutWrappers(text).trim();
  if (provider === "codex" && prose.startsWith("# AGENTS.md instructions")) return "";
  return /^\[Request interrupted by user[^\]]*\]$/u.test(prose) ? "" : prose;
}

function redact(text: string, secrets: readonly string[]): string {
  let clean = redactCredentialUrls(redactHostToolPayload(text, secrets));
  for (const pattern of SECRET_PATTERNS) clean = clean.replace(pattern, "[redacted credential]");
  return clean.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

interface Entry extends CliMessage { id?: string; index: number; bytes: number }

const HEAD_MESSAGES = 32;
export const CLI_TRANSCRIPT_MAX_RECORDS = 1_000_000;

function newest(entries: readonly Entry[], count: number, budget: number): Entry[] {
  const selected: Entry[] = [];
  let bytes = 0;
  for (const entry of entries.slice(-count).reverse()) {
    if (bytes + entry.bytes > budget) break;
    selected.unshift(entry);
    bytes += entry.bytes;
  }
  return selected;
}

function retained(entries: readonly Entry[], firstUser: number, tailStart: number | null): Entry[] {
  const all = newest(entries, CLI_IMPORT_MAX_MESSAGES, CLI_IMPORT_MAX_TEXT);
  if (tailStart === null && all.length >= entries.length - firstUser) return all;
  const lead = entries[firstUser]!;
  const next = entries[firstUser + 1];
  const crosses = tailStart !== null && next !== undefined && lead.index < tailStart && next.index >= tailStart;
  const opening = next?.role === "assistant" && !crosses ? [lead, next] : [lead];
  const rest = entries.slice(firstUser + opening.length).filter(({ index }) => tailStart === null || index >= tailStart);
  const used = opening.reduce((total, entry) => total + entry.bytes, 0);
  return [...opening, ...newest(rest, CLI_IMPORT_MAX_MESSAGES - opening.length, CLI_IMPORT_MAX_TEXT - used)];
}

class MessageWindow {
  count = 0;
  bytes = 0;
  head: Entry[] = [];
  tail: Entry[] = [];
  private tailBytes = 0;
  private turns: Array<{ count: number; bytes: number }> = [];

  startTurn(): void {
    this.turns.push({ count: this.count, bytes: this.bytes });
  }

  push(message: CliMessage, id?: string): Entry {
    const entry: Entry = { ...message, ...(id ? { id } : {}), index: this.count, bytes: Buffer.byteLength(message.content) };
    this.count += 1;
    this.bytes += entry.bytes;
    if (this.head.length < HEAD_MESSAGES) this.head.push(entry);
    this.tail.push(entry);
    this.tailBytes += entry.bytes;
    while (this.tail.length > CLI_IMPORT_MAX_MESSAGES || this.tailBytes > CLI_IMPORT_MAX_TEXT) this.tailBytes -= this.tail.shift()!.bytes;
    return entry;
  }

  rollback(turns: number): void {
    let remaining = turns;
    let target: { count: number; bytes: number } | undefined;
    while (this.turns.length && remaining > 0) {
      target = this.turns.pop();
      remaining -= 1;
    }
    if (remaining > 0) target = { count: 0, bytes: 0 };
    if (!target) return;
    const { count } = target;
    this.count = count;
    this.bytes = target.bytes;
    this.head = this.head.filter(({ index }) => index < count);
    this.tail = this.tail.filter(({ index }) => index < count);
    this.tailBytes = this.tail.reduce((total, entry) => total + entry.bytes, 0);
  }

  entries(): { entries: Entry[]; tailStart: number } {
    const last = this.head.at(-1)?.index ?? -1;
    const tail = this.tail.filter(({ index }) => index > last);
    return { entries: [...this.head, ...tail], tailStart: tail[0]?.index ?? Number.POSITIVE_INFINITY };
  }
}

export class EmptyCliTranscript extends Error {}

export interface CliTranscriptHeader { cwd: string; sessionId?: string }

export function transcriptHeader(line: string, provider: CliProvider): CliTranscriptHeader | null | undefined {
  let item: RecordValue;
  try { item = record(JSON.parse(line)); } catch { return undefined; }
  if (provider === "codex") {
    if (item.type !== "session_meta") return undefined;
    const payload = record(item.payload);
    if (record(payload.source).subagent || typeof payload.cwd !== "string" || !payload.cwd) return null;
    return { cwd: payload.cwd, ...(typeof payload.id === "string" ? { sessionId: payload.id } : {}) };
  }
  if (item.isSidechain === true || typeof item.cwd !== "string" || !item.cwd) return undefined;
  return { cwd: item.cwd, ...(typeof item.sessionId === "string" ? { sessionId: item.sessionId } : {}) };
}

export class CliTranscriptParser {
  private sessionId = "";
  private cwd = "";
  private records = 0;
  private typedUser = false;
  private lastId: string | null = null;
  private readonly named: Partial<Record<"custom" | "generated" | "summary" | "thread", string>> = {};
  private readonly typed = new MessageWindow();
  private readonly responses = new MessageWindow();
  private readonly parents = new Map<string, string | null>();
  private readonly ids: string[] = [];
  private readonly sizes: number[] = [];

  constructor(private readonly provider: CliProvider, private readonly fallbackDate: string, private readonly secrets: readonly string[] = []) {}

  line(line: string, terminated: boolean): void {
    if (!line.trim()) return;
    this.records += 1;
    if (this.records > CLI_TRANSCRIPT_MAX_RECORDS) throw new Error("The CLI transcript has too many records.");
    let item: RecordValue;
    try { item = record(JSON.parse(line)); } catch {
      if (!terminated) return;
      throw new Error("The CLI transcript contains an unreadable record.");
    }
    if (this.provider === "codex") this.codex(item);
    else this.claude(item);
  }

  private message(role: unknown, raw: string, time: unknown): CliMessage | null {
    if (role !== "user" && role !== "assistant") return null;
    const content = role === "user" ? userProse(raw, this.provider) : withoutWrappers(raw).trim();
    const clean = redact(content, this.secrets).slice(0, 32 * 1024);
    return clean.trim() ? { role, content: clean, createdAt: timestamp(time, this.fallbackDate) } : null;
  }

  private codex(item: RecordValue): void {
    const payload = record(item.payload);
    if (item.type === "session_meta") {
      if (this.sessionId && this.sessionId !== payload.id) throw new Error("The CLI session identity changed.");
      this.sessionId = typeof payload.id === "string" ? payload.id : "";
      this.cwd = typeof payload.cwd === "string" ? payload.cwd : "";
      if (record(payload.source).subagent) throw new Error("Subagent sessions are not supported.");
      if (payload.model_provider && payload.model_provider !== "openai") throw new Error("Only native Codex sessions are supported.");
    }
    if (item.type === "event_msg" && payload.type === "thread_name_updated" && typeof payload.thread_name === "string") this.named.thread = payload.thread_name;
    if (item.type === "event_msg" && payload.type === "thread_rolled_back") {
      const turns = typeof payload.num_turns === "number" ? payload.num_turns : 0;
      if (!Number.isSafeInteger(turns) || turns < 0) throw new Error("Invalid CLI rollback record.");
      this.typed.rollback(turns);
      this.responses.rollback(turns);
    }
    if (item.type === "event_msg" && payload.type === "user_message") {
      this.typedUser = true;
      this.typed.startTurn();
      const typed = this.message("user", typeof payload.message === "string" ? payload.message : "", item.timestamp);
      if (typed) this.typed.push(typed);
    } else if (item.type === "response_item" && payload.type === "message") {
      if (payload.role === "user") this.responses.startTurn();
      const message = this.message(payload.role, textContent(payload.content), item.timestamp);
      if (!message) return;
      this.responses.push(message);
      if (message.role === "assistant") this.typed.push(message);
    }
  }

  private claude(item: RecordValue): void {
    if (item.isSidechain === true) return;
    if (typeof item.sessionId === "string") this.sessionId = item.sessionId;
    if (typeof item.cwd === "string" && !this.cwd) this.cwd = item.cwd;
    if (item.type === "custom-title" && typeof item.customTitle === "string") this.named.custom = item.customTitle;
    if (item.type === "ai-title" && typeof item.aiTitle === "string") this.named.generated = item.aiTitle;
    if (item.type === "summary" && typeof item.summary === "string") this.named.summary = item.summary;
    let id: string | undefined;
    if (typeof item.uuid === "string") {
      id = item.uuid;
      if ("parentUuid" in item) {
        this.parents.set(id, typeof item.parentUuid === "string" ? item.parentUuid : typeof item.logicalParentUuid === "string" ? item.logicalParentUuid : null);
      }
      if (item.type === "user" || item.type === "assistant") this.lastId = id;
    }
    if (!["user", "assistant"].includes(String(item.type)) || item.isMeta === true || item.isCompactSummary === true
      || item.isVisibleInTranscriptOnly === true || item.isApiErrorMessage === true) return;
    const body = record(item.message);
    if (body.model === "<synthetic>") return;
    const message = this.message(body.role ?? item.type, textContent(body.content), item.timestamp);
    if (!message) return;
    const entry = this.responses.push(message, id);
    this.ids.push(id ?? "");
    this.sizes.push(entry.bytes);
  }

  finish(): ParsedCliTranscript {
    if (!uuid.test(this.sessionId) || !this.cwd || this.cwd.includes("\0")) throw new Error("The CLI transcript has no valid session or workspace.");
    const window = this.provider === "codex" && this.typedUser ? this.typed : this.responses;
    let { entries, tailStart } = window.entries();
    let total = window.count;
    let totalBytes = window.bytes;
    if (this.provider === "claude" && this.lastId && this.parents.size) {
      const lineage = new Set<string>();
      let cursor: string | null = this.lastId;
      while (cursor && !lineage.has(cursor)) { lineage.add(cursor); cursor = this.parents.get(cursor) ?? null; }
      const visible = (id: string | undefined): boolean => !id || lineage.has(id);
      entries = entries.filter((entry) => visible(entry.id));
      total = 0;
      totalBytes = 0;
      this.ids.forEach((id, index) => {
        if (!visible(id || undefined)) return;
        total += 1;
        totalBytes += this.sizes[index]!;
      });
    }
    const firstUser = entries.findIndex((entry) => entry.role === "user");
    if (firstUser < 0) throw new EmptyCliTranscript("The CLI transcript has no user message.");
    const leadText = entries[firstUser]!.content;
    const providerTitle = [this.named.custom, this.named.generated, this.named.summary, this.named.thread]
      .map((value) => excerpt(redact(value ?? "", this.secrets), TITLE_MAX_TEXT)).find(Boolean);
    const title = providerTitle ?? (excerpt(leadText, TITLE_MAX_TEXT) || UNTITLED);
    const selected = retained(entries, firstUser, entries.length === total ? null : tailStart);
    const reply = entries.find((entry, index) => index > firstUser && entry.role === "assistant");
    const opening = { user: excerpt(leadText, CLI_OPENING_MAX_TEXT) || UNTITLED, assistant: reply ? excerpt(reply.content, CLI_OPENING_MAX_TEXT) : null };
    return {
      sessionId: this.sessionId, cwd: this.cwd, title, updatedAt: entries.at(-1)!.createdAt,
      messages: selected.map(({ role, content, createdAt }) => ({ role, content, createdAt })),
      omittedMessages: total - selected.length,
      omittedBytes: totalBytes - selected.reduce((sum, entry) => sum + entry.bytes, 0),
      opening,
    };
  }
}

export function parseCliTranscript(source: string, provider: CliProvider, fallbackDate: string, secrets: readonly string[] = []): ParsedCliTranscript {
  const parser = new CliTranscriptParser(provider, fallbackDate, secrets);
  const lines = source.split("\n");
  lines.forEach((line, index) => parser.line(line, index < lines.length - 1));
  return parser.finish();
}
