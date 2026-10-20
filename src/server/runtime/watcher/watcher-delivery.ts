import type WebSocket from "ws";

import type { ChatMessage, ServerEvent } from "../../../shared/contracts";
import { supportsActiveParentFollowUp } from "../../../shared/follow-up-steer";
import type { MessageQueueResult } from "../../../shared/queued-messages";
import { watcherAgentLabel } from "../../../shared/watcher-agent-label";
import {
  MAX_WATCHER_NOTE_CHARS,
  watcherReplaceLineSeparators,
  type WatcherDelivery,
  type WatcherDeliveryMode,
  type WatcherNoteAttribution,
} from "../../../shared/watcher";
import type { RuntimeStore } from "../../database";
import type { WatcherLinkRecord, WatcherWakeRecord } from "../../persistence/watcher-link-repository";
import { PROVIDER_INFO } from "../../provider/catalog";
import { publicRuntimeError, RuntimeRequestError } from "../../runtime-errors";
import {
  createTurnInteractionCommandHandler,
  type TurnInteractionCommandDependencies,
} from "../commands/turn-interaction-commands";
import type { TurnController } from "../turns/turn-controller";
import { neutralizeUntrustedAgentText } from "../untrusted-agent-text";
import { watcherNoteDelivery, watcherSteerContent } from "./watcher-note-instruction";

/**
 * `delivery.detail` explains only what state and mode do not: a fallback
 * from Steer, a queued note that went out later, or why it was not sent. The
 * plain queued, sent and steered outcomes carry no detail. Each fixed detail
 * is a lowercase fragment the renderer appends to its own status line.
 */
export const WATCHER_DELIVERY_DETAIL = Object.freeze({
  turnEnded: "the turn ended before the note arrived",
  refused: "the agent didn't take the note mid-turn",
  idle: "the main chat wasn't running",
  dispatchedLater: "after the turn ended",
  steeredFromQueue: "into the running turn",
  removed: "it was removed from the main chat's queue",
});

type QueueReason = "queue" | "steer-idle" | "turn-ended" | "refused";

const QUEUE_DETAILS: Readonly<Record<QueueReason, string | null>> = Object.freeze({
  queue: null,
  "steer-idle": WATCHER_DELIVERY_DETAIL.idle,
  "turn-ended": WATCHER_DELIVERY_DETAIL.turnEnded,
  refused: WATCHER_DELIVERY_DETAIL.refused,
});

export interface WatcherDeliveryResult {
  kind: "watcher.delivery";
  linkId: string;
  wakeId: string;
  delivery: WatcherDelivery;
  queue?: MessageQueueResult;
}

export interface WatcherNoteQueue {
  enqueueWatcherNote(input: {
    conversationId: string;
    id: string;
    content: string;
    watcherNote: WatcherNoteAttribution;
  }): MessageQueueResult;
  /** Removes a waiting or blocked watcher note before the finding is sent again. */
  withdrawWatcherNote?(conversationId: string, id: string): boolean;
}

export interface WatcherDeliveryDependencies {
  store: RuntimeStore;
  turns: Pick<TurnController, "isActive" | "acquireFollowUpAdmission" | "steer">;
  /** The same server-side dependencies the message commands use. */
  interaction(): TurnInteractionCommandDependencies | undefined;
  queue(): WatcherNoteQueue | undefined;
  /** Provider labels keyed by provider id: the runtime's provider labels under the user's identity labels. */
  providerLabels(): Readonly<Record<string, string | undefined>>;
  now(): string;
  /** The link's feed changed; republish it. */
  changed(linkId: string): void;
}

function clipCodeUnits(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const last = value.charCodeAt(maximum - 1);
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? maximum - 1 : maximum);
}

/**
 * The watcher's agent as the note attribution names it: the shared
 * `watcherAgentLabel`, fed with the same provider labels the renderer's dock
 * uses (runtime provider labels under the user's identity labels), so the
 * note divider and the dock read the same.
 */
