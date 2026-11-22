import { randomUUID } from "node:crypto";

import { objectValue, type JsonObject } from "../codex/protocol";
import type { AgentHarnessEmitter } from "./agent-harness";
import { AcpSecretRedactor, type BoundarySecretRedactor } from "./acp-redaction";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";
import { clipCodeUnits } from "../../shared/code-units";

const PI_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_PI_CONTENT_INDEX = 4095;
const MAX_PI_CONTENT_BLOCKS = 1024;
/**
 * What republishing restarted or out-of-order blocks may send in one run, counting only the replaced segment or
 * message part. Past it the run keeps appending (T3 has no cap; a restarted block then shows its text twice).
 */
const MAX_PI_REPUBLISHED_CHARS = 64 * 1024 * 1024;

type PiBlockKind = "text" | "thinking";

/**
 * One text or thinking block of the current assistant message, keyed by kind and Pi's `contentIndex`. Keying by
 * kind too keeps an answer Pi streams at an index it first used for thinking (T3 keys by index alone).
 */
interface PiBlock {
  readonly index: number;
  readonly kind: PiBlockKind;
  /** Redacted text shown for the block; its redactor may still hold back a possible secret prefix. */
  shown: string;
  redactor: BoundarySecretRedactor;
  ended: boolean;
}

function rebuilt(before: string, closed: boolean, current: string): CappedProviderBuffer {
  const buffer = new CappedProviderBuffer(PI_TEXT_CHARS);
  buffer.append(before);
  if (closed) buffer.truncated = true;
  else buffer.append(current);
  return buffer;
}

/**
 * Wraps the Pi run's emitter so `closeSegment` runs before every emission that closes the runtime's open assistant
 * segment (activity, a text boundary, an approval, a question or a plan). The harness passes every emission through
 * it: `PiEvents`, the extension UI, dialogs and host approvals.
 */
export function segmentClosingEmitter(emitter: AgentHarnessEmitter, closeSegment: () => void): AgentHarnessEmitter {
  return {
    ...emitter,
    activity: (...args) => { closeSegment(); emitter.activity(...args); },
    textBoundary: () => { closeSegment(); emitter.textBoundary(); },
    rich: (event) => {
      if (event.type === "approval" || event.type === "input" || event.type === "plan") closeSegment();
      emitter.rich(event);
    },
  };
}

function blockKind(type: unknown): PiBlockKind | null {
  return typeof type === "string" && /^text_(?:start|delta|end)$/u.test(type) ? "text"
    : typeof type === "string" && /^thinking_(?:start|delta|end)$/u.test(type) ? "thinking" : null;
}

