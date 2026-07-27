import { randomUUID } from "node:crypto";

import type {
  RuntimeAttachmentResult,
  RuntimeWorkerEvent,
} from "../../../main/runtime-process-protocol.js";
import type { TrustedRuntimeAttachment } from "../../../shared/runtime-attachments.js";
import type { RuntimeAttachmentBroker } from "./trusted-attachment-resolver.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (value: TrustedRuntimeAttachment | null) => void;
  reject: (error: Error) => void;
}

function unavailable(): Error {
  return new Error("The selected attachment is no longer available or could not be verified.");
}

export class RuntimeAttachmentBrokerClient implements RuntimeAttachmentBroker {
  private readonly pending = new Map<string, PendingRequest>();
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
    if (this.closed || signal?.aborted) return Promise.reject(unavailable());
    let requestId = randomUUID();
    while (this.pending.has(requestId)) requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        timer: setTimeout(() => {
          if (this.pending.get(requestId) !== pending) return;
          this.pending.delete(requestId);
          this.cleanup(pending);
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
          if (this.pending.get(requestId) !== pending) return;
          this.pending.delete(requestId);
          this.cleanup(pending);
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
      } catch {
        this.pending.delete(requestId);
        this.cleanup(pending);
        reject(unavailable());
      }
    });
  }

  handle(result: RuntimeAttachmentResult): boolean {
    const pending = this.pending.get(result.requestId);
    if (!pending) return false;
    this.pending.delete(result.requestId);
    this.cleanup(pending);
    if (!result.ok) {
      if (result.code === "not-found") pending.resolve(null);
      else pending.reject(unavailable());
      return true;
    }
    pending.resolve(result.attachment);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.cleanup(pending);
      pending.reject(unavailable());
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private cleanup(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }
}