export function watcherLabel(
  store: Pick<RuntimeStore, "conversation" | "shellSnapshot">,
  watcherConversationId: string,
  providerLabels: Readonly<Record<string, string | undefined>> = {},
): string {
  const conversation = store.conversation(watcherConversationId);
  const labels = {
    ...Object.fromEntries(Object.entries(PROVIDER_INFO).map(([id, info]) => [id, info.name])),
    ...providerLabels,
    ...store.shellSnapshot().settings.providerIdentityLabels,
  };
  return watcherAgentLabel(conversation, labels);
}

/** The neutralized note text the user forwards, capped at `MAX_WATCHER_NOTE_CHARS`. */
export function watcherNoteText(finding: string): string {
  const normalized = watcherReplaceLineSeparators(finding.replaceAll("\0", "�").replace(/\r\n?/gu, "\n"), "\n").trim();
  return clipCodeUnits(neutralizeUntrustedAgentText(normalized), MAX_WATCHER_NOTE_CHARS).trimEnd();
}

/**
 * Forwards a settled finding into the watched chat on the user's explicit
 * command. Queue is the default: an idle chat starts a turn at once, a busy
 * chat queues the note behind the user's own queued messages. Steer delivers
 * into a running turn on a steerable harness and falls back to queueing when
 * the turn ended or the agent refused it. Repeating a delivery id replays
 * its result; delivered and dismissed findings are final.
 */
export class WatcherDeliveryService {
  readonly #deps: WatcherDeliveryDependencies;
  readonly #inFlight = new Map<string, Promise<WatcherDeliveryResult>>();

  constructor(dependencies: WatcherDeliveryDependencies) {
    this.#deps = dependencies;
  }

