import type {
  RuntimeAttachmentRelinquishResult,
  RuntimeAttachmentReleaseResult,
  RuntimeAttachmentResult,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import type { TrustedRuntimeAttachment } from "../shared/runtime-attachments.js";

type Timer = ReturnType<typeof setTimeout>;
type AttachmentEvent = Extract<
  RuntimeWorkerEvent,
  {
    type:
      | "runtime.attachment-request"
      | "runtime.attachment-release-request"
      | "runtime.attachment-cleanup-request"
      | "runtime.attachment-relinquish-request";
  }
>;

export interface RuntimeAttachmentBroker {
  resolve(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<TrustedRuntimeAttachment | null>;
  release(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface RuntimeAttachmentPeer {
  readonly attachmentRequestIds: Set<string>;
  readonly attachmentClaimCounts: Map<string, number>;
  readonly deferredAttachmentReleaseIds: Set<string>;
  readonly deletingAttachmentIds: Set<string>;
  readonly attachmentOperationTails: Map<string, Promise<void>>;
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
  post(
    peer: Peer,
    result:
      | RuntimeAttachmentResult
      | RuntimeAttachmentReleaseResult
      | RuntimeAttachmentRelinquishResult,
  ): void;
}

/**
 * Owns capability request correlation independently from runtime lifecycle.
 * Same-capability work is serialized and counted so one turn cannot release
 * another turn's claim.
 */
export class RuntimeAttachmentBrokerCoordinator<
  Peer extends RuntimeAttachmentPeer,
> {
  private readonly pending = new Map<string, PendingAttachmentRequest<Peer>>();

  constructor(
    private readonly options: RuntimeAttachmentBrokerCoordinatorOptions<Peer>,
  ) {}

  handle(peer: Peer, event: AttachmentEvent): void {
    if (
      !this.options.accepts(peer)
      || (
        event.type !== "runtime.attachment-relinquish-request"
        && !this.options.broker
      )
    ) {
      this.postUnavailable(
        peer,
        event,
        "Secure attachment storage is unavailable.",
      );
      return;
    }
    if (peer.attachmentRequestIds.has(event.requestId)) {
      this.postInvalid(peer, event);
      return;
    }
    peer.attachmentRequestIds.add(event.requestId);
    if (peer.attachmentRequestIds.size > 512) {
      const oldest = peer.attachmentRequestIds.values().next().value;
      if (typeof oldest === "string") peer.attachmentRequestIds.delete(oldest);
    }

    if (event.type === "runtime.attachment-relinquish-request") {
      this.enqueue(peer, event.attachmentId, () => {
        const relinquished = this.decrementClaim(peer, event.attachmentId);
        if (this.options.accepts(peer)) {
          this.options.post(peer, {
            type: "runtime.attachment-relinquish-result",
            requestId: event.requestId,
            ok: true,
            relinquished,
          });
        }
        this.flushDeferredRelease(peer, event.attachmentId);
      });
      return;
    }

    if (event.type === "runtime.attachment-request") {
      if (
        peer.deletingAttachmentIds.has(event.attachmentId)
        || peer.deferredAttachmentReleaseIds.has(event.attachmentId)
      ) {
        this.options.post(peer, {
          type: "runtime.attachment-result",
          requestId: event.requestId,
          ok: false,
          code: "not-found",
          message: "The attachment capability is unavailable.",
        });
        return;
      }
      this.incrementClaim(peer, event.attachmentId);
    }

    const pending = this.createPending(peer, event);
    this.enqueue(peer, event.attachmentId, async () => {
      if (this.pending.get(event.requestId) !== pending) return;
      if (event.type === "runtime.attachment-request") {
        await this.resolve(peer, event, pending);
      } else if (event.type === "runtime.attachment-cleanup-request") {
        await this.cleanup(peer, event, pending);
      } else {
        await this.release(peer, event, pending);
      }
    });
  }

  deferRendererRelease(peer: Peer, attachmentId: string): boolean {
    if (
      this.claimCount(peer, attachmentId) === 0
      && !peer.deletingAttachmentIds.has(attachmentId)
      && !peer.deferredAttachmentReleaseIds.has(attachmentId)
    ) return false;
    peer.deferredAttachmentReleaseIds.add(attachmentId);
    this.flushDeferredRelease(peer, attachmentId);
    return true;
  }

  clear(peer: Peer): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.peer !== peer) continue;
      this.pending.delete(requestId);
      this.options.clearTimer(pending.timer);
      pending.controller.abort();
    }
    const releaseIds = new Set([
      ...peer.attachmentClaimCounts.keys(),
      ...peer.deferredAttachmentReleaseIds,
      ...peer.deletingAttachmentIds,
    ]);
    peer.attachmentClaimCounts.clear();
    peer.deferredAttachmentReleaseIds.clear();
    peer.deletingAttachmentIds.clear();
    peer.attachmentOperationTails.clear();
    for (const attachmentId of releaseIds) {
      void Promise.resolve()
        .then(() => this.options.broker?.release(attachmentId))
        .catch(() => undefined);
    }
  }

  private createPending(
    peer: Peer,
    event: Exclude<
      AttachmentEvent,
      { type: "runtime.attachment-relinquish-request" }
    >,
  ): PendingAttachmentRequest<Peer> {
    const controller = new AbortController();
    const pending: PendingAttachmentRequest<Peer> = {
      peer,
      controller,
      timer: this.options.setTimer(() => {
        if (this.pending.get(event.requestId) !== pending) return;
        this.pending.delete(event.requestId);
        pending.controller.abort();
        if (event.type === "runtime.attachment-request") {
          this.decrementClaim(peer, event.attachmentId);
          this.flushDeferredRelease(peer, event.attachmentId);
        }
        if (!this.options.accepts(peer)) return;
        this.postUnavailable(
          peer,
          event,
          "Secure attachment storage did not respond in time.",
        );
      }, this.options.timeoutMs),
    };
    this.pending.set(event.requestId, pending);
    return pending;
  }

  private async resolve(
    peer: Peer,
    event: Extract<AttachmentEvent, { type: "runtime.attachment-request" }>,
    pending: PendingAttachmentRequest<Peer>,
  ): Promise<void> {
    try {
      const attachment = await this.options.broker!.resolve(
        event.attachmentId,
        pending.controller.signal,
      );
      if (this.pending.get(event.requestId) !== pending) return;
      this.finishPending(event.requestId, pending);
      if (!attachment) {
        this.decrementClaim(peer, event.attachmentId);
        this.flushDeferredRelease(peer, event.attachmentId);
      }
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
    } catch {
      if (this.pending.get(event.requestId) !== pending) return;
      this.finishPending(event.requestId, pending);
      this.decrementClaim(peer, event.attachmentId);
      this.flushDeferredRelease(peer, event.attachmentId);
      if (this.options.accepts(peer)) {
        this.postUnavailable(
          peer,
          event,
          "Secure attachment storage is unavailable.",
        );
      }
    }
  }

  private async release(
    peer: Peer,
    event: Extract<
      AttachmentEvent,
      { type: "runtime.attachment-release-request" }
    >,
    pending: PendingAttachmentRequest<Peer>,
  ): Promise<void> {
    const claims = this.claimCount(peer, event.attachmentId);
    if (claims === 0) {
      this.finishPending(event.requestId, pending);
      if (this.options.accepts(peer)) {
        this.postReleaseResult(peer, event.requestId, false);
      }
      return;
    }
    if (claims > 1) {
      this.decrementClaim(peer, event.attachmentId);
      this.finishPending(event.requestId, pending);
      if (this.options.accepts(peer)) {
        this.postReleaseResult(peer, event.requestId, false);
      }
      return;
    }

    peer.deletingAttachmentIds.add(event.attachmentId);
    try {
      const released = await this.options.broker!.release(
        event.attachmentId,
        pending.controller.signal,
      );
      peer.deletingAttachmentIds.delete(event.attachmentId);
      this.decrementClaim(peer, event.attachmentId);
      peer.deferredAttachmentReleaseIds.delete(event.attachmentId);
      if (this.pending.get(event.requestId) !== pending) return;
      this.finishPending(event.requestId, pending);
      if (this.options.accepts(peer)) {
        this.postReleaseResult(peer, event.requestId, released);
      }
    } catch {
      peer.deletingAttachmentIds.delete(event.attachmentId);
      if (this.pending.get(event.requestId) !== pending) return;
      this.finishPending(event.requestId, pending);
      if (this.options.accepts(peer)) {
        this.postUnavailable(
          peer,
          event,
          "Secure attachment storage is unavailable.",
        );
      }
    }
  }

  private async cleanup(
    peer: Peer,
    event: Extract<
      AttachmentEvent,
      { type: "runtime.attachment-cleanup-request" }
    >,
    pending: PendingAttachmentRequest<Peer>,
  ): Promise<void> {
    if (
      this.claimCount(peer, event.attachmentId) > 0
      || peer.deletingAttachmentIds.has(event.attachmentId)
    ) {
      this.finishPending(event.requestId, pending);
      if (this.options.accepts(peer)) {
        this.postReleaseResult(peer, event.requestId, false);
      }
      return;
    }
    peer.deletingAttachmentIds.add(event.attachmentId);
    try {
      const released = await this.options.broker!.release(
        event.attachmentId,
        pending.controller.signal,
      );
      peer.deletingAttachmentIds.delete(event.attachmentId);
      peer.deferredAttachmentReleaseIds.delete(event.attachmentId);
      if (this.pending.get(event.requestId) !== pending) return;
      this.finishPending(event.requestId, pending);
      if (this.options.accepts(peer)) {
        this.postReleaseResult(peer, event.requestId, released);
      }
    } catch {
      peer.deletingAttachmentIds.delete(event.attachmentId);
      peer.deferredAttachmentReleaseIds.add(event.attachmentId);
      if (this.pending.get(event.requestId) !== pending) return;
      this.finishPending(event.requestId, pending);
      if (this.options.accepts(peer)) {
        this.postUnavailable(
          peer,
          event,
          "Secure attachment storage is unavailable.",
        );
      }
    }
  }

  private flushDeferredRelease(peer: Peer, attachmentId: string): void {
    if (
      !peer.deferredAttachmentReleaseIds.has(attachmentId)
      || this.claimCount(peer, attachmentId) > 0
      || peer.deletingAttachmentIds.has(attachmentId)
    ) return;
    this.enqueue(peer, attachmentId, async () => {
      if (
        !peer.deferredAttachmentReleaseIds.has(attachmentId)
        || this.claimCount(peer, attachmentId) > 0
        || peer.deletingAttachmentIds.has(attachmentId)
      ) return;
      peer.deletingAttachmentIds.add(attachmentId);
      try {
        await this.options.broker?.release(attachmentId);
        peer.deferredAttachmentReleaseIds.delete(attachmentId);
      } catch {
        // Keep the deferred renderer request for generation cleanup.
      } finally {
        peer.deletingAttachmentIds.delete(attachmentId);
      }
    });
  }

  private enqueue(
    peer: Peer,
    attachmentId: string,
    operation: () => void | Promise<void>,
  ): void {
    const prior = peer.attachmentOperationTails.get(attachmentId);
    const queued = (prior ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    peer.attachmentOperationTails.set(attachmentId, queued);
    void queued.finally(() => {
      if (peer.attachmentOperationTails.get(attachmentId) === queued) {
        peer.attachmentOperationTails.delete(attachmentId);
      }
    }).catch(() => undefined);
  }

  private finishPending(
    requestId: string,
    pending: PendingAttachmentRequest<Peer>,
  ): void {
    this.pending.delete(requestId);
    this.options.clearTimer(pending.timer);
  }

  private claimCount(peer: Peer, attachmentId: string): number {
    return peer.attachmentClaimCounts.get(attachmentId) ?? 0;
  }

  private incrementClaim(peer: Peer, attachmentId: string): void {
    peer.attachmentClaimCounts.set(
      attachmentId,
      this.claimCount(peer, attachmentId) + 1,
    );
  }

  private decrementClaim(peer: Peer, attachmentId: string): boolean {
    const count = this.claimCount(peer, attachmentId);
    if (count === 0) return false;
    if (count === 1) peer.attachmentClaimCounts.delete(attachmentId);
    else peer.attachmentClaimCounts.set(attachmentId, count - 1);
    return true;
  }

  private postReleaseResult(
    peer: Peer,
    requestId: string,
    released: boolean,
  ): void {
    this.options.post(peer, {
      type: "runtime.attachment-release-result",
      requestId,
      ok: true,
      released,
    });
  }

  private postUnavailable(
    peer: Peer,
    event: AttachmentEvent,
    message: string,
  ): void {
    if (event.type === "runtime.attachment-request") {
      this.options.post(peer, {
        type: "runtime.attachment-result",
        requestId: event.requestId,
        ok: false,
        code: "unavailable",
        message,
      });
      return;
    }
    if (event.type === "runtime.attachment-relinquish-request") {
      this.options.post(peer, {
        type: "runtime.attachment-relinquish-result",
        requestId: event.requestId,
        ok: false,
        code: "unavailable",
        message,
      });
      return;
    }
    this.options.post(peer, {
      type: "runtime.attachment-release-result",
      requestId: event.requestId,
      ok: false,
      code: "unavailable",
      message,
    });
  }

  private postInvalid(peer: Peer, event: AttachmentEvent): void {
    const message = "The attachment request identifier was already used.";
    if (event.type === "runtime.attachment-request") {
      this.options.post(peer, {
        type: "runtime.attachment-result",
        requestId: event.requestId,
        ok: false,
        code: "invalid",
        message,
      });
      return;
    }
    if (event.type === "runtime.attachment-relinquish-request") {
      this.options.post(peer, {
        type: "runtime.attachment-relinquish-result",
        requestId: event.requestId,
        ok: false,
        code: "invalid",
        message,
      });
      return;
    }
    this.options.post(peer, {
      type: "runtime.attachment-release-result",
      requestId: event.requestId,
      ok: false,
      code: "invalid",
      message,
    });
  }
}
