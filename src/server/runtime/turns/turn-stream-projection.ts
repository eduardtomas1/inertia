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

export interface TurnStreamProjectionOptions {
  store: RuntimeStore;
  hooks: TurnControllerHooks;
  scheduler: TurnTimerScheduler;
  now(): string;
  onPersistenceFailure(active: ActiveTurn, error: unknown): void;
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
    const accepted = text.slice(
      0,
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
    active.assistantStream.flush();
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
    const accepted = text.slice(
      0,
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
    if (!result.text || result.text === active.assistantText) return;
    const finalText = result.text.slice(0, MAX_ASSISTANT_TEXT);
    if (finalText.startsWith(active.assistantText)) {
      this.appendAssistant(
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
      this.appendAssistant(active, finalText);
      return;
    }
    const correctedSegment = finalText.startsWith(completedPrefix)
      ? finalText.slice(completedPrefix.length)
      : finalText;
    active.assistantText = `${completedPrefix}${correctedSegment}`;
    active.assistantSegmentText = correctedSegment;
    active.assistantStream.replacePending(correctedSegment);
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
