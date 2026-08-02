export class DatabaseRecoveryOperationCancelledError extends Error {
  constructor() {
    super("The database recovery operation was cancelled.");
    this.name = "DatabaseRecoveryOperationCancelledError";
  }
}

interface QueuedRecoveryOperation {
  readonly id: string;
  readonly controller: AbortController;
  readonly operation: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export class BoundedDatabaseRecoveryReceipts<
  T extends { operation: "export" | "import" },
> {
  private readonly receipts = new Map<string, T>();

  constructor(private readonly maximum: number) {}

  record(key: string, receipt: T): void {
    this.receipts.delete(key);
    this.receipts.set(key, receipt);
    while (this.receipts.size > this.maximum) {
      this.receipts.delete(this.receipts.keys().next().value!);
    }
  }

  find(key: string, operation: T["operation"]): T | null {
    const receipt = this.receipts.get(key);
    return receipt?.operation === operation ? receipt : null;
  }

  has(key: string): boolean {
    return this.receipts.has(key);
  }
}

/** One authoritative FIFO for recovery mutations and external file writes. */
export class DatabaseRecoveryOperationQueue {
  private readonly jobs = new Map<string, QueuedRecoveryOperation>();
  private readonly queued: QueuedRecoveryOperation[] = [];
  private readonly drainWaiters = new Set<() => void>();
  private active: QueuedRecoveryOperation | null = null;
  private accepting = true;

  enqueue<T>(
    id: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new DatabaseRecoveryOperationCancelledError());
    }
    if (this.jobs.has(id)) {
      return Promise.reject(new Error(
        "The database recovery operation identifier is already active.",
      ));
    }
    return new Promise<T>((resolve, reject) => {
      const job: QueuedRecoveryOperation = {
        id,
        controller: new AbortController(),
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      this.jobs.set(id, job);
      this.queued.push(job);
      this.pump();
    });
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    const cancellation = new DatabaseRecoveryOperationCancelledError();
    if (this.active === job) {
      job.controller.abort(cancellation);
      return true;
    }
    const index = this.queued.indexOf(job);
    if (index >= 0) this.queued.splice(index, 1);
    this.jobs.delete(id);
    job.controller.abort(cancellation);
    job.reject(cancellation);
    this.notifyDrained();
    return true;
  }

  async closeAndDrain(): Promise<void> {
    if (this.accepting) {
      this.accepting = false;
      if (this.active) this.cancel(this.active.id);
      while (this.queued.length > 0) this.cancel(this.queued[0]!.id);
    }
    if (this.jobs.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  private pump(): void {
    if (this.active) return;
    const job = this.queued.shift();
    if (!job) {
      this.notifyDrained();
      return;
    }
    this.active = job;
    void Promise.resolve().then(() => job.operation(job.controller.signal)).then(
      (value) => this.finish(job, undefined, value),
      (error: unknown) => this.finish(
        job,
        job.controller.signal.aborted
          ? job.controller.signal.reason
          : error,
      ),
    );
  }

  private finish(
    job: QueuedRecoveryOperation,
    error: unknown,
    value?: unknown,
  ): void {
    if (this.active !== job) return;
    this.active = null;
    this.jobs.delete(job.id);
    if (error === undefined) job.resolve(value);
    else job.reject(error);
    this.pump();
  }

  private notifyDrained(): void {
    if (this.jobs.size !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
