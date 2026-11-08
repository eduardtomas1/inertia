import { createHash } from "node:crypto";

import { objectValue, type JsonObject } from "../codex/protocol";
import type { AgentHarnessEmitter } from "./agent-harness";
import { AcpSecretRedactor } from "./acp-redaction";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";
import { openCode2Id } from "./opencode2-history";
import { openCode2Usage } from "./opencode2-support";

interface Block { raw: string; redactor: AcpSecretRedactor; ended: boolean; reasoning: boolean }
interface Tool { name: string; activityId: string; called: boolean; settled: boolean }
/** Receives only events whose native session and workspace have already been bound. */
export class OpenCode2Events {
  readonly text = new CappedProviderBuffer(4 * 1024 * 1024);
  private readonly blocks = new Map<string, Block>();
  private readonly tools = new Map<string, Tool>();
  private readonly budget = new ProviderRunEventBudget("OpenCode 2", 32 * 1024 * 1024, 8192, 64 * 1024 * 1024);
  private lastMessage: string | undefined;
  constructor(private readonly emit: AgentHarnessEmitter, private readonly environment: NodeJS.ProcessEnv,
    private readonly redact: AcpSecretRedactor, private readonly contextWindow?: number,
    private readonly secretValues: readonly string[] = []) {}

  private textChunk(value: string): void {
    const before = this.text.toString().length; this.text.append(value);
    this.chunks(this.text.toString().slice(before), false);
  }
  private chunks(value: string, reasoning: boolean): void {
    for (let at = 0; at < value.length;) {
      let end = Math.min(value.length, at + 32_768);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
      const text = value.slice(at, end);
      if (reasoning) this.emit.rich({ type: "reasoning-summary", text });
      else this.emit.text(text);
      at = end;
    }
  }
  private output(block: Block, value: string): void {
    const safe = block.reasoning ? block.redactor.reasoningChunk(value) : block.redactor.assistantChunk(value);
    if (block.reasoning) this.chunks(safe, true);
    else this.textChunk(safe);
  }
  private finishBlock(block: Block): void {
    if (block.ended) return;
    block.ended = true;
    const safe = block.reasoning ? block.redactor.finishReasoning() : block.redactor.finishAssistant();
    if (block.reasoning) this.chunks(safe, true);
    else this.textChunk(safe);
  }
  finish(): void { for (const block of this.blocks.values()) this.finishBlock(block); }

  receive(raw: JsonObject): void {
    this.budget.observe(raw);
    const type = String(raw.type); const data = objectValue(raw.data);
    if (!data) throw new Error("Invalid OpenCode 2 event payload.");
    const textEvent = /^session\.(text|reasoning)\.(started|delta|ended)$/u.exec(type);
    if (textEvent) {
      if (!openCode2Id(data.assistantMessageID, "msg_") || !Number.isSafeInteger(data.ordinal) || Number(data.ordinal) < 0) throw new Error("Invalid OpenCode 2 text identity.");
      const key = `${data.assistantMessageID}:${textEvent[1]}:${data.ordinal}`;
      let block = this.blocks.get(key);
      if (!block) {
        if (this.blocks.size >= 1024) throw new Error("Too many OpenCode 2 text blocks.");
        if (textEvent[1] === "text" && this.lastMessage !== data.assistantMessageID) {
          if (this.lastMessage) { this.finish(); this.text.append("\n\n"); this.emit.textBoundary(); }
          this.lastMessage = data.assistantMessageID;
        }
        block = { raw: "", redactor: new AcpSecretRedactor(this.environment), ended: false, reasoning: textEvent[1] === "reasoning" };
        block.redactor.addSecrets(this.secretValues);
        this.blocks.set(key, block);
      }
      if (block.ended) throw new Error("OpenCode 2 changed a completed text block.");
      if (textEvent[2] === "delta") {
        if (typeof data.delta !== "string" || data.delta.length > 64 * 1024 || block.raw.length + data.delta.length > 1024 * 1024) throw new Error("OpenCode 2 text exceeded its safety limit.");
        block.raw += data.delta; this.output(block, data.delta);
      } else if (textEvent[2] === "ended") {
        if (typeof data.text !== "string" || data.text.length > 1024 * 1024 || !data.text.startsWith(block.raw)) throw new Error("OpenCode 2 text did not match its completed value.");
        this.output(block, data.text.slice(block.raw.length)); this.finishBlock(block);
      }
      return;
    }
    const safe = this.redact.payload(data);
    if (type.startsWith("session.tool.")) { this.tool(type, data, safe); return; }
    if (type === "session.step.ended") this.emit.rich({ type: "usage", usage: openCode2Usage(data.tokens, this.contextWindow) });
    else if (type === "session.usage.updated") this.emit.rich({ type: "usage", usage: openCode2Usage(data.tokens, this.contextWindow, true) });
    else if (type === "session.retry.scheduled") this.emit.status("retrying", "OpenCode is retrying the request");
    else if (type === "session.step.started") this.emit.status("running");
    else if (type === "session.compaction.started") this.emit.activity("system", "started", "Compacting OpenCode context", { activityId: "opencode2-compaction" });
    else if (type === "session.compaction.ended") this.emit.activity("system", "completed", "OpenCode compacted the session context", { activityId: "opencode2-compaction" });
  }

  private tool(type: string, data: JsonObject, safe: JsonObject): void {
    if (!["session.tool.input.started", "session.tool.called", "session.tool.success", "session.tool.failed"].includes(type)) return;
    if (!openCode2Id(data.assistantMessageID, "msg_") || typeof data.id !== "string" || !data.id || data.id.length > 512) throw new Error("Invalid OpenCode 2 tool identity.");
    const key = JSON.stringify([data.assistantMessageID, data.id]);
    let tool = this.tools.get(key);
    if (type === "session.tool.input.started") {
      if (tool || this.tools.size >= 1024 || typeof safe.name !== "string" || !safe.name || safe.name.length > 200) throw new Error("Invalid OpenCode 2 tool identity.");
      // Native call IDs can repeat in later messages and can contain arbitrary
      // provider output. Keep their exact tuple private and publish an opaque ID.
      tool = { name: safe.name, activityId: `opencode2-tool:${createHash("sha256").update(key).digest("hex")}`, called: false, settled: false };
      this.tools.set(key, tool); this.emit.activity("tool", "started", tool.name, { activityId: tool.activityId });
      return;
    }
    if (!tool || tool.settled) throw new Error("OpenCode 2 changed an unknown or completed tool.");
    if (type === "session.tool.called") {
      if (tool.called) throw new Error("OpenCode 2 repeated a tool call.");
      tool.called = true;
      this.emit.activity("tool", "started", tool.name, { activityId: tool.activityId, detail: JSON.stringify(safe.input ?? {}).slice(0, 16_384) });
    } else if (type === "session.tool.success" || type === "session.tool.failed") {
      const success = type === "session.tool.success";
      if (success && !tool.called) throw new Error("OpenCode 2 completed an uncalled tool.");
      tool.settled = true;
      const error = objectValue(safe.error)?.message;
      const detail = Array.isArray(safe.content) ? safe.content.flatMap((part) => {
        const content = objectValue(part); return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
      }).join("\n").slice(0, 16_384) : typeof error === "string" ? error.slice(0, 16_384) : undefined;
      this.emit.activity("tool", success ? "completed" : "failed", tool.name, { activityId: tool.activityId, detail,
        ...(success && ["edit", "write", "apply_patch"].includes(tool.name) ? { fileMutation: true as const } : {}) });
    }
  }
}
