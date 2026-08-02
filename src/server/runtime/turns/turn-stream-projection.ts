import type { RuntimeStore } from "../../database";
import type { ProviderRunResult } from "../../provider/contracts";
import {
  MAX_ASSISTANT_TEXT,
  MAX_REASONING_TEXT,
} from "./turn-controller-support";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnTimerScheduler,
} from "./turn-controller-types";
import {
  type StreamDeltaFlush,
} from "./turn-stream-coalescer";
import { TurnStreamChannel } from "./turn-stream-channel";
import { normalizeStreamText } from "../../persistence/stream-text-storage";

export interface TurnStreamProjectionOptions {
  store: RuntimeStore;
  hooks: TurnControllerHooks;
  scheduler: TurnTimerScheduler;
  now(): string;
  onPersistenceFailure(active: ActiveTurn, error: unknown): void;
}

function normalizedPrefix(value: string, maximumCodeUnits: number): string {
  if (value.length <= maximumCodeUnits) return value;
  let end = maximumCodeUnits;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (
    last >= 0xd800
    && last <= 0xdbff
    && next >= 0xdc00
    && next <= 0xdfff
  ) end -= 1;
  return value.slice(0, end);
}

/**
 * Owns persistence and renderer projection for the two coalesced text
 * channels. Commentary segmentation remains state on the authoritative turn.
 */
export class TurnStreamProjection {
  constructor(private readonly options: TurnStreamProjectionOptions) {}

  create(
    active: () => ActiveTurn,
    kind: "assistant" | "reasoning",
  ): TurnStreamChannel {
    return new TurnStreamChannel({
      scheduler: this.options.scheduler,
      onProjectionFlush: (flush) => this.broadcast(active(), kind, flush),
      onPersistenceFlush: (flush) => this.persist(active(), kind, flush),
      onTimerError: (error) => {
        const current = active();
        if (current.settled) return;
        this.options.onPersistenceFailure(current, error);
      },
    });
  }

  appendAssistant(active: ActiveTurn, text: string): void {
    const normalized = this.normalizeIngress(active, "assistant", text, false);
    this.appendNormalizedAssistant(active, normalized);
  }

  private appendNormalizedAssistant(active: ActiveTurn, text: string): void {
    const accepted = normalizedPrefix(
      text,
      Math.max(0, MAX_ASSISTANT_TEXT - active.assistantText.length),
    );
    if (!accepted) return;
    active.assistantText += accepted;
    active.assistantSegmentText += accepted;
    active.assistantStream.append(accepted);
  }

  /**
   * A visible provider event closes uninterrupted commentary so execution
   * activity never gets flattened across assistant prose boundaries.
   */
  closeAssistantSegment(active: ActiveTurn): boolean {
    if (!active.assistantSegmentText) return false;
    this.flush(active, "assistant");
    const messageId = active.assistantMessageId;
    if (!messageId) {
      throw new Error("Persisted commentary is missing its message identity.");
    }
    this.options.hooks.broadcast({
      type: "agent.commentary.persisted",
      message: this.options.store.message(messageId),
    });
    active.assistantSegmentText = "";
    active.assistantMessageId = null;
    return true;
  }

  appendReasoning(active: ActiveTurn, text: string): void {
    const normalized = this.normalizeIngress(active, "reasoning", text, false);
    this.appendNormalizedReasoning(active, normalized);
  }

  private appendNormalizedReasoning(active: ActiveTurn, text: string): void {
    const accepted = normalizedPrefix(
      text,
      Math.max(0, MAX_REASONING_TEXT - active.reasoningText.length),
    );
    if (!accepted) return;
    active.reasoningText += accepted;
    active.reasoningStream.append(accepted);
  }

