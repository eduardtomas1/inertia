export const DOCUMENT_EXTRACTION_CONCURRENCY = 2;
export const DOCUMENT_EXTRACTION_WORKING_BYTES = 12 * 1024 * 1024;

export class DocumentExtractionCancelledError extends Error {
  constructor() {
    super("Document extraction was cancelled.");
    this.name = "DocumentExtractionCancelledError";
  }
}

export class DocumentExtractionDeadlineError extends Error {
  constructor() {
    super("Document extraction exceeded the shared turn deadline.");
    this.name = "DocumentExtractionDeadlineError";
  }
}

export class DocumentExtractionBudgetError extends Error {
  constructor() {
    super("Document extraction exceeds the shared working-memory budget.");
    this.name = "DocumentExtractionBudgetError";
  }
}

export class DocumentExtractionInitializationError extends Error {
  constructor() {
    super("PDF support initialization exceeded its bounded cold-start deadline.");
    this.name = "DocumentExtractionInitializationError";
  }
}

interface ScheduledExtraction {
  readonly groupId: string;
  readonly weight: number;
  readonly operation: (signal: AbortSignal) => Promise<unknown>;
  readonly onOperationFailure: ((error: unknown) => void) | undefined;
  readonly controller: AbortController;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly deadlineAt: number;
  readonly signal: AbortSignal | undefined;
  queuedAbort: (() => void) | undefined;
  queuedTimer: NodeJS.Timeout | undefined;
  state: "queued" | "running" | "settled";
}

export interface DocumentExtractionSchedulerOptions {
  readonly concurrency?: number;
  readonly maximumWorkingBytes?: number;
  readonly now?: () => number;
}

/**
 * A process-wide FIFO-by-turn scheduler. Moving the selected turn to the back
 * after every dispatch prevents one eight-PDF message from monopolizing both
 * extraction slots while another turn is waiting.
 */
export class DocumentExtractionScheduler {
  private readonly concurrency: number;
  private readonly maximumWorkingBytes: number;
  private readonly now: () => number;
  private readonly groups = new Map<string, ScheduledExtraction[]>();
  private readonly groupOrder: string[] = [];
  private activeCount = 0;
  private activeBytes = 0;
  private lastDispatchedGroupId: string | null = null;

  constructor(options: DocumentExtractionSchedulerOptions = {}) {
    this.concurrency = Math.max(
      1,
      Math.min(8, Math.trunc(
        options.concurrency ?? DOCUMENT_EXTRACTION_CONCURRENCY,
      )),
    );
    this.maximumWorkingBytes = Math.max(
      1,
      Math.trunc(
        options.maximumWorkingBytes ?? DOCUMENT_EXTRACTION_WORKING_BYTES,
      ),
    );
    this.now = options.now ?? Date.now;
  }

  schedule<T>(input: {
    readonly groupId: string;
    readonly weight: number;
    readonly deadlineAt: number;
    readonly signal?: AbortSignal;
    readonly operation: (signal: AbortSignal) => Promise<T>;
    readonly onOperationFailure?: (error: unknown) => void;
  }): Promise<T> {
    if (input.signal?.aborted) {
      return Promise.reject(new DocumentExtractionCancelledError());
    }
    if (input.deadlineAt <= this.now()) {
      return Promise.reject(new DocumentExtractionDeadlineError());
    }
    if (input.weight > this.maximumWorkingBytes) {
      return Promise.reject(new DocumentExtractionBudgetError());
    }
    return new Promise<T>((resolve, reject) => {
      const job: ScheduledExtraction = {
        groupId: input.groupId,
        weight: Math.max(1, Math.trunc(input.weight)),
        operation: input.operation,
        onOperationFailure: input.onOperationFailure,
        controller: new AbortController(),
        resolve: (value) => resolve(value as T),
        reject,
        deadlineAt: input.deadlineAt,
        signal: input.signal,
        queuedAbort: undefined,
        queuedTimer: undefined,
        state: "queued",
      };
      job.queuedAbort = () => {
        if (job.state !== "queued") return;
        this.settleQueued(job, new DocumentExtractionCancelledError());
        this.pump();
      };
      job.signal?.addEventListener("abort", job.queuedAbort, { once: true });
      job.queuedTimer = setTimeout(() => {
        if (job.state !== "queued") return;
        this.settleQueued(job, new DocumentExtractionDeadlineError());
        this.pump();
      }, Math.max(1, Math.trunc(job.deadlineAt - this.now())));
      job.queuedTimer.unref();
      const group = this.groups.get(input.groupId);
      if (group) group.push(job);
      else {
        this.groups.set(input.groupId, [job]);
        this.groupOrder.push(input.groupId);
      }
      this.pump();
    });
  }

