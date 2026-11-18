import { randomUUID } from "node:crypto";

import { objectValue, type JsonObject } from "../codex/protocol";
import type { AgentHarnessEmitter } from "./agent-harness";
import { AcpSecretRedactor } from "./acp-redaction";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";

/** Projects only supported Pi events. Provider transcripts and error payloads stay private. */
export class PiEvents {
  readonly text = new CappedProviderBuffer(4 * 1024 * 1024);
  failed = false;
  private redact: AcpSecretRedactor;
  private streamed = false;
  private streamedReasoning = false;
  private messageCount = 0;
  private toolCount = 0;
  private readonly tools = new Map<string, { activityId: string; name: string; label: string }>();
  private readonly budget = new ProviderRunEventBudget("Pi", 32 * 1024 * 1024, 8192, 64 * 1024 * 1024);
  constructor(private readonly emit: AgentHarnessEmitter, private readonly environment: NodeJS.ProcessEnv) {
    this.redact = new AcpSecretRedactor(environment);
  }
  private textChunk(text: string): void {
    const before = this.text.toString().length;
    this.text.append(text);
    this.chunks(this.text.toString().slice(before), false);
  }
  private chunks(text: string, reasoning: boolean): void {
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 32_768);
      const unit = text.charCodeAt(end - 1);
      if (end < text.length && unit >= 0xd800 && unit <= 0xdbff) end -= 1;
      const chunk = text.slice(offset, end);
      if (reasoning) this.emit.rich({ type: "reasoning-summary", text: chunk });
      else this.emit.text(chunk);
      offset = end;
    }
  }
  finish(): void {
    this.textChunk(this.redact.finishAssistant());
    this.chunks(this.redact.finishReasoning(), true);
  }
  receive(raw: JsonObject): void {
    this.budget.observe(raw);
    if (raw.type === "message_update") {
      const delta = objectValue(raw.assistantMessageEvent);
      if (typeof delta?.delta === "string" && delta.delta.length > 64 * 1024) throw new Error("Pi text update exceeded its limit.");
      if (delta?.type === "text_delta" && typeof delta.delta === "string") {
        this.streamed = true; this.textChunk(this.redact.assistantChunk(delta.delta));
      } else if (delta?.type === "thinking_delta" && typeof delta.delta === "string") {
        this.streamedReasoning = true; this.chunks(this.redact.reasoningChunk(delta.delta), true);
      }
      return;
    }
    const event = this.redact.payload(raw);
    if (event.type === "message_start" && objectValue(event.message)?.role === "assistant") {
      this.finish(); this.redact = new AcpSecretRedactor(this.environment); this.streamed = false; this.streamedReasoning = false; this.failed = false;
      if (this.messageCount++ > 0) { this.text.append("\n\n"); this.emit.textBoundary(); }
    } else if (event.type === "message_end") {
      const message = objectValue(event.message);
      if (message?.role !== "assistant") return;
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          const block = objectValue(part);
          if (!this.streamed && block?.type === "text" && typeof block.text === "string") this.textChunk(block.text);
          if (!this.streamedReasoning && block?.type === "thinking" && typeof block.thinking === "string") this.chunks(block.thinking, true);
        }
      }
      this.finish(); this.failed = message.stopReason === "error" || message.stopReason === "aborted";
    } else if (event.type === "tool_execution_start") {
      if (typeof raw.toolCallId !== "string" || !raw.toolCallId || raw.toolCallId.length > 512 || this.tools.has(raw.toolCallId)
        || typeof raw.toolName !== "string" || !raw.toolName || raw.toolName.length > 200
        || this.toolCount >= 1024) throw new Error("Pi returned invalid tool activity.");
      // Native IDs can contain credentials or be reused in a later model turn.
      // Correlate the active invocation privately and publish a fresh opaque ID.
      const tool = { activityId: `pi-tool:${randomUUID()}`, name: raw.toolName, label: String(event.toolName) };
      this.tools.set(raw.toolCallId, tool); this.toolCount++;
      this.emit.activity("tool", "started", tool.label,
        { activityId: tool.activityId, detail: event.args ? JSON.stringify(event.args).slice(0, 16_384) : undefined });
    } else if (event.type === "tool_execution_end") {
      const tool = typeof raw.toolCallId === "string" ? this.tools.get(raw.toolCallId) : undefined;
      if (!tool || tool.name !== raw.toolName) throw new Error("Pi completed an unknown or mismatched tool.");
      this.tools.delete(raw.toolCallId as string);
      const content = objectValue(event.result)?.content;
      const detail = Array.isArray(content) ? content.flatMap((part) => {
        const block = objectValue(part); return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
      }).join("\n").slice(0, 16_384) : undefined;
      this.emit.activity("tool", event.isError === true ? "failed" : "completed", tool.label,
        { activityId: tool.activityId, detail, ...(event.isError !== true && ["edit", "write"].includes(tool.name) ? { fileMutation: true as const } : {}) });
    } else if (event.type === "auto_retry_start") this.emit.status("retrying", "Pi is retrying the request");
    else if (event.type === "auto_retry_end") {
      if (event.success === false) this.failed = true;
      this.emit.status("running");
    } else if (event.type === "auto_compaction_start") this.emit.activity("system", "started", "Compacting Pi context", { activityId: "pi-compaction" });
    else if (event.type === "auto_compaction_end") this.emit.activity("system", event.aborted === true ? "failed" : "completed", "Pi context compaction", { activityId: "pi-compaction" });
    else if (event.type === "extension_error") this.emit.activity("tool", "failed", "Pi extension failed");
  }
}
