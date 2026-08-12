export class TurnNativeGoalMutationGate {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly inProgress = new Set<string>();

  blocksTurnAdmission(conversationId: string): boolean {
    return this.inProgress.has(conversationId);
  }

  async run<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.tails.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => current);
    this.tails.set(conversationId, tail);
    await predecessor.catch(() => undefined);
    this.inProgress.add(conversationId);
    try {
      return await operation();
    } finally {
      this.inProgress.delete(conversationId);
      release();
      if (this.tails.get(conversationId) === tail) {
        this.tails.delete(conversationId);
      }
    }
  }
}