  reconcileAssistant(
    active: ActiveTurn,
    result: ProviderRunResult,
  ): void {
    if (!result.text) return;
    const normalizedResult = normalizeStreamText(result.text);
    active.assistantPendingHighSurrogate = "";
    if (normalizedResult === active.assistantText) return;
    const finalText = normalizedPrefix(normalizedResult, MAX_ASSISTANT_TEXT);
    if (finalText.startsWith(active.assistantText)) {
      this.appendNormalizedAssistant(
        active,
        finalText.slice(active.assistantText.length),
      );
      return;
    }
    if (result.textTruncated && active.assistantText.startsWith(finalText)) {
      return;
    }
    const completedPrefix = active.assistantText.slice(
      0,
      active.assistantText.length - active.assistantSegmentText.length,
    );
    if (
      completedPrefix
      && !active.assistantSegmentText
      && !finalText.startsWith(completedPrefix)
    ) {
      this.appendNormalizedAssistant(active, finalText);
      return;
    }
    const correctedSegment = finalText.startsWith(completedPrefix)
      ? finalText.slice(completedPrefix.length)
      : finalText;
    active.assistantText = `${completedPrefix}${correctedSegment}`;
    active.assistantSegmentText = correctedSegment;
    active.assistantStream.replacePending(correctedSegment);
  }

  flush(active: ActiveTurn, kind: "assistant" | "reasoning"): boolean {
    const normalized = this.normalizeIngress(active, kind, "", true);
    if (kind === "assistant") this.appendNormalizedAssistant(active, normalized);
    else this.appendNormalizedReasoning(active, normalized);
    return kind === "assistant"
      ? active.assistantStream.flush()
      : active.reasoningStream.flush();
  }

  private normalizeIngress(
    active: ActiveTurn,
    kind: "assistant" | "reasoning",
    text: string,
    final: boolean,
  ): string {
    const pendingKey = kind === "assistant"
      ? "assistantPendingHighSurrogate"
      : "reasoningPendingHighSurrogate";
    let combined = active[pendingKey] + text;
    active[pendingKey] = "";
    if (!final && combined.length > 0) {
      const last = combined.charCodeAt(combined.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        active[pendingKey] = combined.at(-1)!;
        combined = combined.slice(0, -1);
      }
    }
    return normalizeStreamText(combined);
  }

  private persist(
    active: ActiveTurn,
    kind: "assistant" | "reasoning",
    flush: StreamDeltaFlush,
  ): void {
    let recordId: string;
    if (kind === "assistant") {
      if (active.assistantMessageId) {
        if (flush.replacement) {
          this.options.store.updateMessageContent(
            active.assistantMessageId,
            active.assistantSegmentText,
          );
        } else {
          this.options.store.appendMessageContent(
            active.assistantMessageId,
            flush.delta,
          );
        }
      } else {
        active.assistantMessageId = this.options.store.createMessage(
          active.conversation.id,
          active.assistantSegmentText,
          "assistant",
          [],
          active.turn.id,
          this.options.now(),
        ).id;
        active.latestAssistantMessageId = active.assistantMessageId;
      }
      recordId = active.assistantMessageId;
    } else {
      if (!active.reasoningId) {
        active.reasoningId = this.options.store.createReasoning(
          active.conversation.id,
          active.turn.runId,
          active.turn.id,
        ).id;
      }
      if (flush.replacement) {
        this.options.store.updateReasoning(active.reasoningId, {
          content: active.reasoningText,
        });
      } else {
        this.options.store.appendReasoningContent(
          active.reasoningId,
          flush.delta,
        );
      }
      recordId = active.reasoningId;
    }

    try {
      this.options.hooks.onStreamingPersisted?.({
        turnId: active.turn.id,
        kind,
        recordId,
      });
    } catch {
      // Optional downstream hooks cannot invalidate durable stream storage.
    }
  }

  private broadcast(
    active: ActiveTurn,
    kind: "assistant" | "reasoning",
    flush: StreamDeltaFlush,
  ): void {
    // A terminal correction is projected by the authoritative snapshot.
    // Treating its complete value as an append-only delta would duplicate text.
    if (flush.replacement) return;
    this.options.hooks.broadcast({
      type: kind === "assistant" ? "agent.text" : "agent.reasoning",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      text: flush.delta,
    });
  }
}