  async deliver(
    linkId: string,
    wakeId: string,
    mode: WatcherDeliveryMode,
    deliveryId: string,
  ): Promise<WatcherDeliveryResult> {
    const running = this.#inFlight.get(wakeId);
    if (running) {
      await running.catch(() => undefined);
      return this.#replay(linkId, wakeId, deliveryId);
    }
    const operation = this.#deliver(linkId, wakeId, mode, deliveryId);
    this.#inFlight.set(wakeId, operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(wakeId);
    }
  }

  dismiss(linkId: string, wakeId: string): WatcherDeliveryResult {
    const found = this.#finding(linkId, wakeId);
    const wake = this.#reconcileQueued(found.link, found.wake);
    if (wake.delivery?.state === "dismissed") return this.#result(linkId, wake);
    if (wake.delivery?.state === "sent" || wake.delivery?.state === "queued") {
      throw new RuntimeRequestError("This finding was already sent to the main chat.");
    }
    if (this.#inFlight.has(wakeId)) throw new RuntimeRequestError("This finding is being sent.");
    const dismissed = this.#deps.store.watcherLinks.setDelivery(wakeId, { mode: null, state: "dismissed" }, this.#deps.now());
    if (!dismissed) throw new RuntimeRequestError("This finding can no longer be dismissed.");
    this.#deps.changed(linkId);
    return this.#result(linkId, dismissed);
  }

  /**
   * A forwarded note reached the watched chat as a user message. A queued
   * note, or one that failed in the queue and was then sent from it, is
   * marked sent: "after the turn ended" when it started a turn, or "into the
   * running turn" when it was sent into one. Notes this service is sending
   * right now record their own result.
   */
  noteDelivered(attribution: WatcherNoteAttribution, message: Pick<ChatMessage, "id" | "turnId">): void {
    if (this.#inFlight.has(attribution.wakeId)) return;
    const wake = this.#deps.store.watcherLinks.getWake(attribution.wakeId);
    if (!wake || wake.linkId !== attribution.linkId || !wake.delivery) return;
    const { state, mode } = wake.delivery;
    if (state !== "queued" && !(state === "failed" && mode === "queue")) return;
    const updated = this.#deps.store.watcherLinks.setDelivery(wake.wakeId, {
      mode: mode ?? attribution.delivery,
      state: "sent",
      detail: this.#startedTurn(message) ? WATCHER_DELIVERY_DETAIL.dispatchedLater : WATCHER_DELIVERY_DETAIL.steeredFromQueue,
      deliveredMessageId: message.id,
    }, this.#deps.now());
    if (updated) this.#deps.changed(attribution.linkId);
  }

  /**
   * A queued note left the main chat's queue without being sent: the user
   * removed it, a route change blocked it, or its dispatch failed. The
   * finding becomes `failed` with the reason, so it can be sent again or
   * dismissed.
   */
  noteUndelivered(attribution: WatcherNoteAttribution, reason: string): void {
    const wake = this.#deps.store.watcherLinks.getWake(attribution.wakeId);
    if (!wake || wake.linkId !== attribution.linkId || wake.delivery?.state !== "queued") return;
    const updated = this.#deps.store.watcherLinks.setDelivery(wake.wakeId, {
      mode: wake.delivery.mode ?? "queue",
      state: "failed",
      detail: reason.trim() || WATCHER_DELIVERY_DETAIL.removed,
    }, this.#deps.now());
    if (updated) this.#deps.changed(attribution.linkId);
  }

  #startedTurn(message: Pick<ChatMessage, "id" | "turnId">): boolean {
    if (message.turnId === null) return true;
    try {
      return this.#deps.store.agentTurn(message.turnId).userMessageId === message.id;
    } catch {
      return true;
    }
  }

  /**
   * A finding still recorded as queued whose queue entry is gone, blocked or
   * already accepted is brought up to date before the user acts on it. This
   * covers paths that bypass `noteUndelivered`, such as a restart.
   */
  #reconcileQueued(link: WatcherLinkRecord, wake: WatcherWakeRecord): WatcherWakeRecord {
    if (wake.delivery?.state !== "queued" || wake.queuedMessageId === null || link.watchedConversationId === null) return wake;
    const entry = this.#deps.store.queuedMessages.get(link.watchedConversationId, wake.queuedMessageId);
    let update: Parameters<RuntimeStore["watcherLinks"]["setDelivery"]>[1] | null = null;
    if (!entry || entry.state === "cancelled") {
      update = { mode: "queue", state: "failed", detail: WATCHER_DELIVERY_DETAIL.removed };
    } else if (entry.state === "blocked") {
      update = { mode: "queue", state: "failed", detail: entry.error ?? WATCHER_DELIVERY_DETAIL.removed };
    } else if (entry.state === "accepted") {
      update = {
        mode: "queue", state: "sent", detail: WATCHER_DELIVERY_DETAIL.dispatchedLater,
        ...(entry.userMessageId ? { deliveredMessageId: entry.userMessageId } : {}),
      };
    }
    if (!update) return wake;
    const updated = this.#deps.store.watcherLinks.setDelivery(wake.wakeId, update, this.#deps.now());
    if (!updated) return wake;
    this.#deps.changed(link.id);
    return updated;
  }

  #replay(linkId: string, wakeId: string, deliveryId: string): WatcherDeliveryResult {
    const { wake } = this.#finding(linkId, wakeId);
    if (wake.deliveryId === deliveryId && wake.delivery && wake.delivery.state !== "dismissed") {
      return this.#result(linkId, wake);
    }
    throw new RuntimeRequestError("This finding was already sent or dismissed.");
  }

  #finding(linkId: string, wakeId: string): { link: WatcherLinkRecord; wake: WatcherWakeRecord } {
    const link = this.#deps.store.watcherLinks.get(linkId);
    if (!link) throw new RuntimeRequestError("This watcher no longer exists.");
    const wake = this.#deps.store.watcherLinks.getWake(wakeId);
    if (!wake || wake.linkId !== linkId) throw new RuntimeRequestError("This check no longer exists.");
    if (wake.state !== "settled" || wake.outcome !== "finding" || wake.finding === null) {
      throw new RuntimeRequestError("Only a finding can be sent or dismissed.");
    }
    return { link, wake };
  }

  #result(linkId: string, wake: WatcherWakeRecord, queue?: MessageQueueResult): WatcherDeliveryResult {
    if (!wake.delivery) throw new Error("The watcher delivery was not recorded.");
    return { kind: "watcher.delivery", linkId, wakeId: wake.wakeId, delivery: wake.delivery, ...(queue ? { queue } : {}) };
  }

  async #deliver(
    linkId: string,
    wakeId: string,
    mode: WatcherDeliveryMode,
    deliveryId: string,
  ): Promise<WatcherDeliveryResult> {
    const found = this.#finding(linkId, wakeId);
    const { link } = found;
    const wake = this.#reconcileQueued(link, found.wake);
    if (wake.delivery?.state === "sent" || wake.delivery?.state === "queued") {
      if (wake.deliveryId === deliveryId) return this.#result(linkId, wake);
      throw new RuntimeRequestError("This finding was already sent to the main chat.");
    }
    if (wake.delivery?.state === "dismissed") throw new RuntimeRequestError("This finding was dismissed.");
    if (link.status === "detached" || link.watchedConversationId === null) {
      throw new RuntimeRequestError("This watcher no longer watches a chat.");
    }
    const watchedId = link.watchedConversationId;
    const watched = this.#deps.store.conversation(watchedId);
    if (watched.archivedAt !== null) throw new RuntimeRequestError("Unarchive the main chat before sending a note to it.");
    const note = watcherNoteText(wake.finding!);
    if (note.length === 0) throw new RuntimeRequestError("This finding has no text to send.");
    if (wake.delivery?.state === "failed" && wake.queuedMessageId !== null && wake.queuedMessageId !== deliveryId) {
      // A note blocked in the queue is withdrawn so sending again never forwards it twice.
      this.#deps.queue()?.withdrawWatcherNote?.(watchedId, wake.queuedMessageId);
    }
    const label = watcherLabel(this.#deps.store, link.watcherConversationId, this.#deps.providerLabels());
    const attribution = (delivery: WatcherDeliveryMode): WatcherNoteAttribution => ({
      linkId,
      wakeId,
      watcherConversationId: link.watcherConversationId,
      preset: link.preset,
      watcherLabel: label,
      delivery,
    });

    if (mode === "steer") {
      const latest = this.#deps.store.latestAgentTurnForConversation(watchedId);
      const running = this.#deps.turns.isActive(watchedId);
      if (running && !supportsActiveParentFollowUp(latest?.harnessId ?? null)) {
        throw new RuntimeRequestError("Steer now is not available for this agent. Send the note to queue it instead.");
      }
      if (!running) return await this.#queue(linkId, wakeId, watchedId, note, attribution("queue"), deliveryId, "steer-idle");
      const steered = await this.#steer(linkId, wakeId, watchedId, note, attribution("steer"), deliveryId);
      if (steered.kind === "done") return steered.result;
      return await this.#queue(linkId, wakeId, watchedId, note, attribution("queue"), deliveryId, steered.kind);
    }
    return await this.#queue(linkId, wakeId, watchedId, note, attribution("queue"), deliveryId, "queue");
  }

  async #steer(
    linkId: string,
    wakeId: string,
    watchedId: string,
    note: string,
    attribution: WatcherNoteAttribution,
    deliveryId: string,
  ): Promise<{ kind: "done"; result: WatcherDeliveryResult } | { kind: "turn-ended" | "refused" }> {
    const lease = this.#deps.turns.acquireFollowUpAdmission(watchedId);
    if (!lease) return { kind: "turn-ended" };
    let outcome: Awaited<ReturnType<TurnController["steer"]>>;
    try {
      outcome = await this.#deps.turns.steer(
        lease,
        { content: note, imagePaths: [] },
        [],
        undefined,
        undefined,
        { providerContent: watcherSteerContent(note, attribution), watcherNote: attribution },
      );
    } catch (error) {
      if (!(error instanceof RuntimeRequestError) || error.delivery !== "ambiguous") throw error;
      outcome = { kind: "unconfirmed", message: error.message };
    } finally {
      lease.release();
    }
    if (outcome.kind === "accepted") {
      return { kind: "done", result: this.#record(linkId, wakeId, {
        mode: "steer", state: "sent", detail: null,
        deliveryId, deliveredMessageId: outcome.message.id,
      }) };
    }
    if (outcome.kind === "unconfirmed") {
      return { kind: "done", result: this.#record(linkId, wakeId, {
        mode: "steer", state: "failed", detail: outcome.message, deliveryId,
      }) };
    }
    return { kind: outcome.kind === "turn-ended" ? "turn-ended" : "refused" };
  }

  async #queue(
    linkId: string,
    wakeId: string,
    watchedId: string,
    note: string,
    attribution: WatcherNoteAttribution,
    deliveryId: string,
    reason: QueueReason,
  ): Promise<WatcherDeliveryResult> {
    const detail = QUEUE_DETAILS[reason];
    const queuedAhead = this.#deps.store.queuedMessages.list(watchedId).length > 0;
    if (!this.#deps.turns.isActive(watchedId) && !queuedAhead) {
      const started = await this.#sendNow(linkId, wakeId, watchedId, note, attribution, deliveryId, detail);
      if (started) return started;
    }
    const queue = this.#deps.queue();
    if (!queue) throw new RuntimeRequestError("The main chat's queue is unavailable.");
    let result: MessageQueueResult;
    try {
      result = queue.enqueueWatcherNote({ conversationId: watchedId, id: deliveryId, content: note, watcherNote: attribution });
    } catch (error) {
      this.#record(linkId, wakeId, { mode: "queue", state: "failed", detail: publicRuntimeError(error), deliveryId });
      throw error;
    }
    const current = this.#deps.store.watcherLinks.getWake(wakeId);
    const recorded = current?.delivery?.state === "sent"
      ? this.#result(linkId, current)
      : this.#record(linkId, wakeId, {
          mode: "queue", state: "queued", detail, deliveryId, queuedMessageId: deliveryId,
        });
    return { ...recorded, queue: result };
  }

  /** Starts the watched chat's next turn with the note; null when it became busy meanwhile. */
  async #sendNow(
    linkId: string,
    wakeId: string,
    watchedId: string,
    note: string,
    attribution: WatcherNoteAttribution,
    deliveryId: string,
    detail: string | null,
  ): Promise<WatcherDeliveryResult | null> {
    const interaction = this.#deps.interaction();
    if (!interaction) throw new RuntimeRequestError("The main chat cannot start a turn right now.");
    let acceptedMessageId: string | null = null;
    const handler = createTurnInteractionCommandHandler({
      ...interaction,
      watcherDelivery: watcherNoteDelivery(attribution),
      send: (_socket: WebSocket, event: ServerEvent) => {
        if (event.type === "request.result" && event.result.kind === "message.accepted") {
          acceptedMessageId = event.result.userMessageId;
        }
      },
    });
    try {
      await handler(null as unknown as WebSocket, {
        type: "message.send",
        requestId: deliveryId,
        payload: { conversationId: watchedId, content: note, attachments: [], activate: false },
      });
    } catch (error) {
      if (this.#deps.turns.isActive(watchedId)) return null;
      this.#record(linkId, wakeId, { mode: "queue", state: "failed", detail: publicRuntimeError(error), deliveryId });
      throw error;
    }
    return this.#record(linkId, wakeId, {
      mode: "queue", state: "sent", detail, deliveryId, deliveredMessageId: acceptedMessageId,
    });
  }

  #record(
    linkId: string,
    wakeId: string,
    update: Parameters<RuntimeStore["watcherLinks"]["setDelivery"]>[1],
  ): WatcherDeliveryResult {
    const updated = this.#deps.store.watcherLinks.setDelivery(wakeId, update, this.#deps.now());
    if (updated) {
      this.#deps.changed(linkId);
      return this.#result(linkId, updated);
    }
    const current = this.#deps.store.watcherLinks.getWake(wakeId);
    if (current?.delivery && current.delivery.state === update.state) {
      return this.#result(linkId, current);
    }
    throw new RuntimeRequestError("This finding's delivery changed meanwhile. Reload the watcher feed.");
  }
}
