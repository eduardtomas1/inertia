import type { Readable, Writable } from "node:stream";

import { MAX_APP_CDP_FRAME_BYTES, MAX_APP_PENDING_CDP_REQUESTS } from "../../../shared/app-under-test";
import type { AppUnderTestWindowFailureCode } from "./window-transport";

/**
 * A minimal Chrome DevTools Protocol client over Chromium's
 * `--remote-debugging-pipe`: NUL-delimited JSON frames, written to the app's
 * fd 3 and read from its fd 4. Sessions use `Target.attachToTarget` with
 * `flatten: true`, so every message carries an optional `sessionId`.
 *
 * Everything that arrives on fd 4 is untrusted: the app's own main process
 * can write there. Frames are bounded, malformed frames close the client, and
 * replies are matched only to ids this client issued.
 *
 * Chromium quits when fd 3 closes, so the client never ends it except in
 * `close()`, which the transport calls only when the launch is stopped,
 * exited, cleared or the runtime shuts down.
 */

export type CdpPipeErrorCode =
  | "closed"
  | "timeout"
  | "too-large"
  | "protocol"
  | "remote"
  | "cancelled"
  | "overloaded";

export class CdpPipeError extends Error {
  constructor(readonly code: CdpPipeErrorCode, message: string) {
    super(message);
    this.name = "CdpPipeError";
  }
}

