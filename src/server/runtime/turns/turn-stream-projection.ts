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

function sharedPrefixLength(left: string, right: string): number {
  let common = 0;
  while (
    common < left.length
    && common < right.length
    && left.charCodeAt(common) === right.charCodeAt(common)
  ) common += 1;
  const last = right.charCodeAt(common - 1);
  if (common > 0 && last >= 0xd800 && last <= 0xdbff) common -= 1;
  return common;
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
      onFlushStarted: () => {
        this.options.hooks.testOnlyStreamingTrace?.mark("stream-flush-started");
      },
      onTimerError: (error) => {
        const current = active();
        if (current.runState.isTerminal()) return;
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
    this.options.hooks.testOnlyStreamingTrace?.mark("delta-accepted-by-channel");
    active.assistantStream.append(accepted);
  }

  /**
   * A visible provider event closes uninterrupted commentary so execution
   * activity never gets flattened across assistant prose boundaries.
   */
  closeAssistantSegment(active: ActiveTurn): boolean {
    const closed = this.closeOpenAssistantSegment(active);
    const pending = active.pendingFollowUpBoundary;
    if (pending) this.commitFollowUpBoundary(active, pending.at, pending.messageId);
    return closed;
  }

  prepareFollowUp(active: ActiveTurn): { deferred: boolean; after: string | null } {
    const deferred = Boolean(active.assistantSegmentText);
    if (deferred) this.flush(active, "assistant");
    else this.closeAssistantSegment(active);
    const latest = active.latestAssistantMessageId
      ? this.options.store.message(active.latestAssistantMessageId).createdAt
      : null;
    const after = [
      latest,
      active.followUpBoundary?.at,
      active.pendingFollowUpBoundary?.at,
    ].reduce<string | null>((current, value) =>
      value && (!current || Date.parse(value) > Date.parse(current))
        ? value
        : current, null);
    return { deferred, after };
  }

  recordFollowUp(active: ActiveTurn, createdAt: string, deferred: boolean): void {
    if (deferred) {
      active.pendingFollowUpBoundary = {
        at: createdAt,
        messageId: active.latestAssistantMessageId,
      };
    } else {
      this.commitFollowUpBoundary(active, createdAt, active.latestAssistantMessageId);
    }
  }

  terminalAssistantMessageId(active: ActiveTurn): string | null {
    const boundary = active.pendingFollowUpBoundary ?? active.followUpBoundary;
    const latest = active.latestAssistantMessageId;
    if (!boundary || boundary.messageId !== latest) return latest;
    // A follow-up the provider never read is not this run's input, so the
    // answer before it still ends the run.
    return latest && this.onlyUnreadFollowUpsAfter(active, latest) ? latest : null;
  }

  /**
   * Whether every follow-up after the answer leaves this run for the queue.
   * Past the queue's cap an unread follow-up stays in its turn, delivered.
   */
  private onlyUnreadFollowUpsAfter(active: ActiveTurn, messageId: string): boolean {
    const unread = active.unreadFollowUpMessageIds ?? [];
    if (unread.length === 0) return false;
    const queued = new Set(this.options.store.queuedMessages.queueableUnreadFollowUps(
      active.conversation.id, active.turn.id, unread));
    const answeredAt = Date.parse(this.options.store.message(messageId).createdAt);
    const later = [...(active.followUpMessagesBySteerId?.values() ?? [])]
      .filter((followUpId) => Date.parse(this.options.store.message(followUpId).createdAt) > answeredAt);
    return later.length > 0 && later.every((followUpId) => queued.has(followUpId));
  }

  private commitFollowUpBoundary(
    active: ActiveTurn,
    at: string,
    messageId: string | null,
  ): void {
    active.pendingFollowUpBoundary = null;
    active.followUpBoundary = { at, text: active.assistantText, messageId };
  }

  private rebasedOnFollowUp(active: ActiveTurn, text: string): string {
    const preserved = active.followUpBoundary?.text;
    if (!preserved || text.startsWith(preserved)) return text;
    const common = sharedPrefixLength(preserved, text);
    if (sharedPrefixLength(active.assistantSegmentText, text) >= common) {
      return `${preserved}${text}`;
    }
    return `${preserved}${text.slice(common)}`;
  }

  private closeOpenAssistantSegment(active: ActiveTurn): boolean {
    if (!active.assistantSegmentText) {
      this.dropEmptyOpenAssistantMessage(active);
      return false;
    }
    this.flush(active, "assistant");
    const messageId = active.assistantMessageId;
    if (!messageId) {
      throw new Error("Persisted commentary is missing its message identity.");
    }
    this.options.hooks.broadcast({
      type: "agent.commentary.persisted",
      message: this.options.store.message(messageId),
    });
    (active.closedAssistantSegmentEnds ??= []).push(active.assistantText.length);
    active.assistantSegmentText = "";
    active.assistantMessageId = null;
    return true;
  }

  /**
   * An open segment the provider emptied keeps its message, and its id, while it may still stream: a follow-up
   * placed after it stays placed. It is deleted only when the segment closes or the turn settles still empty, and
   * a follow-up placed after it then follows the message before it, so no placement points at a deleted message
   * and nothing empty is kept or becomes the turn's terminal message.
   */
  dropEmptyOpenAssistantMessage(active: ActiveTurn): void {
    const messageId = active.assistantMessageId;
    if (!messageId || active.assistantSegmentText) return;
    active.assistantStream.replacePending("");
    const latest = this.options.store.transcriptRepository.deleteAssistantMessage(active.turn.id, messageId);
    active.assistantMessageId = null;
    if (active.latestAssistantMessageId === messageId) active.latestAssistantMessageId = latest;
    if (active.pendingFollowUpBoundary?.messageId === messageId) {
      active.pendingFollowUpBoundary = { ...active.pendingFollowUpBoundary, messageId: latest };
    }
    if (active.followUpBoundary?.messageId === messageId) {
      active.followUpBoundary = { ...active.followUpBoundary, messageId: latest };
    }
    this.options.hooks.broadcast({ type: "conversation.detail.invalidated", conversationId: active.conversation.id });
  }

  /**
   * The open segment's text in a final result that holds the closed segments first, in order, each optionally
   * after blank lines: Codex and Claude concatenate their messages, Pi, Grok and OpenCode join them with a blank
   * line. Null when the result does not cover the closed segments (a harness that returns only its last message).
   */
  private finalOpenSegment(active: ActiveTurn, result: string): string | null {
    const ends = active.closedAssistantSegmentEnds ?? [];
    if (ends.length === 0) return null;
    let at = 0;
    let start = 0;
    for (const end of ends) {
      const segment = active.assistantText.slice(start, end);
      start = end;
      while (!result.startsWith(segment, at)) {
        if (!result.startsWith("\n\n", at)) return null;
        at += 2;
      }
      at += segment.length;
    }
    const open = result.slice(at);
    return active.assistantSegmentText.startsWith("\n\n") ? open : open.replace(/^(?:\n\n)+/u, "");
  }

  private assistantCreatedAt(active: ActiveTurn): string {
    const now = this.options.now();
    const boundary = active.followUpBoundary?.at;
    if (!boundary) return now;
    return new Date(Math.max(Date.parse(now), Date.parse(boundary) + 1)).toISOString();
  }

  appendReasoning(active: ActiveTurn, text: string): void {
    const normalized = this.normalizeIngress(active, "reasoning", text, false);
    this.appendNormalizedReasoning(active, normalized);
  }

  /**
   * The provider's whole reasoning for the run replaces what streamed (Pi starting a thinking block again, T3
   * 4ecbe5508). Unflushed deltas belong to the replaced text and are dropped; the record and renderers take the
   * replacement at once.
   */
  replaceReasoning(active: ActiveTurn, text: string): void {
    const replacement = normalizedPrefix(normalizeStreamText(text), MAX_REASONING_TEXT);
    // Unsaved deltas are part of `reasoningText`: an equal replacement leaves them to flush as usual.
    if (replacement === active.reasoningText) return;
    active.reasoningPendingHighSurrogate = "";
    active.reasoningStream.replacePending("");
    active.reasoningText = replacement;
    if (!active.reasoningId && !replacement) return;
    active.reasoningId ??= this.options.store.createReasoning(active.conversation.id, active.turn.runId, active.turn.id).id;
    this.options.store.updateReasoning(active.reasoningId, { content: replacement });
    try {
      this.options.hooks.onStreamingPersisted?.({ turnId: active.turn.id, kind: "reasoning", recordId: active.reasoningId });
    } catch {
      // Optional downstream hooks cannot invalidate durable stream storage.
    }
    this.options.hooks.broadcast({ type: "agent.reasoning", conversationId: active.conversation.id,
      runId: active.turn.runId, turnId: active.turn.id, text: replacement, replace: true });
  }

  /**
   * The provider's text for the open assistant segment replaces what it streamed there (Pi starting a text block
   * again, T3 4ecbe5508). Closed segments, and their order around activity, stay untouched; like the terminal
   * correction in `reconcileAssistant`, only the open segment moves.
   */
  replaceAssistantSegment(active: ActiveTurn, text: string): void {
    const completedPrefix = active.assistantText.slice(0, active.assistantText.length - active.assistantSegmentText.length);
    const segment = normalizedPrefix(normalizeStreamText(text), Math.max(0, MAX_ASSISTANT_TEXT - completedPrefix.length));
    // Unsaved deltas are part of the segment: an equal replacement leaves them to flush as usual.
    if (segment === active.assistantSegmentText) return;
    active.assistantPendingHighSurrogate = "";
    active.assistantText = `${completedPrefix}${segment}`;
    active.assistantSegmentText = segment;
    active.assistantStream.replacePending("");
    if (active.assistantMessageId) {
      this.options.store.updateMessageContent(active.assistantMessageId, segment);
    } else if (segment) {
      active.assistantMessageId = this.options.store.createMessage(active.conversation.id, segment, "assistant", [],
        active.turn.id, this.assistantCreatedAt(active)).id;
      active.latestAssistantMessageId = active.assistantMessageId;
    }
    if (active.assistantMessageId) {
      try {
        this.options.hooks.onStreamingPersisted?.({ turnId: active.turn.id, kind: "assistant", recordId: active.assistantMessageId });
      } catch {
        // Optional downstream hooks cannot invalidate durable stream storage.
      }
    }
    this.options.hooks.broadcast({ type: "agent.text", conversationId: active.conversation.id,
      runId: active.turn.runId, turnId: active.turn.id, text: segment, replace: true });
    // A detail loaded before the replacement holds the abandoned text as the open segment's persisted message.
    this.options.hooks.broadcast({ type: "conversation.detail.invalidated", conversationId: active.conversation.id });
  }

  private appendNormalizedReasoning(active: ActiveTurn, text: string): void {
    const accepted = normalizedPrefix(
      text,
      Math.max(0, MAX_REASONING_TEXT - active.reasoningText.length),
    );
    if (!accepted) return;
    active.reasoningText += accepted;
    this.options.hooks.testOnlyStreamingTrace?.mark("delta-accepted-by-channel");
    active.reasoningStream.append(accepted);
  }

  reconcileAssistant(
    active: ActiveTurn,
    result: ProviderRunResult,
  ): void {
    if (!result.text) return;
    // A harness that joins messages with a blank line starts its result with one when an earlier message had no text.
    const joined = normalizeStreamText(result.text);
    const normalizedResult = active.assistantText.startsWith("\n\n") ? joined : joined.replace(/^(?:\n\n)+/u, "");
    active.assistantPendingHighSurrogate = "";
    if (normalizedResult === active.assistantText) return;
    const finalSegment = this.finalOpenSegment(active, normalizedResult);
    if (finalSegment !== null) {
      const completed = active.assistantText.slice(0, active.assistantText.length - active.assistantSegmentText.length);
      const corrected = normalizedPrefix(finalSegment, Math.max(0, MAX_ASSISTANT_TEXT - completed.length));
      if (corrected === active.assistantSegmentText
        || (result.textTruncated && active.assistantSegmentText.startsWith(corrected))) return;
      if (corrected.startsWith(active.assistantSegmentText)) {
        this.appendNormalizedAssistant(active, corrected.slice(active.assistantSegmentText.length));
        return;
      }
      // An emptied segment is told to renderers like a live replacement; settlement then drops its message.
      if (!corrected) {
        this.replaceAssistantSegment(active, "");
        return;
      }
      active.assistantText = `${completed}${corrected}`;
      active.assistantSegmentText = corrected;
      active.assistantStream.replacePending(corrected);
      return;
    }
    const finalText = normalizedPrefix(
      this.rebasedOnFollowUp(active, normalizedResult),
      MAX_ASSISTANT_TEXT,
    );
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
    const providerText = normalizedPrefix(normalizedResult, MAX_ASSISTANT_TEXT);
    const completedPrefix = active.assistantText.slice(
      0,
      active.assistantText.length - active.assistantSegmentText.length,
    );
    if (
      completedPrefix
      && !active.assistantSegmentText
      && !finalText.startsWith(completedPrefix)
    ) {
      if (!completedPrefix.endsWith(providerText)) {
        this.appendNormalizedAssistant(active, providerText);
      }
      return;
    }
    const correctedSegment = finalText.startsWith(completedPrefix)
      ? finalText.slice(completedPrefix.length)
      : providerText;
    active.assistantText = `${completedPrefix}${correctedSegment}`;
    active.assistantSegmentText = correctedSegment;
    active.assistantStream.replacePending(correctedSegment);
  }

  /**
   * Replaces every assistant segment for this active turn with one
   * provider-authored authoritative snapshot. Existing durable segments are
   * consolidated transactionally before any active or renderer state moves.
   */
  replaceAssistantSnapshot(active: ActiveTurn, text: string): ReturnType<RuntimeStore["message"]> | null {
    const normalizedText = normalizeStreamText(text);
    if (!normalizedText && active.pendingFollowUpBoundary) {
      this.closeAssistantSegment(active);
    }
    const snapshotText = normalizedPrefix(
      this.rebasedOnFollowUp(active, normalizedText),
      MAX_ASSISTANT_TEXT,
    );
    const boundary = active.followUpBoundary ?? null;
    const preservedText = boundary?.text ?? "";
    const finalText = snapshotText.slice(preservedText.length);
    active.closedAssistantSegmentEnds = (active.closedAssistantSegmentEnds ?? []).filter((end) => end <= preservedText.length);
    const latestAfterBoundary = active.latestAssistantMessageId !== boundary?.messageId
      ? active.latestAssistantMessageId
      : null;
    let retainedMessageId = finalText
      ? active.assistantMessageId ?? latestAfterBoundary
      : null;
    if (retainedMessageId || !finalText) {
      this.options.store.transcriptRepository
        .replaceAssistantMessagesForTurnSnapshot(
          active.turn.id,
          retainedMessageId,
          finalText,
          boundary?.at ?? null,
        );
    } else {
      // With no durable segment there are no siblings to consolidate. Creating
      // the canonical message is itself the only persistence mutation.
      retainedMessageId = this.options.store.createMessage(
        active.conversation.id,
        finalText,
        "assistant",
        [],
        active.turn.id,
        this.assistantCreatedAt(active),
      ).id;
    }
    active.assistantPendingHighSurrogate = "";
    active.assistantStream.replacePending("");
    active.assistantText = `${preservedText}${finalText}`;
    active.assistantSegmentText = finalText;
    active.assistantMessageId = retainedMessageId;
    active.latestAssistantMessageId = retainedMessageId ?? boundary?.messageId ?? null;
    if (retainedMessageId) {
      try {
        this.options.hooks.onStreamingPersisted?.({
          turnId: active.turn.id,
          kind: "assistant",
          recordId: retainedMessageId,
        });
      } catch {
        // Optional downstream hooks cannot invalidate durable stream storage.
      }
    }
    return retainedMessageId
      ? this.options.store.message(retainedMessageId)
      : null;
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
    this.options.hooks.testOnlyStreamingTrace?.mark("sqlite-append-started");
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
          this.assistantCreatedAt(active),
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
    this.options.hooks.testOnlyStreamingTrace?.mark("sqlite-append-completed");

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
    this.options.hooks.testOnlyStreamingTrace?.mark("projection-event-created");
    this.options.hooks.broadcast({
      type: kind === "assistant" ? "agent.text" : "agent.reasoning",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      text: flush.delta,
    });
  }
}
