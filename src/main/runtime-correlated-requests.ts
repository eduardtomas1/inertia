import type { RuntimeProcessRecord } from "./runtime-supervisor-types.js";

interface PendingCorrelatedRequest<Identity> {
  readonly record: RuntimeProcessRecord;
  readonly identity: Identity;
  readonly controller: AbortController;
}

export interface RuntimeCorrelatedRequestsOptions<Identity, Result> {
  /** The per-process-record set of request ids already used (the replay set). */
  requestIds(record: RuntimeProcessRecord): Set<string>;
  sameIdentity(left: Identity, right: Identity): boolean;
  accepts(record: RuntimeProcessRecord): boolean;
  reply(record: RuntimeProcessRecord, requestId: string, result: Result): void;
  /** Answer to a request id the record already used. */
  repeated: Result;
  /** Answer when the operation rejected. */
  failed: Result;
  /** Request ids remembered per record; the oldest is forgotten beyond it. */
  replayLimit?: number;
}

/**
 * Correlated request bookkeeping shared by the runtime brokers whose work main
 * performs: one pending entry per request id, a bounded replay set of used ids
 * per runtime process record, cancellation only by the exact owner and
 * identity, and no reply to a runtime that was replaced or cleared.
 */
export class RuntimeCorrelatedRequests<Identity, Result> {
  private readonly pending = new Map<string, PendingCorrelatedRequest<Identity>>();
  private readonly replayLimit: number;

  constructor(private readonly options: RuntimeCorrelatedRequestsOptions<Identity, Result>) {
    this.replayLimit = Math.max(1, options.replayLimit ?? 512);
  }

  get size(): number {
    return this.pending.size;
  }

  /**
   * Starts one request. A reused request id aborts the pending work it named
   * and is answered with `repeated`; the work never runs twice.
   */
  begin(
    record: RuntimeProcessRecord,
    requestId: string,
    identity: Identity,
    run: (signal: AbortSignal) => Promise<Result>,
  ): void {
    const ids = this.options.requestIds(record);
    if (ids.has(requestId)) {
      const repeated = this.pending.get(requestId);
      if (repeated?.record === record) {
        this.pending.delete(requestId);
        repeated.controller.abort();
      }
      this.options.reply(record, requestId, this.options.repeated);
      return;
    }
    ids.add(requestId);
    if (ids.size > this.replayLimit) {
      const oldest = ids.values().next().value;
      if (typeof oldest === "string") ids.delete(oldest);
    }
    const controller = new AbortController();
    const pending: PendingCorrelatedRequest<Identity> = { record, identity, controller };
    this.pending.set(requestId, pending);
    const finish = (result: Result): void => {
      if (this.pending.get(requestId) !== pending) return;
      this.pending.delete(requestId);
      if (this.options.accepts(record)) this.options.reply(record, requestId, result);
    };
    let operation: Promise<Result>;
    try {
      operation = run(controller.signal);
    } catch {
      operation = Promise.resolve(this.options.failed);
    }
    void operation.then(finish, () => finish(this.options.failed));
  }

  /** Aborts pending work only when the record and every identity field match. */
  cancel(record: RuntimeProcessRecord, requestId: string, identity: Identity): void {
    const pending = this.pending.get(requestId);
    if (pending?.record !== record || !this.options.sameIdentity(pending.identity, identity)) return;
    this.pending.delete(requestId);
    pending.controller.abort();
  }

  /** Aborts everything the record started; its late results are dropped. */
  clear(record: RuntimeProcessRecord | null): void {
    if (!record) return;
    for (const [requestId, pending] of this.pending) {
      if (pending.record !== record) continue;
      this.pending.delete(requestId);
      pending.controller.abort();
    }
  }
}
