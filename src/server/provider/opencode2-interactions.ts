import { objectValue, type JsonObject } from "../codex/protocol";
import type { AgentHarnessEmitter } from "./agent-harness";
import type { AgentApprovalDecision, AgentInputQuestion } from "./interactions";
import type { AcpSecretRedactor } from "./acp-redaction";
import { openCode2SessionPath, type OpenCode2Api } from "./opencode2-history";

interface Pending { nativeId: string; sessionId: string; kind: "permission" | "form"; fields?: JsonObject[]; timer: NodeJS.Timeout; responding: boolean }
export class OpenCode2Interactions {
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  private readonly replies = new Set<Promise<void>>();
  constructor(private readonly client: OpenCode2Api, private readonly emit: AgentHarnessEmitter,
    private readonly redact: AcpSecretRedactor, private readonly onFailure: () => void) {}

  receive(type: string, raw: JsonObject, sessionId: string): boolean {
    if (["form.replied", "form.cancelled", "permission.replied"].includes(type) && raw.sessionID === sessionId) {
      const id = `opencode2-${type.startsWith("form.") ? "form" : "permission"}:${String(raw.id ?? raw.requestID)}`;
      const entry = this.pending.get(id);
      if (entry && !entry.responding) {
        clearTimeout(entry.timer); this.pending.delete(id);
        if (entry.kind === "form") this.emit.rich({ type: "input-resolved", requestId: id });
        else this.emit.rich({ type: "approval-resolved", requestId: id, decision: "cancelled" });
      }
      return true;
    }
    const form = type === "form.created" ? objectValue(raw.form) : undefined;
    if (type !== "permission.asked" && !form) return false;
    const record = form ?? raw;
    if (record.sessionID !== sessionId) return false;
    const kind = form ? "form" : "permission";
    if (typeof record.id !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/u.test(record.id)
      || this.seen.has(record.id) || this.seen.size >= 512 || this.pending.size >= 16) throw new Error("Invalid OpenCode 2 interaction identity.");
    this.seen.add(record.id); const id = `opencode2-${kind}:${record.id}`;
    const timer = setTimeout(() => this.cancel(id), 300_000); timer.unref();
    const entry: Pending = { nativeId: record.id, sessionId, kind, timer, responding: false };
    this.pending.set(id, entry);
    const safe = this.redact.payload(record);
    if (!form) {
      if (typeof safe.action !== "string" || safe.action.length > 256 || !Array.isArray(safe.resources)
        || safe.resources.length > 64 || safe.resources.some((value) => typeof value !== "string" || value.length > 8192)) throw new Error("Invalid OpenCode 2 permission payload.");
      this.emit.rich({ type: "approval", request: { requestId: id,
        kind: safe.action === "shell" ? "command" : safe.action === "edit" ? "file-change" : "permissions",
        title: `OpenCode: ${safe.action}`, detail: safe.resources.join("\n").slice(0, 32_768),
        permissionRoots: [], availableDecisions: ["approve", "deny", "cancel"] } });
      return true;
    }
    if (!Array.isArray(record.fields) || record.fields.length < 1 || record.fields.length > 3) { this.cancel(id); return true; }
    const fields = record.fields.map(objectValue);
    if (fields.some((field) => !field || typeof field.key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(field.key)
      || !["string", "boolean", "multiselect", "number", "integer"].includes(String(field.type)) || field.when !== undefined || field.hidden === true)
      || new Set(fields.map((field) => field!.key)).size !== fields.length) { this.cancel(id); return true; }
    entry.fields = fields as JsonObject[];
    const questions = entry.fields.map((field): AgentInputQuestion => {
      const options = field.type === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : field.options ?? [];
      if (!Array.isArray(options) || options.length > 64) throw new Error("Invalid OpenCode 2 form options.");
      return { id: field.key as string, header: this.redact.payload(String(field.title ?? record.title ?? "OpenCode").slice(0, 240)),
        question: this.redact.payload(String(field.description ?? field.title ?? record.title ?? "OpenCode question").slice(0, 32_768)),
        isSecret: false, isOther: field.type !== "boolean" && (options.length === 0 || field.custom === true), allowMultiple: field.type === "multiselect",
        options: options.map((rawOption, index) => {
          const option = objectValue(rawOption);
          if (!option || typeof option.value !== "string" || option.value.length > 8192 || typeof option.label !== "string" || option.label.length > 512) throw new Error("Invalid OpenCode 2 form option.");
          return { id: String(index), label: this.redact.payload(option.label), description: this.redact.payload(String(option.description ?? "").slice(0, 4096)) };
        }) };
    });
    this.emit.rich({ type: "input", request: { requestId: id, questions, autoResolutionMs: 300_000 } });
    return true;
  }

