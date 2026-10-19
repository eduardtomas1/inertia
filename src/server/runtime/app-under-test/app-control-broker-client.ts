import { randomUUID } from "node:crypto";

import {
  APP_CONTROL_MAX_PENDING_REQUESTS,
  APP_CONTROL_RUNTIME_BACKSTOP_MS,
  APP_CONTROL_RESULT_KIND,
  appControlFailure,
  type AppControlCommand,
  type AppControlIdentity,
  type AppControlResult,
  type RuntimeAppControlEvent,
  type RuntimeAppControlResult,
} from "../../../node/runtime-app-control-protocol.js";

/** The runtime's view of main's App control service: one correlated request per call. */
export interface RuntimeAppControlBroker {
  perform(
    identity: AppControlIdentity,
    command: AppControlCommand,
    signal?: AbortSignal,
  ): Promise<AppControlResult>;
}

interface PendingRequest {
  identity: AppControlIdentity;
  command: AppControlCommand["command"];
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (result: AppControlResult) => void;
}

/**
 * Sends App control commands over the runtime's message channel to main.
 * Every request gets a fresh UUID; at most 16 are pending, each bounded by a
 * 90-second backstop. A cancelled or timed-out request is cancelled in main
 * too, and a result that arrives after its request settled is dropped.
 */
export class RuntimeAppControlBrokerClient implements RuntimeAppControlBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private closed = false;

  constructor(
    private readonly post: (event: RuntimeAppControlEvent) => void,
    timeoutMs = APP_CONTROL_RUNTIME_BACKSTOP_MS,
  ) {
    this.timeoutMs = Math.max(1, Math.min(Math.trunc(timeoutMs), APP_CONTROL_RUNTIME_BACKSTOP_MS));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  perform(
    identity: AppControlIdentity,
    command: AppControlCommand,
    signal?: AbortSignal,
  ): Promise<AppControlResult> {
    if (this.closed) return Promise.resolve(appControlFailure("unavailable"));
    if (signal?.aborted) return Promise.resolve(appControlFailure("cancelled"));
    if (this.pending.size >= APP_CONTROL_MAX_PENDING_REQUESTS) return Promise.resolve(appControlFailure("busy"));
    const requestId = randomUUID();
    const mayDispatch = command.command === "perform";
    return new Promise<AppControlResult>((resolve) => {
      const settle = (result: AppControlResult): void => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        this.cleanup(pending);
        resolve(result);
      };
      const cancel = (): void => {
        this.post({ type: "runtime.app-control-cancel", requestId, identity });
      };
      const timer = setTimeout(() => {
        cancel();
        // The action's outcome is unknown once main may have started it.
        settle(appControlFailure("timeout", null, mayDispatch));
      }, this.timeoutMs);
      timer.unref();
      const onAbort = signal
        ? () => {
            cancel();
            settle(appControlFailure("cancelled", null, mayDispatch));
          }
        : null;
      this.pending.set(requestId, { identity, command: command.command, timer, signal, onAbort, resolve });
      if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });
      try {
        this.post({ type: "runtime.app-control-request", requestId, identity, command });
      } catch {
        settle(appControlFailure("unavailable"));
      }
    });
  }

  /** Delivers one result; false when its request is unknown or already settled. */
  handle(result: RuntimeAppControlResult): boolean {
    const pending = this.pending.get(result.requestId);
    if (!pending) return false;
    this.pending.delete(result.requestId);
    this.cleanup(pending);
    // A success of the wrong kind is a protocol fault, never data for another command.
    const value = result.result;
    pending.resolve(value.ok && value.value.kind !== APP_CONTROL_RESULT_KIND[pending.command]
      ? appControlFailure("native-failure")
      : value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.cleanup(pending);
      try {
        this.post({ type: "runtime.app-control-cancel", requestId, identity: pending.identity });
      } catch {
        // The channel is closing with the runtime.
      }
      pending.resolve(appControlFailure("unavailable"));
    }
  }

  private cleanup(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
  }
}
