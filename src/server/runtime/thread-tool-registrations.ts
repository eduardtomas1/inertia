/** Pack id to definition digest, as one provider thread registered them. */
export type ThreadToolPackDigests = ReadonlyMap<string, string>;

/**
 * What each thread of a thread-scoped transport registered when it started.
 * `read` returns null when there is no record of the thread.
 */
export interface ThreadToolRegistrations {
  record(threadId: string, packs: ThreadToolPackDigests): void;
  read(threadId: string): ThreadToolPackDigests | null;
}

const MAX_CACHED_THREADS = 1_024;

/**
 * A bounded memory of recent registrations in front of an optional durable
 * store. A store that cannot be written or read leaves the memory in charge
 * for this runtime: a thread without any record then keeps only the packs
 * every resumable thread registered, which never overstates its tools.
 */
export class CachedThreadToolRegistrations implements ThreadToolRegistrations {
  readonly #cache = new Map<string, ThreadToolPackDigests>();
  readonly #durable: ThreadToolRegistrations | undefined;

  constructor(durable?: ThreadToolRegistrations) {
    this.#durable = durable;
  }

  record(threadId: string, packs: ThreadToolPackDigests): void {
    const registered: ThreadToolPackDigests = new Map(packs);
    try {
      this.#durable?.record(threadId, registered);
    } catch {
      // Kept in memory below; the durable record is best effort.
    }
    this.#remember(threadId, registered);
  }

  read(threadId: string): ThreadToolPackDigests | null {
    const cached = this.#cache.get(threadId);
    if (cached) return cached;
    let stored: ThreadToolPackDigests | null = null;
    try {
      stored = this.#durable?.read(threadId) ?? null;
    } catch {
      stored = null;
    }
    if (stored) this.#remember(threadId, stored);
    return stored;
  }

  #remember(threadId: string, packs: ThreadToolPackDigests): void {
    this.#cache.delete(threadId);
    this.#cache.set(threadId, packs);
    while (this.#cache.size > MAX_CACHED_THREADS) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