  queuedJobCount(): number {
    let count = 0;
    for (const group of this.groups.values()) count += group.length;
    return count;
  }

  private pump(): void {
    while (this.activeCount < this.concurrency) {
      const job = this.nextRunnable();
      if (!job) return;
      this.run(job);
    }
  }

  private nextRunnable(): ScheduledExtraction | null {
    if (
      this.groupOrder.length > 1
      && this.groupOrder[0] === this.lastDispatchedGroupId
    ) {
      this.groupOrder.push(this.groupOrder.shift()!);
    }
    for (let groupIndex = 0; groupIndex < this.groupOrder.length; groupIndex += 1) {
      const groupId = this.groupOrder[groupIndex]!;
      const group = this.groups.get(groupId);
      if (!group) continue;
      while (group[0]?.state === "settled") group.shift();
      const job = group[0];
      if (!job) {
        this.groups.delete(groupId);
        this.groupOrder.splice(groupIndex, 1);
        groupIndex -= 1;
        continue;
      }
      if (job.signal?.aborted) {
        group.shift();
        this.settleQueued(job, new DocumentExtractionCancelledError());
        groupIndex -= 1;
        continue;
      }
      if (job.deadlineAt <= this.now()) {
        group.shift();
        this.settleQueued(job, new DocumentExtractionDeadlineError());
        groupIndex -= 1;
        continue;
      }
      const fits = this.activeBytes + job.weight <= this.maximumWorkingBytes;
      if (!fits) continue;
      group.shift();
      this.groupOrder.splice(groupIndex, 1);
      if (group.length > 0) this.groupOrder.push(groupId);
      else this.groups.delete(groupId);
      this.lastDispatchedGroupId = groupId;
      if (job.queuedTimer) clearTimeout(job.queuedTimer);
      job.queuedTimer = undefined;
      if (job.queuedAbort) {
        job.signal?.removeEventListener("abort", job.queuedAbort);
        job.queuedAbort = undefined;
      }
      return job;
    }
    return null;
  }

  private run(job: ScheduledExtraction): void {
    job.state = "running";
    this.activeCount += 1;
    this.activeBytes += job.weight;
    const remainingMs = Math.max(1, Math.trunc(job.deadlineAt - this.now()));
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        job.controller.abort();
        reject(new DocumentExtractionDeadlineError());
      }, remainingMs);
      timeout.unref();
    });
    let rejectCancellation: ((error: Error) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      job.controller.abort();
      rejectCancellation?.(new DocumentExtractionCancelledError());
    };
    job.signal?.addEventListener("abort", cancel, { once: true });

    let operation: Promise<unknown>;
    try {
      operation = Promise.resolve(job.operation(job.controller.signal));
    } catch (error) {
      operation = Promise.reject(error);
    }
    if (job.onOperationFailure) {
      void operation.catch((error: unknown) => {
        job.onOperationFailure?.(error);
      });
    }
    const result = Promise.race([
      operation,
      deadline,
      cancellation,
    ]);
    void result.then(job.resolve, job.reject).finally(() => {
      if (timeout) clearTimeout(timeout);
    }).catch(() => undefined);
    // Keep the concurrency and working-byte reservation until the extractor
    // has genuinely stopped. A timed-out implementation that ignores abort
    // must not let later work exceed the advertised process-wide bounds.
    void operation.finally(() => {
      job.signal?.removeEventListener("abort", cancel);
      job.state = "settled";
      this.activeCount -= 1;
      this.activeBytes -= job.weight;
      this.pump();
    }).catch(() => undefined);
  }

  private settleQueued(job: ScheduledExtraction, error: Error): void {
    const group = this.groups.get(job.groupId);
    const index = group?.indexOf(job) ?? -1;
    if (group && index >= 0) group.splice(index, 1);
    if (group?.length === 0) {
      this.groups.delete(job.groupId);
      const groupIndex = this.groupOrder.indexOf(job.groupId);
      if (groupIndex >= 0) this.groupOrder.splice(groupIndex, 1);
    }
    if (job.queuedTimer) clearTimeout(job.queuedTimer);
    job.queuedTimer = undefined;
    if (job.queuedAbort) {
      job.signal?.removeEventListener("abort", job.queuedAbort);
      job.queuedAbort = undefined;
    }
    job.state = "settled";
    job.reject(error);
  }
}
