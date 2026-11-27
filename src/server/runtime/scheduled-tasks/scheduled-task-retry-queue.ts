const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 60_000;
export const MAX_SETTLEMENT_RETRY_ATTEMPTS = 8;

export function exponentialBackoffMs(attempt: number): number {
  const step = Math.max(0, Math.min(20, attempt - 1));
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * (2 ** step));
}

export interface PendingTurnBinding {
  runId: string;
  taskId: string;
  turnId: string;
  attempts: number;
}

export interface PendingTurnSettlement<TTurn extends { id: string; conversationId: string }> {
  turn: TTurn;
  taskId: string | null;
  conversationId: string;
  attempts: number;
}

export class ScheduledTaskRetryQueue<TTurn extends { id: string; conversationId: string }> {
  private readonly pendingBindings = new Map<string, PendingTurnBinding>();
  private readonly pendingSettlements = new Map<string, PendingTurnSettlement<TTurn>>();
  private readonly pendingBootBroadcastProjects = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private bootRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryBackoffAttempts = 0;
  private bootAttempts = 0;
  private disposed = false;

  get pendingBindingCount(): number {
    return this.pendingBindings.size;
  }

  get pendingSettlementCount(): number {
    return this.pendingSettlements.size;
  }

  recordBindingFailure(
    runId: string,
    taskId: string,
    turnId: string,
    error: unknown,
    onFlush: () => void,
  ): void {
    const previous = this.pendingBindings.get(runId);
    const attempts = (previous?.attempts ?? 0) + 1;
    this.pendingBindings.set(runId, { runId, taskId, turnId, attempts });
    this.retryBackoffAttempts += 1;
    console.warn(
      `[scheduled-tasks] Failed to bind run ${runId} to turn ${turnId} (attempt ${attempts}):`,
      error instanceof Error ? error.message : String(error),
    );
    this.scheduleRetry(onFlush);
  }

  clearBinding(runId: string): void {
    this.pendingBindings.delete(runId);
    this.resetRetryBackoffIfIdle();
  }

  recordSettlementFailure(
    turn: TTurn,
    taskId: string | null,
    error: unknown,
    onFallbackMarkFailed: (turn: TTurn) => void,
    onFlush: () => void,
  ): void {
    const previous = this.pendingSettlements.get(turn.id);
    const attempts = (previous?.attempts ?? 0) + 1;
    console.warn(
      `[scheduled-tasks] Failed to settle scheduled turn ${turn.id} (attempt ${attempts}):`,
      error instanceof Error ? error.message : String(error),
    );
    if (attempts >= MAX_SETTLEMENT_RETRY_ATTEMPTS) {
      this.pendingSettlements.delete(turn.id);
      this.resetRetryBackoffIfIdle();
      try {
        onFallbackMarkFailed(turn);
      } catch (fallbackError) {
        console.warn(
          `[scheduled-tasks] Fallback failure mark for turn ${turn.id} also failed:`,
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        );
      }
      return;
    }
    this.pendingSettlements.set(turn.id, {
      turn,
      taskId,
      conversationId: turn.conversationId,
      attempts,
    });
    this.retryBackoffAttempts += 1;
    this.scheduleRetry(onFlush);
  }

  clearSettlement(turnId: string): void {
    this.pendingSettlements.delete(turnId);
    this.resetRetryBackoffIfIdle();
  }

  purgeForTask(taskId: string): void {
    for (const [runId, entry] of Array.from(this.pendingBindings.entries())) {
      if (entry.taskId === taskId) this.pendingBindings.delete(runId);
    }
    for (const [turnId, entry] of Array.from(this.pendingSettlements.entries())) {
      if (entry.taskId === taskId) this.pendingSettlements.delete(turnId);
    }
    this.resetRetryBackoffIfIdle();
  }

  purgeForConversation(conversationId: string): void {
    for (const [turnId, entry] of Array.from(this.pendingSettlements.entries())) {
      if (entry.conversationId === conversationId) this.pendingSettlements.delete(turnId);
    }
    this.resetRetryBackoffIfIdle();
  }

  flush(
    onBind: (entry: PendingTurnBinding) => void,
    onSettle: (turn: TTurn) => void,
  ): void {
    if (this.disposed) return;
    for (const entry of Array.from(this.pendingBindings.values())) {
      try { onBind(entry); } catch { /* retry re-armed by recordBindingFailure */ }
    }
    for (const entry of Array.from(this.pendingSettlements.values())) {
      try { onSettle(entry.turn); } catch { /* retry re-armed by recordSettlementFailure */ }
    }
    this.resetRetryBackoffIfIdle();
  }

  addBootBroadcastProjects(projects: Iterable<string>): void {
    for (const projectId of projects) this.pendingBootBroadcastProjects.add(projectId);
  }

  drainBootBroadcastProjects(): string[] {
    const drained = Array.from(this.pendingBootBroadcastProjects);
    this.pendingBootBroadcastProjects.clear();
    return drained;
  }

  scheduleBootRetry(error: unknown, onRetry: () => void): void {
    if (this.disposed || this.bootRetryTimer !== null) return;
    this.bootAttempts += 1;
    const delayMs = exponentialBackoffMs(this.bootAttempts);
    console.warn(
      `[scheduled-tasks] Boot reconciliation failed (attempt ${this.bootAttempts}, retrying in ${delayMs}ms):`,
      error instanceof Error ? error.message : String(error),
    );
    this.bootRetryTimer = setTimeout(() => {
      this.bootRetryTimer = null;
      if (!this.disposed) onRetry();
    }, delayMs);
    this.bootRetryTimer.unref?.();
  }

  clearBootRetry(): void {
    if (this.bootRetryTimer !== null) {
      clearTimeout(this.bootRetryTimer);
      this.bootRetryTimer = null;
    }
    this.bootAttempts = 0;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearBootRetry();
    this.pendingBindings.clear();
    this.pendingSettlements.clear();
    this.pendingBootBroadcastProjects.clear();
  }

  private scheduleRetry(onFlush: () => void): void {
    if (this.disposed || this.retryTimer !== null) return;
    if (this.pendingBindings.size === 0 && this.pendingSettlements.size === 0) return;
    const delayMs = exponentialBackoffMs(this.retryBackoffAttempts);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.disposed) onFlush();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private resetRetryBackoffIfIdle(): void {
    if (this.pendingBindings.size === 0 && this.pendingSettlements.size === 0) {
      this.retryBackoffAttempts = 0;
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    }
  }
}