/** Projects only supported Pi events. Provider transcripts and error payloads stay private. */
export class PiEvents {
  failed = false;
  private redact: AcpSecretRedactor;
  /** The run's text, messages separated by a blank line; the current message's part is the open segment's source. */
  private result = new CappedProviderBuffer(PI_TEXT_CHARS);
  private resultBefore = "";
  private resultClosedBefore = false;
  /** The current message's text as the runtime holds it, across its closed segments and the open one. */
  private messagePublished = "";
  /** The part of `messagePublished` in segments the runtime has closed (an activity or a dialog mid-message). */
  private closedSegmentText = "";
  /** A restarted block is streaming again text that a closed segment already shows: nothing new to show yet. */
  private catchingUp = false;
  /** The run's reasoning as the runtime holds it; a replacement carries all of it. */
  private reasoning = new CappedProviderBuffer(PI_TEXT_CHARS);
  private reasoningBefore = "";
  private reasoningClosedBefore = false;
  /** The message's blocks of a kind no longer read as what was published: republish at the next edge. */
  private readonly dirty: Record<PiBlockKind, boolean> = { text: false, thinking: false };
  private blocks = new Map<string, PiBlock>();
  private republishedChars = 0;
  private streamed = false;
  private streamedReasoning = false;
  private messageCount = 0;
  private toolCount = 0;
  private readonly tools = new Map<string, { activityId: string; name: string; label: string }>();
  private readonly budget = new ProviderRunEventBudget("Pi", 32 * 1024 * 1024, 8192, 64 * 1024 * 1024);
  constructor(private readonly emit: AgentHarnessEmitter, private readonly environment: NodeJS.ProcessEnv) {
    this.redact = new AcpSecretRedactor(environment);
  }
  /** The run's final text, its assistant messages separated by a blank line. */
  get text(): CappedProviderBuffer {
    return this.result;
  }
  private get republishing(): boolean {
    return this.republishedChars <= MAX_PI_REPUBLISHED_CHARS;
  }
  /** The runtime closed its open segment: what this message published so far stays where it is. */
  closeSegment(): void {
    if (this.dirty.text) this.republish("text");
    this.closedSegmentText = this.messagePublished;
  }
  private textChunk(text: string): void {
    const before = this.result.toString().length;
    this.result.append(text);
    const accepted = this.result.toString().slice(before);
    this.messagePublished += accepted;
    this.chunks(accepted, false);
  }
  private textLength(): number {
    let length = 0;
    for (const block of this.blocks.values()) if (block.kind === "text") length += block.shown.length;
    return length;
  }
  private reasoningChunk(text: string): void {
    const before = this.reasoning.toString().length;
    this.reasoning.append(text);
    this.chunks(this.reasoning.toString().slice(before), true);
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
  private block(index: number, kind: PiBlockKind): PiBlock {
    const existing = this.blocks.get(`${kind}:${index}`);
    if (existing) return existing;
    if (this.blocks.size >= MAX_PI_CONTENT_BLOCKS) throw new Error("Pi returned too many content blocks.");
    const block = { index, kind, shown: "", redactor: this.redact.streamRedactor(), ended: false };
    this.blocks.set(`${kind}:${index}`, block);
    return block;
  }
  /** Appends while the block is the last of its kind with text; otherwise the message is republished later. */
  private publish(block: PiBlock, chunk: string): void {
    if (!chunk) return;
    block.shown += chunk;
    if (block.kind === "text" && this.catchingUp && this.republishing) {
      this.dirty.text = true;
      if (this.textLength() >= this.closedSegmentText.length) this.republish("text");
      return;
    }
    const later = [...this.blocks.values()].some((other) => other.kind === block.kind && other.index > block.index && other.shown);
    if ((this.dirty[block.kind] || later) && this.republishing) this.dirty[block.kind] = true;
    else if (block.kind === "text") this.textChunk(chunk);
    else this.reasoningChunk(chunk);
  }
  /**
   * T3 4ecbe5508: the message's blocks of one kind, in content order, replace what the message showed. Text
   * replaces only the open segment (T3 replaces only the block's item): earlier messages, and text this message
   * left in segments the runtime closed, keep their place around the activity after them. The run's final text
   * always matches what streamed.
   */
  private republish(kind: PiBlockKind): void {
    this.dirty[kind] = false;
    const display = [...this.blocks.values()].filter((block) => block.kind === kind)
      .sort((left, right) => left.index - right.index).map(({ shown }) => shown).join("");
    if (kind === "thinking") {
      const reasoning = rebuilt(this.reasoningBefore, this.reasoningClosedBefore, display);
      if (reasoning.toString() === this.reasoning.toString() || !this.count(reasoning.toString().length)) return;
      this.reasoning = reasoning;
      this.emit.rich({ type: "reasoning-summary", text: reasoning.toString(), replace: true });
      return;
    }
    const closed = this.closedSegmentText;
    // A closed segment cannot change without moving text past the activity after it. While the restarted block
    // streams again what it already shows, nothing new is shown. Text that differs inside the closed text follows
    // the activity whole: the abandoned text stays above it, never spliced into the restarted text.
    this.catchingUp = !display.startsWith(closed) && closed.startsWith(display);
    const diverged = !display.startsWith(closed) && !this.catchingUp;
    const wanted = diverged ? `${closed}${display}` : this.catchingUp ? closed : display;
    const shown = rebuilt(this.resultBefore, this.resultClosedBefore, wanted);
    const message = shown.toString().slice(this.resultBefore.length);
    if (message === this.messagePublished) return;
    const segment = message.slice(closed.length);
    if (!this.count(segment.length)) {
      this.catchingUp = false;
      return;
    }
    // The final text keeps the two attempts apart, as the runtime keeps them in two segments, so the end-of-run
    // reconcile maps it onto them unchanged.
    this.result = diverged && closed ? rebuilt(this.resultBefore, this.resultClosedBefore, `${closed}\n\n${segment}`) : shown;
    this.messagePublished = message;
    this.emit.textSnapshot(`pi:${this.messageCount}:text`, segment, "segment");
  }
  private count(chars: number): boolean {
    if (!this.republishing) return false;
    this.republishedChars += chars;
    return this.republishing;
  }
  /** A block Pi starts again (a reconnect mid-block) abandons its earlier text; a finished block stays. */
  private restart(index: number, kind: PiBlockKind): void {
    const block = this.blocks.get(`${kind}:${index}`);
    if (!block || block.ended) return;
    const shown = block.shown;
    block.redactor.discard();
    block.redactor = this.redact.streamRedactor();
    block.shown = "";
    if (shown) this.republish(kind);
  }
  /** A finished block's final content, when Pi sends it, replaces what streamed. */
  private end(index: number, kind: PiBlockKind, content: string | null): void {
    const existing = this.blocks.get(`${kind}:${index}`);
    if (existing?.ended || (!existing && !content)) return;
    const block = existing ?? this.block(index, kind);
    block.ended = true;
    if (kind === "text") this.streamed = true;
    else this.streamedReasoning = true;
    let tail = block.redactor.finish("significant");
    if (content) {
      const redactor = this.redact.streamRedactor();
      const final = redactor.push(content) + redactor.finish("significant");
      if (final.startsWith(block.shown)) tail = final.slice(block.shown.length);
      else {
        tail = "";
        block.shown = final;
        this.dirty[kind] = true;
      }
    }
    this.publish(block, tail);
    if (this.dirty[kind]) this.republish(kind);
  }
  private contentUpdate(delta: JsonObject): void {
    const kind = blockKind(delta.type);
    if (!kind) return;
    const index = delta.contentIndex ?? 0;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > MAX_PI_CONTENT_INDEX) {
      throw new Error("Pi returned an invalid content block.");
    }
    if (delta.type === `${kind}_start`) this.restart(index, kind);
    else if (delta.type === `${kind}_end`) {
      const content = typeof delta.content === "string" ? delta.content : typeof delta.thinking === "string" ? delta.thinking : null;
      this.end(index, kind, content);
    } else if (typeof delta.delta === "string") {
      const block = this.block(index, kind);
      if (block.ended) return;
      if (kind === "text") this.streamed = true;
      else this.streamedReasoning = true;
      this.publish(block, block.redactor.push(delta.delta));
    }
  }
  finish(): void {
    for (const block of [...this.blocks.values()].sort((left, right) => left.index - right.index)) {
      this.publish(block, block.redactor.finish("significant"));
    }
    for (const kind of ["text", "thinking"] as const) if (this.dirty[kind]) this.republish(kind);
  }
  receive(raw: JsonObject): void {
    this.budget.observe(raw);
    if (raw.type === "message_update") {
      const delta = objectValue(raw.assistantMessageEvent);
      if (typeof delta?.delta === "string" && delta.delta.length > 64 * 1024) throw new Error("Pi text update exceeded its limit.");
      if (delta) this.contentUpdate(delta);
      return;
    }
    const event = this.redact.payload(raw);
    if (event.type === "message_start" && objectValue(event.message)?.role === "assistant") {
      this.finish(); this.redact = new AcpSecretRedactor(this.environment); this.streamed = false; this.streamedReasoning = false; this.failed = false;
      if (this.messageCount++ > 0) { this.result.append("\n\n"); this.emit.textBoundary(); }
      this.blocks = new Map(); this.dirty.text = false; this.dirty.thinking = false;
      this.messagePublished = ""; this.closedSegmentText = ""; this.catchingUp = false;
      this.resultBefore = this.result.toString(); this.resultClosedBefore = this.result.truncated;
      this.reasoningBefore = this.reasoning.toString(); this.reasoningClosedBefore = this.reasoning.truncated;
    } else if (event.type === "message_end") {
      const message = objectValue(event.message);
      if (message?.role !== "assistant") return;
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          const block = objectValue(part);
          if (!this.streamed && block?.type === "text" && typeof block.text === "string") this.textChunk(block.text);
          if (!this.streamedReasoning && block?.type === "thinking" && typeof block.thinking === "string") this.reasoningChunk(block.thinking);
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
        { activityId: tool.activityId, detail: event.args ? clipCodeUnits(JSON.stringify(event.args), 16_384) : undefined });
    } else if (event.type === "tool_execution_end") {
      const tool = typeof raw.toolCallId === "string" ? this.tools.get(raw.toolCallId) : undefined;
      if (!tool || tool.name !== raw.toolName) throw new Error("Pi completed an unknown or mismatched tool.");
      this.tools.delete(raw.toolCallId as string);
      const content = objectValue(event.result)?.content;
      const detail = Array.isArray(content) ? clipCodeUnits(content.flatMap((part) => {
        const block = objectValue(part); return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
      }).join("\n"), 16_384) : undefined;
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
