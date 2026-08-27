import type { RuntimeSystemSuspendInterval } from "../node/runtime-process-protocol.js";
import { RuntimeSystemSuspendTracker } from "./runtime-system-suspend-tracker.js";

const DEFAULT_INITIAL_RETRY_MS = 250;
const DEFAULT_MAX_RETRY_MS = 30_000;

type Timer = ReturnType<typeof setTimeout>;

interface SuspendDeliveryRuntime {
  snapshot(): { phase: string; generation: number };
  recordSystemSuspendInterval(interval: RuntimeSystemSuspendInterval): boolean;
}

export interface RuntimeSystemSuspendDeliveryOptions {
  tracker: RuntimeSystemSuspendTracker;
  runtime: () => SuspendDeliveryRuntime | null;
  initialRetryMs?: number;
  maxRetryMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

/**
 * Delivers only the durable journal head and retries transient runtime or
 * acknowledgement failures without allowing a later interval to overtake it.
 */
export class RuntimeSystemSuspendDelivery {
  private readonly tracker: RuntimeSystemSuspendTracker;
  private readonly runtime: () => SuspendDeliveryRuntime | null;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private retryTimer: Timer | null = null;
  private retryGeneration: number | null = null;
  private retryAttempt = 0;
  private closed = false;

  constructor(options: RuntimeSystemSuspendDeliveryOptions) {
    this.tracker = options.tracker;
    this.runtime = options.runtime;
    this.initialRetryMs = Math.max(
      1,
      Math.floor(options.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS),
    );
    this.maxRetryMs = Math.max(
      this.initialRetryMs,
      Math.floor(options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS),
    );
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  runtimeState(phase: string, generation: number): void {
    if (this.closed) return;
    if (phase !== "ready") {
      this.cancelTimer();
      return;
    }
    if (
      this.retryGeneration !== null
      && this.retryGeneration !== generation
    ) {
      this.resetBackoff();
    }
    if (
      this.retryTimer
      && this.retryGeneration === generation
    ) return;
    this.deliver(generation);
  }

  sendIfReady(): void {
    if (this.closed) return;
    const snapshot = this.runtime()?.snapshot();
    if (!snapshot || snapshot.phase !== "ready") {
      this.cancelTimer();
      return;
    }
    this.runtimeState(snapshot.phase, snapshot.generation);
  }

  result(id: string, generation: number, recorded: boolean): void {
    if (this.closed) return;
    if (!recorded) {
      if (this.tracker.release(id, generation)) this.schedule(generation);
      return;
    }
    const acknowledgement = this.tracker.acknowledgeResult(id, generation);
    if (acknowledgement === "ignored") return;
    if (acknowledgement === "retry") {
      this.schedule(generation);
      return;
    }
    this.resetBackoff();
    this.deliver(generation);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelTimer();
  }

  private deliver(generation: number): void {
    const runtime = this.runtime();
    const snapshot = runtime?.snapshot();
    if (
      !runtime
      || snapshot?.phase !== "ready"
      || snapshot.generation !== generation
    ) {
      this.cancelTimer();
      return;
    }
    const interval = this.tracker.claim(generation);
    if (!interval) return;
    this.cancelTimer();
    if (!runtime.recordSystemSuspendInterval(interval)) {
      if (this.tracker.release(interval.id, generation)) {
        this.schedule(generation);
      }
    }
  }

  private schedule(generation: number): void {
    const snapshot = this.runtime()?.snapshot();
    if (
      this.closed
      || snapshot?.phase !== "ready"
      || snapshot.generation !== generation
    ) return;
    if (this.retryTimer) return;
    if (
      this.retryGeneration !== null
      && this.retryGeneration !== generation
    ) {
      this.resetBackoff();
    }
    this.retryGeneration = generation;
    const delayMs = Math.min(
      this.initialRetryMs * 2 ** Math.min(this.retryAttempt, 30),
      this.maxRetryMs,
    );
    this.retryAttempt = Math.min(this.retryAttempt + 1, 30);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.closed) return;
      const current = this.runtime()?.snapshot();
      if (
        current?.phase !== "ready"
        || current.generation !== generation
      ) return;
      this.deliver(generation);
    }, delayMs);
  }

  private cancelTimer(): void {
    if (!this.retryTimer) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  private resetBackoff(): void {
    this.cancelTimer();
    this.retryGeneration = null;
    this.retryAttempt = 0;
  }
}
