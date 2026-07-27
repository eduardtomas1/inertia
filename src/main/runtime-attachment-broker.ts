import type {
  RuntimeAttachmentResult,
  RuntimeWorkerEvent,
} from "./runtime-process-protocol.js";
import type { TrustedRuntimeAttachment } from "../shared/runtime-attachments.js";

type Timer = ReturnType<typeof setTimeout>;

export interface RuntimeAttachmentBroker {
  resolve(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<TrustedRuntimeAttachment | null>;
}

export interface RuntimeAttachmentPeer {
  readonly attachmentRequestIds: Set<string>;
}

interface PendingAttachmentRequest<Peer> {
  peer: Peer;
  timer: Timer;
  controller: AbortController;
}

export interface RuntimeAttachmentBrokerCoordinatorOptions<
  Peer extends RuntimeAttachmentPeer,
> {
  broker?: RuntimeAttachmentBroker;
  timeoutMs: number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  accepts(peer: Peer): boolean;
  post(peer: Peer, result: RuntimeAttachmentResult): void;
}

/**
 * Owns capability request correlation independently from runtime lifecycle.
 * The supervisor supplies only generation acceptance and process delivery.
 */
export class RuntimeAttachmentBrokerCoordinator<
  Peer extends RuntimeAttachmentPeer,
> {
  private readonly pending = new Map<string, PendingAttachmentRequest<Peer>>();

  constructor(
    private readonly options: RuntimeAttachmentBrokerCoordinatorOptions<Peer>,
  ) {}

  handle(
    peer: Peer,
    event: Extract<
      RuntimeWorkerEvent,
      { type: "runtime.attachment-request" }
    >,
  ): void {
    if (!this.options.accepts(peer) || !this.options.broker) {
      this.postUnavailable(peer, event.requestId, "Secure attachment storage is unavailable.");
      return;
    }
    if (peer.attachmentRequestIds.has(event.requestId)) {
      this.options.post(peer, {
        type: "runtime.attachment-result",
        requestId: event.requestId,
        ok: false,
        code: "invalid",
        message: "The attachment request identifier was already used.",
      });
      return;
    }
    peer.attachmentRequestIds.add(event.requestId);
    if (peer.attachmentRequestIds.size > 512) {
      const oldest = peer.attachmentRequestIds.values().next().value;
      if (typeof oldest === "string") peer.attachmentRequestIds.delete(oldest);
    }

    const controller = new AbortController();
    const pending: PendingAttachmentRequest<Peer> = {
      peer,
      controller,
      timer: this.options.setTimer(() => {
        if (this.pending.get(event.requestId) !== pending) return;
        this.pending.delete(event.requestId);
        pending.controller.abort();
        if (!this.options.accepts(peer)) return;
        this.postUnavailable(
          peer,
          event.requestId,
          "Secure attachment storage did not respond in time.",
        );
      }, this.options.timeoutMs),
    };
    this.pending.set(event.requestId, pending);
    void Promise.resolve()
      .then(() => this.options.broker!.resolve(
        event.attachmentId,
        controller.signal,
      ))
      .then(
        (attachment) => {
          if (this.pending.get(event.requestId) !== pending) return;
          this.pending.delete(event.requestId);
          this.options.clearTimer(pending.timer);
          if (!this.options.accepts(peer)) return;
          this.options.post(peer, attachment
            ? {
                type: "runtime.attachment-result",
                requestId: event.requestId,
                ok: true,
                attachment,
              }
            : {
                type: "runtime.attachment-result",
                requestId: event.requestId,
                ok: false,
                code: "not-found",
                message: "The attachment capability is unavailable.",
              });
        },
        () => {
          if (this.pending.get(event.requestId) !== pending) return;
          this.pending.delete(event.requestId);
          this.options.clearTimer(pending.timer);
          if (!this.options.accepts(peer)) return;
          this.postUnavailable(
            peer,
            event.requestId,
            "Secure attachment storage is unavailable.",
          );
        },
      );
  }

  clear(peer: Peer): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.peer !== peer) continue;
      this.pending.delete(requestId);
      this.options.clearTimer(pending.timer);
      pending.controller.abort();
    }
  }

  private postUnavailable(
    peer: Peer,
    requestId: string,
    message: string,
  ): void {
    this.options.post(peer, {
      type: "runtime.attachment-result",
      requestId,
      ok: false,
      code: "unavailable",
      message,
    });
  }
}