  approval(id: string, decision: AgentApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.kind !== "permission" || !["approve", "deny", "cancel"].includes(decision)) return false;
    return this.deliver(id, "POST", `${openCode2SessionPath(entry.sessionId)}/permission/${entry.nativeId}/reply`, { decision: decision === "approve" ? "once" : "reject" }, decision);
  }
  input(id: string, answers: Record<string, string[]>): boolean {
    const entry = this.pending.get(id); if (!entry?.fields || entry.responding) return false;
    if (Object.keys(answers).some((key) => !entry.fields!.some((field) => field.key === key))) return false;
    const answer: JsonObject = {};
    for (const field of entry.fields) {
      const selected = answers[String(field.key)] ?? [];
      if (selected.some((value) => value.length > 32_768) || selected.length > 64 || field.type !== "multiselect" && selected.length > 1) return false;
      if (!selected.length) { if (field.required !== false) return false; continue; }
      let values = selected;
      if (field.type === "boolean") {
        if (!["0", "1"].includes(selected[0]!)) return false;
        answer[String(field.key)] = selected[0] === "0"; continue;
      }
      if (Array.isArray(field.options)) {
        const options = field.options;
        values = selected.map((value) => /^(0|[1-9]\d*)$/u.test(value) && options[Number(value)] !== undefined ? String(objectValue(options[Number(value)])?.value) : value);
        if (field.custom !== true && values.some((value) => !options.some((option) => objectValue(option)?.value === value))) return false;
      }
      if (field.type === "number" || field.type === "integer") {
        const value = Number(values[0]);
        if (!values[0]?.trim() || !Number.isFinite(value) || field.type === "integer" && !Number.isSafeInteger(value)
          || typeof field.minimum === "number" && value < field.minimum || typeof field.maximum === "number" && value > field.maximum) return false;
        answer[String(field.key)] = value;
      } else answer[String(field.key)] = field.type === "multiselect" ? values : values[0]!;
    }
    return this.deliver(id, "POST", `${openCode2SessionPath(entry.sessionId)}/form/${entry.nativeId}/reply`, { answer });
  }
  async drain(): Promise<void> { await Promise.all(this.replies); }
  close(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      if (entry.kind === "permission") this.emit.rich({ type: "approval-resolved", requestId: id, decision: "cancelled" });
      else this.emit.rich({ type: "input-resolved", requestId: id });
    }
    this.pending.clear();
  }
  private cancel(id: string): void {
    const entry = this.pending.get(id); if (!entry) return;
    if (entry.kind === "permission") this.approval(id, "cancel");
    else this.deliver(id, "DELETE", `${openCode2SessionPath(entry.sessionId)}/form/${entry.nativeId}`);
  }
  private deliver(id: string, method: "POST" | "DELETE", path: string, body?: unknown, decision?: AgentApprovalDecision): boolean {
    const entry = this.pending.get(id); if (!entry || entry.responding) return false;
    entry.responding = true; clearTimeout(entry.timer);
    const work = this.client.request(method, path, body).then(() => {
      if (!this.pending.delete(id)) return;
      if (entry.kind === "permission") this.emit.rich({ type: "approval-resolved", requestId: id, decision: decision ?? "cancelled" });
      else this.emit.rich({ type: "input-resolved", requestId: id });
    }, () => this.onFailure()).finally(() => this.replies.delete(work));
    this.replies.add(work); return true;
  }
}
