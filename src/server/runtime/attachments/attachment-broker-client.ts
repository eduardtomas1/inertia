import { randomUUID } from "node:crypto";

import type {
  RuntimeAttachmentRelinquishResult,
  RuntimeAttachmentReleaseResult,
  RuntimeAttachmentResult,
  RuntimeWorkerEvent,
} from "../../../main/runtime-process-protocol.js";
import type { TrustedRuntimeAttachment } from "../../../shared/runtime-attachments.js";
import type { RuntimeAttachmentBroker } from "./trusted-attachment-resolver.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const RESOLVE_TOMBSTONE_TTL_MS = 125_000;
const MAX_RESOLVE_TOMBSTONES = 512;

interface PendingRequest {
  timer: NodeJS.Timeout;
  attachmentId: string;
  posted: boolean;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (value: TrustedRuntimeAttachment | null) => void;
  reject: (error: Error) => void;
}

interface ResolveTombstone {
  attachmentId: string;
  timer: NodeJS.Timeout;
}

interface PendingReleaseRequest {
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (released: boolean) => void;
  reject: (error: Error) => void;
}

interface PendingRelinquishRequest {
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (relinquished: boolean) => void;
  reject: (error: Error) => void;
}

function unavailable(): Error {
  return new Error("The selected attachment is no longer available or could not be verified.");
}

