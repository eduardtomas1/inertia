/** Serializes mutations from a parent without blocking independent parents. */
export class ManagedMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(sourceConversationId: string, action: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(sourceConversationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.catch(() => undefined).then(() => gate);
    this.tails.set(sourceConversationId, tail);
    await predecessor.catch(() => undefined);
    try { return await action(); }
    finally {
      release();
      if (this.tails.get(sourceConversationId) === tail) this.tails.delete(sourceConversationId);
    }
  }
}
