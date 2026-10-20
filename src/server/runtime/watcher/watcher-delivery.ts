import type WebSocket from "ws";

import type { ServerEvent } from "../../../shared/contracts";
import { supportsActiveParentFollowUp } from "../../../shared/follow-up-steer";
import type { MessageQueueResult } from "../../../shared/queued-messages";
import {
  MAX_WATCHER_LABEL_CHARS,
  MAX_WATCHER_NOTE_CHARS,
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

export const WATCHER_DELIVERY_DETAIL = Object.freeze({
  sent: "Sent · started the main chat's next turn",
  queued: "Queued · sends after the current turn",
  steered: "Steered into the running turn",
  turnEnded: "The main chat's turn ended before the note arrived, so it was queued.",
  turnEndedSent: "The main chat's turn ended before the note arrived, so it started the next turn.",
  refused: "The agent did not take the note mid-turn, so it was queued.",
  refusedSent: "The agent did not take the note mid-turn, so it started the next turn.",
  idle: "The main chat was not running, so the note started its next turn.",
  idleQueued: "The main chat was not running, so the note was queued.",
});

type QueueReason = "queue" | "steer-idle" | "turn-ended" | "refused";

const QUEUE_DETAILS: Readonly<Record<QueueReason, { now: string; later: string }>> = Object.freeze({
  queue: { now: WATCHER_DELIVERY_DETAIL.sent, later: WATCHER_DELIVERY_DETAIL.queued },
  "steer-idle": { now: WATCHER_DELIVERY_DETAIL.idle, later: WATCHER_DELIVERY_DETAIL.idleQueued },
  "turn-ended": { now: WATCHER_DELIVERY_DETAIL.turnEndedSent, later: WATCHER_DELIVERY_DETAIL.turnEnded },
  refused: { now: WATCHER_DELIVERY_DETAIL.refusedSent, later: WATCHER_DELIVERY_DETAIL.refused },
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
}

export interface WatcherDeliveryDependencies {
  store: RuntimeStore;
  turns: Pick<TurnController, "isActive" | "acquireFollowUpAdmission" | "steer">;
  /** The same server-side dependencies the message commands use. */
  interaction(): TurnInteractionCommandDependencies | undefined;
  queue(): WatcherNoteQueue | undefined;
  now(): string;
  /** The link's feed changed; republish it. */
  changed(linkId: string): void;
}

const PROVIDER_LABEL_SEPARATOR = " · ";

function clipCodeUnits(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const last = value.charCodeAt(maximum - 1);
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? maximum - 1 : maximum);
}

function singleLine(value: string): string {
  let flattened = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    flattened += code < 0x20 || code === 0x7f ? " " : character;
  }
  return flattened.replace(/\s+/gu, " ").trim();
}

/** The watcher's provider identity label plus model, on one line of at most 80 characters. */
export function watcherLabel(store: Pick<RuntimeStore, "conversation" | "shellSnapshot">, watcherConversationId: string): string {
  const conversation = store.conversation(watcherConversationId);
  const labels = store.shellSnapshot().settings.providerIdentityLabels ?? {};
  const provider = labels[conversation.providerId] ?? PROVIDER_INFO[conversation.providerId]?.name ?? "Watcher";
  const selection = conversation.modelSelection;
  const model = selection.alias
    ?? (selection.modelId === "provider-default" ? "Default model" : selection.modelId);
  const label = singleLine(`${provider}${PROVIDER_LABEL_SEPARATOR}${model}`);
  return clipCodeUnits(label, MAX_WATCHER_LABEL_CHARS).trim() || "Watcher";
}

/** The neutralized note text the user forwards, capped at `MAX_WATCHER_NOTE_CHARS`. */
export function watcherNoteText(finding: string): string {
  const normalized = finding.replaceAll("\0", "�").replace(/\r\n?/gu, "\n").trim();
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
    const { wake } = this.#finding(linkId, wakeId);
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

  /** A forwarded note reached the watched chat as a user message; marks a queued delivery sent. */
  noteDelivered(attribution: WatcherNoteAttribution, messageId: string): void {
    const wake = this.#deps.store.watcherLinks.getWake(attribution.wakeId);
    if (!wake || wake.linkId !== attribution.linkId || wake.delivery?.state !== "queued") return;
    const updated = this.#deps.store.watcherLinks.setDelivery(wake.wakeId, {
      mode: wake.delivery.mode ?? attribution.delivery,
      state: "sent",
      detail: wake.delivery.detail,
      deliveredMessageId: messageId,
    }, this.#deps.now());
    if (updated) this.#deps.changed(attribution.linkId);
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
    const { link, wake } = this.#finding(linkId, wakeId);
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
    const attribution = (delivery: WatcherDeliveryMode): WatcherNoteAttribution => ({
      linkId,
      wakeId,
      watcherConversationId: link.watcherConversationId,
      preset: link.preset,
      watcherLabel: watcherLabel(this.#deps.store, link.watcherConversationId),
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
    } finally {
      lease.release();
    }
    if (outcome.kind === "accepted") {
      return { kind: "done", result: this.#record(linkId, wakeId, {
        mode: "steer", state: "sent", detail: WATCHER_DELIVERY_DETAIL.steered,
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
    const details = QUEUE_DETAILS[reason];
    const queuedAhead = this.#deps.store.queuedMessages.list(watchedId).length > 0;
    if (!this.#deps.turns.isActive(watchedId) && !queuedAhead) {
      const started = await this.#sendNow(linkId, wakeId, watchedId, note, attribution, deliveryId, details.now);
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
          mode: "queue", state: "queued", detail: details.later, deliveryId, queuedMessageId: deliveryId,
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
    detail: string,
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
