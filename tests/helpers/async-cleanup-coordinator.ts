export interface AsyncCleanupOwnership<Resource, Result> {
  readonly resource: Resource;
  close(): Promise<Result>;
}

export interface AsyncCleanupAcquisition<Resource, Result> {
  adopt(resource: Resource): AsyncCleanupOwnership<Resource, Result>;
  abandon(): void;
}

export interface AsyncCleanupCoordinatorOptions {
  readonly closeAttempts?: number;
}

interface CleanupEntry<Resource, Result> {
  readonly resource: Resource;
  completed: boolean;
  result?: Result;
  inFlight: Promise<Result> | null;
  lastFailure: unknown;
}

interface PendingAcquisition {
  readonly completed: Promise<void>;
  finish(): void;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value ?? fallback));
}

/**
 * Owns manually acquired asynchronous resources across a test timeout. Cleanup
 * closes each resource exactly once on success, retries bounded close failures,
 * and does not finish while an acquisition that began before cleanup can still
 * publish a resource. Callers must independently bound the operation that owns
 * each acquisition (for example, Electron's launch timeout).
 */
export class AsyncCleanupCoordinator<Resource, Result> {
  private readonly closeAttempts: number;
  private readonly entries = new Set<CleanupEntry<Resource, Result>>();
  private readonly acquisitions = new Set<PendingAcquisition>();
  private closing = false;
  private cleanupInFlight: Promise<void> | null = null;

  constructor(
    private readonly closeResource: (resource: Resource) => Promise<Result>,
    options: AsyncCleanupCoordinatorOptions = {},
  ) {
    this.closeAttempts = positiveInteger(options.closeAttempts, 2);
  }

  get ownedResources(): number {
    return this.entries.size;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  beginAcquisition(): AsyncCleanupAcquisition<Resource, Result> {
    if (this.closing) {
      throw new Error("Resource acquisition cannot begin after cleanup started.");
    }
    let finishCompletion!: () => void;
    let settled = false;
    const pending: PendingAcquisition = {
      completed: new Promise<void>((resolve) => {
        finishCompletion = resolve;
      }),
      finish: () => {
        if (settled) return;
        settled = true;
        this.acquisitions.delete(pending);
        finishCompletion();
      },
    };
    this.acquisitions.add(pending);
    return {
      adopt: (resource) => {
        if (settled) {
          throw new Error("The resource acquisition has already settled.");
        }
        const ownership = this.adopt(resource);
        pending.finish();
        if (this.closing) {
          throw new Error("Resource acquisition completed after cleanup started.");
        }
        return ownership;
      },
      abandon: () => pending.finish(),
    };
  }

  async cleanup(): Promise<void> {
    this.closing = true;
    const active = this.cleanupInFlight;
    if (active) {
      try {
        await active;
      } catch {
        // The active owner leaves failed entries registered. This waiter gets
        // one fresh bounded retry instead of silently inheriting the failure.
      }
      if (this.entries.size === 0 && this.acquisitions.size === 0) return;
      return this.cleanup();
    }

    const cleanup = this.drain();
    this.cleanupInFlight = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.cleanupInFlight === cleanup) this.cleanupInFlight = null;
    }
  }

  private adopt(resource: Resource): AsyncCleanupOwnership<Resource, Result> {
    const entry: CleanupEntry<Resource, Result> = {
      resource,
      completed: false,
      inFlight: null,
      lastFailure: undefined,
    };
    this.entries.add(entry);
    return {
      resource,
      close: async () => await this.close(entry),
    };
  }

  private async drain(): Promise<void> {
    const acquisitions = [...this.acquisitions].map(
      (acquisition) => acquisition.completed,
    );
    if (acquisitions.length > 0) {
      await Promise.all(acquisitions);
    }

    for (let attempt = 0;
      attempt < this.closeAttempts && this.entries.size > 0;
      attempt += 1) {
      await Promise.allSettled([...this.entries].map(
        async (entry) => await this.close(entry),
      ));
    }
    if (this.entries.size > 0) {
      throw new AggregateError(
        [...this.entries].map((entry) => entry.lastFailure),
        `Failed to close ${this.entries.size} owned cleanup resource(s).`,
      );
    }
  }

  private async close(entry: CleanupEntry<Resource, Result>): Promise<Result> {
    if (entry.completed) return entry.result as Result;
    if (entry.inFlight) return await entry.inFlight;
    const closing = Promise.resolve().then(
      async () => await this.closeResource(entry.resource),
    );
    entry.inFlight = closing;
    try {
      const result = await closing;
      entry.completed = true;
      entry.result = result;
      entry.lastFailure = undefined;
      this.entries.delete(entry);
      return result;
    } catch (error) {
      entry.lastFailure = error;
      throw error;
    } finally {
      if (entry.inFlight === closing) entry.inFlight = null;
    }
  }
}
