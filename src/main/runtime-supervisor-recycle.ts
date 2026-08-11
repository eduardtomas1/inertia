import type { RuntimeProcessRecord } from "./runtime-supervisor-types.js";

interface PendingRuntimeRecycle {
  readonly source: RuntimeProcessRecord;
  readonly expectedGeneration: number;
  readonly promise: Promise<boolean>;
  resolve(confirmed: boolean): void;
  reject(error: Error): void;
  replacement: RuntimeProcessRecord | null;
}

export class RuntimeSupervisorRecycle {
  private pending: PendingRuntimeRecycle | null = null;
  private readonly rejectedCleanup = new WeakSet<RuntimeProcessRecord>();

  activePromise(): Promise<boolean> | null {
    return this.pending?.promise ?? null;
  }

  begin(source: RuntimeProcessRecord): {
    readonly promise: Promise<boolean>;
    readonly started: boolean;
  } {
    if (this.pending) {
      return { promise: this.pending.promise, started: false };
    }
    let resolveRecycle!: (confirmed: boolean) => void;
    let rejectRecycle!: (error: Error) => void;
    const promise = new Promise<boolean>((resolve, reject) => {
      resolveRecycle = resolve;
      rejectRecycle = reject;
    });
    this.pending = {
      source,
      expectedGeneration: source.generation + 1,
      promise,
      resolve: resolveRecycle,
      reject: rejectRecycle,
      replacement: null,
    };
    return { promise, started: true };
  }

  owns(record: RuntimeProcessRecord): boolean {
    return this.pending?.source === record
      || this.pending?.replacement === record;
  }

  sourceIs(record: RuntimeProcessRecord): boolean {
    return this.pending?.source === record;
  }

  replacementIs(record: RuntimeProcessRecord): boolean {
    return this.pending?.replacement === record;
  }

  bindReplacement(record: RuntimeProcessRecord): boolean {
    const pending = this.pending;
    if (
      !pending
      || pending.replacement
      || record.generation !== pending.expectedGeneration
    ) return false;
    pending.replacement = record;
    return true;
  }

  cleanupAllowed(record: RuntimeProcessRecord): boolean {
    return !this.rejectedCleanup.has(record);
  }

  succeed(record: RuntimeProcessRecord): boolean {
    const pending = this.pending;
    if (!pending || pending.replacement !== record) return false;
    this.pending = null;
    pending.resolve(true);
    return true;
  }

  reject(
    message: string,
    record?: RuntimeProcessRecord,
    cleanupRejected = false,
  ): boolean {
    const pending = this.pending;
    if (!pending || (record && !this.owns(record))) return false;
    if (record && cleanupRejected) this.rejectedCleanup.add(record);
    this.pending = null;
    pending.reject(new Error(message));
    return true;
  }

  cancelForStop(): void {
    this.reject("The runtime recycle was cancelled by application shutdown.");
  }
}
