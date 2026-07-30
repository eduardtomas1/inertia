const DEFAULT_SNAPSHOT_BROADCAST_DELAY_MS = 32;

export interface SnapshotBroadcastScheduler {
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const defaultScheduler: SnapshotBroadcastScheduler = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

/**
 * Coalesces shell-wide snapshot invalidations without delaying conversation
 * detail deltas or terminal events. The snapshot is built only when the
 * trailing timer fires, so a mutation burst performs one SQLite projection.
 */
export class SnapshotBroadcastCoalescer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly broadcast: () => void,
    private readonly scheduler = defaultScheduler,
    private readonly delayMs = DEFAULT_SNAPSHOT_BROADCAST_DELAY_MS,
  ) {}

  request(): void {
    if (this.closed || this.timer !== null) return;
    this.timer = this.scheduler.setTimer(() => {
      this.timer = null;
      if (!this.closed) this.broadcast();
    }, this.delayMs);
  }

  flush(): void {
    if (this.closed) return;
    if (this.timer !== null) {
      this.scheduler.clearTimer(this.timer);
      this.timer = null;
    }
    this.broadcast();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) {
      this.scheduler.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