export class RuntimeAttachmentBrokerClient implements RuntimeAttachmentBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingReleases = new Map<string, PendingReleaseRequest>();
  private readonly pendingRelinquishes =
    new Map<string, PendingRelinquishRequest>();
  private readonly resolveTombstones = new Map<string, ResolveTombstone>();
  private readonly timeoutMs: number;
  private closed = false;

  constructor(
    private readonly post: (event: RuntimeWorkerEvent) => void,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.timeoutMs = Math.max(1, Math.min(Math.trunc(timeoutMs), 30_000));
  }

  resolve(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<TrustedRuntimeAttachment | null> {
    if (
      this.closed
      || signal?.aborted
      || this.pending.size + this.resolveTombstones.size
        >= MAX_RESOLVE_TOMBSTONES
    ) return Promise.reject(unavailable());
    let requestId = randomUUID();
    while (
      this.pending.has(requestId)
      || this.pendingReleases.has(requestId)
      || this.pendingRelinquishes.has(requestId)
      || this.resolveTombstones.has(requestId)
    ) {
      requestId = randomUUID();
    }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        timer: setTimeout(() => {
          if (this.pending.get(requestId) !== pending) return;
          this.pending.delete(requestId);
          this.cleanupPending(pending);
          if (pending.posted) {
            this.rememberResolveTombstone(
              requestId,
              pending.attachmentId,
            );
          }
          reject(unavailable());
        }, this.timeoutMs),
        attachmentId,
        posted: false,
        signal,
        onAbort: null,
        resolve,
        reject,
      };
      pending.timer.unref();
      if (signal) {
        pending.onAbort = () => {
          if (this.pending.get(requestId) !== pending) return;
          this.pending.delete(requestId);
          this.cleanupPending(pending);
          if (pending.posted) {
            this.rememberResolveTombstone(
              requestId,
              pending.attachmentId,
            );
          }
          reject(unavailable());
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(requestId, pending);
      try {
        this.post({
          type: "runtime.attachment-request",
          requestId,
          attachmentId,
        });
        pending.posted = true;
      } catch {
        this.pending.delete(requestId);
        this.cleanupPending(pending);
        reject(unavailable());
      }
    });
  }

  handle(result: RuntimeAttachmentResult): boolean {
    const pending = this.pending.get(result.requestId);
    if (!pending) {
      const tombstone = this.resolveTombstones.get(result.requestId);
      if (!tombstone) return false;
      this.deleteResolveTombstone(result.requestId, tombstone);
      if (result.ok && !this.closed) {
        void this.relinquish(tombstone.attachmentId).catch(() => undefined);
      }
      return true;
    }
    this.pending.delete(result.requestId);
    this.cleanupPending(pending);
    if (!result.ok) {
      if (result.code === "not-found") pending.resolve(null);
      else pending.reject(unavailable());
      return true;
    }
    pending.resolve(result.attachment);
    return true;
  }

  release(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.requestRelease(
      "runtime.attachment-release-request",
      attachmentId,
      signal,
    );
  }

  cleanup(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.requestRelease(
      "runtime.attachment-cleanup-request",
      attachmentId,
      signal,
    );
  }

  private requestRelease(
    type:
      | "runtime.attachment-release-request"
      | "runtime.attachment-cleanup-request",
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.closed || signal?.aborted) return Promise.reject(unavailable());
    let requestId = randomUUID();
    while (
      this.pending.has(requestId)
      || this.pendingReleases.has(requestId)
      || this.pendingRelinquishes.has(requestId)
      || this.resolveTombstones.has(requestId)
    ) {
      requestId = randomUUID();
    }
    return new Promise((resolve, reject) => {
      const pending: PendingReleaseRequest = {
        timer: setTimeout(() => {
          if (this.pendingReleases.get(requestId) !== pending) return;
          this.pendingReleases.delete(requestId);
          this.cleanupPending(pending);
          reject(unavailable());
        }, this.timeoutMs),
        signal,
        onAbort: null,
        resolve,
        reject,
      };
      pending.timer.unref();
      if (signal) {
        pending.onAbort = () => {
          if (this.pendingReleases.get(requestId) !== pending) return;
          this.pendingReleases.delete(requestId);
          this.cleanupPending(pending);
          reject(unavailable());
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pendingReleases.set(requestId, pending);
      try {
        this.post({
          type,
          requestId,
          attachmentId,
        });
      } catch {
        this.pendingReleases.delete(requestId);
        this.cleanupPending(pending);
        reject(unavailable());
      }
    });
  }

  handleRelease(result: RuntimeAttachmentReleaseResult): boolean {
    const pending = this.pendingReleases.get(result.requestId);
    if (!pending) return false;
    this.pendingReleases.delete(result.requestId);
    this.cleanupPending(pending);
    if (!result.ok) pending.reject(unavailable());
    else pending.resolve(result.released);
    return true;
  }

  relinquish(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.closed || signal?.aborted) return Promise.reject(unavailable());
    let requestId = randomUUID();
    while (
      this.pending.has(requestId)
      || this.pendingReleases.has(requestId)
      || this.pendingRelinquishes.has(requestId)
      || this.resolveTombstones.has(requestId)
    ) {
      requestId = randomUUID();
    }
    return new Promise((resolve, reject) => {
      const pending: PendingRelinquishRequest = {
        timer: setTimeout(() => {
          if (this.pendingRelinquishes.get(requestId) !== pending) return;
          this.pendingRelinquishes.delete(requestId);
          this.cleanupPending(pending);
          reject(unavailable());
        }, this.timeoutMs),
        signal,
        onAbort: null,
        resolve,
        reject,
      };
      pending.timer.unref();
      if (signal) {
        pending.onAbort = () => {
          if (this.pendingRelinquishes.get(requestId) !== pending) return;
          this.pendingRelinquishes.delete(requestId);
          this.cleanupPending(pending);
          reject(unavailable());
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pendingRelinquishes.set(requestId, pending);
      try {
        this.post({
          type: "runtime.attachment-relinquish-request",
          requestId,
          attachmentId,
        });
      } catch {
        this.pendingRelinquishes.delete(requestId);
        this.cleanupPending(pending);
        reject(unavailable());
      }
    });
  }

  handleRelinquish(result: RuntimeAttachmentRelinquishResult): boolean {
    const pending = this.pendingRelinquishes.get(result.requestId);
    if (!pending) return false;
    this.pendingRelinquishes.delete(result.requestId);
    this.cleanupPending(pending);
    if (!result.ok) pending.reject(unavailable());
    else pending.resolve(result.relinquished);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.cleanupPending(pending);
      pending.reject(unavailable());
    }
    for (const [requestId, pending] of this.pendingReleases) {
      this.pendingReleases.delete(requestId);
      this.cleanupPending(pending);
      pending.reject(unavailable());
    }
    for (const [requestId, pending] of this.pendingRelinquishes) {
      this.pendingRelinquishes.delete(requestId);
      this.cleanupPending(pending);
      pending.reject(unavailable());
    }
    for (const [requestId, tombstone] of this.resolveTombstones) {
      this.deleteResolveTombstone(requestId, tombstone);
    }
  }

  pendingCount(): number {
    return this.pending.size
      + this.pendingReleases.size
      + this.pendingRelinquishes.size
      + this.resolveTombstones.size;
  }

  private rememberResolveTombstone(
    requestId: string,
    attachmentId: string,
  ): void {
    const timer = setTimeout(() => {
      const tombstone = this.resolveTombstones.get(requestId);
      if (!tombstone) return;
      this.deleteResolveTombstone(requestId, tombstone);
    }, RESOLVE_TOMBSTONE_TTL_MS);
    timer.unref();
    this.resolveTombstones.set(requestId, { attachmentId, timer });
  }

  private deleteResolveTombstone(
    requestId: string,
    tombstone: ResolveTombstone,
  ): void {
    if (this.resolveTombstones.get(requestId) !== tombstone) return;
    this.resolveTombstones.delete(requestId);
    clearTimeout(tombstone.timer);
  }

  private cleanupPending(
    pending:
      | PendingRequest
      | PendingReleaseRequest
      | PendingRelinquishRequest,
  ): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }
}