/** The App Failure code a pipe error becomes at the transport boundary. */
export function cdpFailureCode(code: CdpPipeErrorCode): AppUnderTestWindowFailureCode {
  switch (code) {
    case "timeout":
      return "timeout";
    case "too-large":
      return "too-large";
    case "cancelled":
      return "cancelled";
    default:
      return "unavailable";
  }
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpSendOptions {
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CdpPipeClientOptions {
  maxFrameBytes?: number;
  maxPending?: number;
  defaultTimeoutMs?: number;
}

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: CdpPipeError): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_METHOD_CHARS = 128;
const MAX_SESSION_ID_CHARS = 128;
const MAX_REMOTE_ERROR_CHARS = 200;
const MAX_LISTENERS = 64;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export class CdpPipeClient {
  private readonly maxFrameBytes: number;
  private readonly maxPending: number;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<(error: CdpPipeError) => void>();
  /** Frames held back by fd 3 backpressure; each belongs to a pending request. */
  private readonly writeQueue: Array<{ id: number; frame: Buffer }> = [];
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private nextId = 1;
  private writable = true;
  private closedWith: CdpPipeError | null = null;

  constructor(
    private readonly input: Writable,
    private readonly output: Readable,
    options: CdpPipeClientOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_APP_CDP_FRAME_BYTES;
    this.maxPending = options.maxPending ?? MAX_APP_PENDING_CDP_REQUESTS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    output.on("data", this.onData);
    output.once("end", () => this.fail(new CdpPipeError("closed", "The app closed its debugging pipe.")));
    output.once("close", () => this.fail(new CdpPipeError("closed", "The app closed its debugging pipe.")));
    output.on("error", () => this.fail(new CdpPipeError("closed", "The app's debugging pipe failed.")));
    input.on("error", () => this.fail(new CdpPipeError("closed", "The app's debugging pipe failed.")));
    input.once("close", () => this.fail(new CdpPipeError("closed", "The app closed its debugging pipe.")));
    input.on("drain", this.onDrain);
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  get pendingRequests(): number {
    return this.pending.size;
  }

  /** Subscribes to protocol events; returns the unsubscribe function. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    if (this.listeners.size >= MAX_LISTENERS) throw new Error("Too many CDP event listeners.");
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Called once, with the reason, when the client closes for any reason. */
  onClose(listener: (error: CdpPipeError) => void): () => void {
    if (this.closedWith) {
      const error = this.closedWith;
      queueMicrotask(() => listener(error));
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  send(method: string, params: Record<string, unknown> = {}, options: CdpSendOptions = {}): Promise<Record<string, unknown>> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    if (options.signal?.aborted) return Promise.reject(new CdpPipeError("cancelled", "The App action was cancelled."));
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new CdpPipeError("overloaded", "Too many debugging requests are pending for this app."));
    }
    const id = this.nextId++;
    let frame: Buffer;
    try {
      frame = Buffer.from(`${JSON.stringify({
        id,
        method,
        params,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      })}\0`, "utf8");
    } catch {
      return Promise.reject(new CdpPipeError("protocol", "A debugging request could not be encoded."));
    }
    if (frame.byteLength > this.maxFrameBytes) {
      return Promise.reject(new CdpPipeError("too-large", "A debugging request was larger than Inertia sends."));
    }
    const request = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? this.defaultTimeoutMs, 120_000));
      const cleanup = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        // A request that timed out or was cancelled before fd 3 accepted it
        // is never sent later, so input reported as failed cannot arrive late.
        const queued = this.writeQueue.findIndex((entry) => entry.id === id);
        if (queued >= 0) this.writeQueue.splice(queued, 1);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new CdpPipeError("cancelled", "The App action was cancelled."));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new CdpPipeError("timeout", "The app did not answer a debugging request in time."));
      }, timeoutMs);
      timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      this.write(id, frame);
    });
    // close() and a failing pipe reject every pending request at once, also
    // those whose caller already gave up waiting (a race it lost, a deadline):
    // such a rejection must never surface as an unhandled one in the runtime.
    // Callers that await the request still receive the rejection.
    request.catch(() => undefined);
    return request;
  }

  /** Releases fd 3 (Chromium quits) and fails every pending request. Idempotent. */
  close(): void {
    this.fail(new CdpPipeError("closed", "The app's debugging connection was closed."));
    this.releaseInput();
  }

  private write(id: number, frame: Buffer): void {
    if (!this.writable) {
      this.writeQueue.push({ id, frame });
      return;
    }
    try {
      this.writable = this.input.write(frame);
    } catch {
      this.fail(new CdpPipeError("closed", "The app's debugging pipe failed."));
    }
  }

  private readonly onDrain = (): void => {
    this.writable = true;
    while (this.writable && this.writeQueue.length > 0 && !this.closedWith) {
      const next = this.writeQueue.shift()!;
      this.write(next.id, next.frame);
    }
  };

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closedWith) return;
    let data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (;;) {
      const end = data.indexOf(0);
      if (end === -1) {
        if (data.byteLength > 0) {
          this.partialBytes += data.byteLength;
          if (this.partialBytes > this.maxFrameBytes) {
            this.fail(new CdpPipeError("too-large", "The app sent a debugging message larger than Inertia accepts."));
            return;
          }
          this.partial.push(data);
        }
        return;
      }
      const piece = data.subarray(0, end);
      if (this.partialBytes + piece.byteLength > this.maxFrameBytes) {
        this.fail(new CdpPipeError("too-large", "The app sent a debugging message larger than Inertia accepts."));
        return;
      }
      const frame = this.partial.length === 0 ? piece : Buffer.concat([...this.partial, piece]);
      this.partial = [];
      this.partialBytes = 0;
      data = data.subarray(end + 1);
      this.dispatch(frame);
      if (this.closedWith) return;
    }
  };

  private dispatch(frame: Buffer): void {
    let message: Record<string, unknown> | null;
    try {
      message = record(JSON.parse(frame.toString("utf8")));
    } catch {
      message = null;
    }
    if (!message) {
      this.fail(new CdpPipeError("protocol", "The app sent a malformed debugging message."));
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      const error = record(message.error);
      if (error) {
        const detail = typeof error.message === "string" ? error.message.slice(0, MAX_REMOTE_ERROR_CHARS) : "error";
        pending.reject(new CdpPipeError("remote", detail));
      } else {
        pending.resolve(record(message.result) ?? {});
      }
      return;
    }
    const method = message.method;
    if (typeof method !== "string" || method.length === 0 || method.length > MAX_METHOD_CHARS) return;
    const sessionId = message.sessionId;
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length > MAX_SESSION_ID_CHARS)) return;
    const event: CdpEvent = {
      method,
      params: record(message.params) ?? {},
      ...(typeof sessionId === "string" ? { sessionId } : {}),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener failure must not stop delivery to the others.
      }
    }
  }

  private releaseInput(): void {
    try {
      this.input.destroy();
    } catch {
      // Already gone.
    }
  }

  private fail(error: CdpPipeError): void {
    if (this.closedWith) return;
    this.closedWith = error;
    this.output.off("data", this.onData);
    this.input.off("drain", this.onDrain);
    this.writeQueue.length = 0;
    this.partial = [];
    this.partialBytes = 0;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.listeners.clear();
    // Keep draining fd 4 so Chromium can never block on a full pipe. fd 3
    // stays open: a bad frame stops this client, never the app itself.
    this.output.resume();
    for (const listener of this.closeListeners) {
      try {
        listener(error);
      } catch {
        // Ignore listener failures during teardown.
      }
    }
    this.closeListeners.clear();
  }
}
