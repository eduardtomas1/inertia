export interface DeltaTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StreamDeltaFlush {
  /** The ordered text not yet delivered to the consumer. */
  delta: string;
  /**
   * True when the producer supplied a corrected terminal value rather than
   * an append-only suffix. Persistence should replace its value; delta-only
   * transports must wait for their authoritative terminal snapshot.
   */
  replacement: boolean;
}

export interface TurnStreamCoalescerOptions {
  scheduler: DeltaTimerScheduler;
  onFlush: (flush: StreamDeltaFlush) => void;
  onTimerError: (error: unknown) => void;
  firstFlushMs?: number;
  flushIntervalMs?: number;
  maxBufferedChars?: number;
}

export const DEFAULT_FIRST_STREAM_FLUSH_MS = 12;
export const DEFAULT_STREAM_FLUSH_INTERVAL_MS = 96;
export const DEFAULT_STREAM_FLUSH_CHAR_THRESHOLD = 1_024;

/**
 * Small synchronous buffer used at the authoritative turn boundary.
 *
 * Provider callbacks only append text. The first renderable chunk is flushed
 * on a short timer, later chunks on a slightly wider cadence, and a bounded
 * character threshold acts as the memory/latency safety valve. Explicit
 * lifecycle edges call flush() before changing externally visible state.
 */
export class TurnStreamCoalescer {
  private pending = "";
  private replacement = false;
  private timer: unknown = null;
  private flushedOnce = false;
  private disposed = false;
  private readonly firstFlushMs: number;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedChars: number;

  constructor(private readonly options: TurnStreamCoalescerOptions) {
    this.firstFlushMs = positiveInteger(
      options.firstFlushMs,
      DEFAULT_FIRST_STREAM_FLUSH_MS,
    );
    this.flushIntervalMs = positiveInteger(
      options.flushIntervalMs,
      DEFAULT_STREAM_FLUSH_INTERVAL_MS,
    );
    this.maxBufferedChars = positiveInteger(
      options.maxBufferedChars,
      DEFAULT_STREAM_FLUSH_CHAR_THRESHOLD,
    );
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  get hasScheduledFlush(): boolean {
    return this.timer !== null;
  }

  append(delta: string): void {
    if (this.disposed || delta.length === 0) return;
    this.pending += delta;
    if (this.pending.length >= this.maxBufferedChars) {
      this.flush();
      return;
    }
    if (!this.flushedOnce && !hasMeaningfulText(this.pending)) return;
    this.schedule(this.flushedOnce ? this.flushIntervalMs : this.firstFlushMs);
  }

  /**
   * Replace any unflushed suffix with an authoritative final value. This is
   * only needed when a provider's terminal result disagrees with its deltas.
   */
  replacePending(value: string): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.pending = value;
    this.replacement = value.length > 0;
  }

  flush(): boolean {
    if (this.disposed || this.pending.length === 0) {
      this.cancelTimer();
      return false;
    }
    this.cancelTimer();
    const flush = {
      delta: this.pending,
      replacement: this.replacement,
    } satisfies StreamDeltaFlush;
    this.options.onFlush(flush);
    this.pending = "";
    this.replacement = false;
    this.flushedOnce = true;
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.pending = "";
    this.replacement = false;
    this.disposed = true;
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = this.options.scheduler.setTimeout(() => {
      this.timer = null;
      if (this.disposed) return;
      try {
        this.flush();
      } catch (error) {
        try {
          this.options.onTimerError(error);
        } catch {
          // A timer must never leak an exception into the runtime event loop.
        }
      }
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.options.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }
}

function hasMeaningfulText(value: string): boolean {
  return /\S/u.test(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}
