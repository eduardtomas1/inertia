import type { Writable } from "node:stream";

import type { JsonObject } from "./protocol";

interface PendingWrite {
  frame: Buffer;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Serializes App Server JSONL writes and retains at most one bounded queue.
 * A write completes only after Node has accepted the frame, invoked its write
 * callback, and (when backpressured) emitted `drain`.
 */
export class CodexJsonLineWriter {
  private readonly queue: PendingWrite[] = [];
  private active: PendingWrite | null = null;
  private activeAbort: ((error: Error) => void) | null = null;
  private queuedBytes = 0;
  private closedError: Error | null = null;

  constructor(
    private readonly stream: Writable,
    private readonly maxFrameBytes: number,
    private readonly maxQueuedBytes: number,
  ) {}

  write(message: JsonObject): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    let frame: Buffer;
    try {
      frame = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    } catch (cause) {
      return Promise.reject(new Error(
        "The Codex App Server request could not be serialized.",
        { cause },
      ));
    }
    if (frame.length > this.maxFrameBytes) {
      return Promise.reject(new Error(
        `The Codex App Server request exceeded the ${this.maxFrameBytes}-byte frame limit.`,
      ));
    }
    if (this.queuedBytes + frame.length > this.maxQueuedBytes) {
      return Promise.reject(new Error(
        `The Codex App Server write queue exceeded the ${this.maxQueuedBytes}-byte limit.`,
      ));
    }
    this.queuedBytes += frame.length;
    const completion = new Promise<void>((resolve, reject) => {
      this.queue.push({ frame, resolve, reject });
    });
    this.pump();
    return completion;
  }

  close(cause?: unknown): void {
    if (this.closedError) return;
    const error = cause instanceof Error
      ? cause
      : new Error("The Codex App Server input stream closed.");
    this.closedError = error;
    if (this.activeAbort) {
      this.activeAbort(error);
      return;
    }
    this.rejectAll(error);
  }

  private pump(): void {
    if (this.active || this.closedError) return;
    const pending = this.queue.shift();
    if (!pending) return;
    this.active = pending;
    let callbackDone = false;
    let drainDone = false;
    let finished = false;

    const cleanup = (): void => {
      this.stream.off("error", onError);
      this.stream.off("close", onClose);
      this.stream.off("drain", onDrain);
      this.activeAbort = null;
    };
    const complete = (): void => {
      if (finished || !callbackDone || !drainDone) return;
      finished = true;
      cleanup();
      this.active = null;
      this.queuedBytes -= pending.frame.length;
      pending.resolve();
      this.pump();
    };
    const fail = (cause: unknown): void => {
      if (finished) return;
      finished = true;
      cleanup();
      this.failAll(cause instanceof Error
        ? cause
        : new Error("The Codex App Server input stream closed."));
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void => fail(
      new Error("The Codex App Server input stream closed."),
    );
    const onDrain = (): void => {
      drainDone = true;
      complete();
    };
    this.activeAbort = fail;

    this.stream.once("error", onError);
    this.stream.once("close", onClose);
    try {
      const accepted = this.stream.write(pending.frame, (error) => {
        if (error) {
          fail(error);
          return;
        }
        callbackDone = true;
        // A custom Writable can invoke its callback synchronously.
        queueMicrotask(complete);
      });
      drainDone = accepted;
      if (!accepted) this.stream.once("drain", onDrain);
      complete();
    } catch (error) {
      fail(error);
    }
  }

  private failAll(error: Error): void {
    if (!this.closedError) this.closedError = error;
    this.rejectAll(this.closedError);
  }

  private rejectAll(failure: Error): void {
    this.activeAbort = null;
    const active = this.active;
    this.active = null;
    if (active) active.reject(failure);
    for (const pending of this.queue.splice(0)) pending.reject(failure);
    this.queuedBytes = 0;
  }
}
