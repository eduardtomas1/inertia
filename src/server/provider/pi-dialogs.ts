import { randomUUID } from "node:crypto";

import type { JsonObject } from "../codex/protocol";
import type { AgentHarnessEmitter } from "./agent-harness";
import type { AgentApprovalDecision } from "./interactions";
import type { AcpSecretRedactor } from "./acp-redaction";

interface Dialog { nativeId: string; method: string; approval: boolean; options: string[]; timer: NodeJS.Timeout }

/** The provider's opaque UI ID is never confused with an application request ID. */
export class PiDialogs {
  private readonly pending = new Map<string, Dialog>();
  private readonly seen = new Set<string>();
  constructor(private readonly emit: AgentHarnessEmitter, private readonly redact: AcpSecretRedactor,
    private readonly send: (record: JsonObject) => void, private readonly approvalTitle: string) {}

  receive(event: JsonObject): boolean {
    const method = event.method;
    if (!["select", "confirm", "input", "editor"].includes(String(method))) return false;
    if (typeof event.id !== "string" || !event.id || event.id.length > 256 || this.seen.has(event.id)
      || this.seen.size >= 512 || this.pending.size >= 16) throw new Error("Invalid or excessive Pi extension dialogs.");
    this.seen.add(event.id);
    // A native ID is arbitrary provider output and can itself contain a secret.
    // Only this private map retains it; the renderer receives an application ID.
    const id = `pi-ui:${randomUUID()}`;
    const approval = method === "confirm" && event.title === this.approvalTitle;
    const choices = method === "select" && Array.isArray(event.options) ? event.options : [];
    if (choices.length > 64 || choices.some((item) => typeof item !== "string" || item.length > 4096)) throw new Error("Invalid Pi dialog options.");
    const timeout = typeof event.timeout === "number" && Number.isFinite(event.timeout)
      ? Math.max(1, Math.min(300_000, event.timeout)) : 300_000;
    const timer = setTimeout(() => this.finish(id, { cancelled: true }), timeout); timer.unref();
    this.pending.set(id, { nativeId: event.id, method: String(method), approval, options: choices as string[], timer });
    const title = this.redact.payload(typeof event.title === "string" ? event.title.slice(0, 240) : "Pi extension");
    const message = this.redact.payload(typeof event.message === "string" ? event.message.slice(0, 32_768)
      : typeof event.prefill === "string" ? event.prefill.slice(0, 32_768) : "");
    if (approval) this.emit.rich({ type: "approval", request: {
      requestId: id, kind: "permissions", title: "Pi tool approval", detail: message,
      permissionRoots: [], availableDecisions: ["approve", "deny", "cancel"],
    } });
    else this.emit.rich({ type: "input", request: { requestId: id, autoResolutionMs: timeout, questions: [{
      id: "answer", header: title, question: message || title, isSecret: false,
      isOther: method !== "confirm" && method !== "select", allowMultiple: false,
      options: method === "confirm" ? [{ id: "yes", label: "Yes", description: "" }, { id: "no", label: "No", description: "" }]
        : (choices as string[]).map((label, index) => ({ id: String(index), label: this.redact.payload(label), description: "" })),
    }] } });
    return true;
  }

  approval(id: string, decision: AgentApprovalDecision): boolean {
    if (!this.pending.get(id)?.approval || !["approve", "deny", "cancel"].includes(decision)) return false;
    return this.finish(id, decision === "cancel" ? { cancelled: true } : { confirmed: decision === "approve" }, decision);
  }

  input(id: string, answers: Record<string, string[]>): boolean {
    const dialog = this.pending.get(id);
    if (!dialog || dialog.approval) return false;
    if (Object.keys(answers).some((key) => key !== "answer")) return false;
    const selected = answers.answer;
    if (selected !== undefined && (!Array.isArray(selected) || selected.some((value) => typeof value !== "string"))) return false;
    if (!selected?.length) return this.finish(id, { cancelled: true });
    if (selected.length !== 1 || selected[0]!.length > 32_768) return false;
    const value = selected[0]!;
    if (dialog.method === "confirm") return ["yes", "no"].includes(value) && this.finish(id, { confirmed: value === "yes" });
    if (dialog.method === "select") {
      if (!/^(0|[1-9]\d*)$/u.test(value) || dialog.options[Number(value)] === undefined) return false;
      return this.finish(id, { value: dialog.options[Number(value)] });
    }
    return this.finish(id, { value });
  }

  close(): void { for (const id of this.pending.keys()) this.finish(id, { cancelled: true }); }

  private finish(id: string, answer: JsonObject, decision?: AgentApprovalDecision): boolean {
    const dialog = this.pending.get(id); if (!dialog) return false;
    clearTimeout(dialog.timer); this.pending.delete(id);
    try { this.send({ type: "extension_ui_response", id: dialog.nativeId, ...answer }); } catch { /* Transport owns failure. */ }
    if (dialog.approval) this.emit.rich({ type: "approval-resolved", requestId: id, decision: decision ?? "cancelled" });
    else this.emit.rich({ type: "input-resolved", requestId: id });
    return true;
  }
}
