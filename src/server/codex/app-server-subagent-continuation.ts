/**
 * Holds a parent terminal candidate while exact delegated work is live.
 * Clearing the live set starts a bounded grace for a fresh parent turn; it
 * never promotes the stale candidate into a successful completion.
 */
export class CodexSubagentContinuationGate {
  private pending = false;
  private live = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly graceMs: number,
    private readonly onExpired: () => void,
  ) {}

  hasCandidate(): boolean {
    return this.pending;
  }

  begin(): boolean {
    if (this.pending) return false;
    this.pending = true;
    this.live = true;
    return true;
  }

  observeLive(live: boolean): void {
    this.live = live;
    if (!this.pending) return;
    if (live) {
      this.clearTimer();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.pending || this.live) return;
      this.pending = false;
      this.onExpired();
    }, this.graceMs);
    this.timer.unref();
  }

  discard(): boolean {
    const discarded = this.pending;
    this.pending = false;
    this.live = false;
    this.clearTimer();
    return discarded;
  }

  dispose(): void {
    this.discard();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
