export class TurnNativeGoalMutationGate {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly inProgress = new Set<string>();

  blocksTurnAdmission(conversationId: string): boolean {
    return this.tails.has(conversationId);
  }

  async waitForIdle(
    conversationId: string,
    deadlineAt = Number.POSITIVE_INFINITY,
  ): Promise<boolean> {
    if (!Number.isFinite(deadlineAt)) {
      await this.tails.get(conversationId)?.catch(() => undefined);
      return true;
    }
    while (this.tails.has(conversationId)) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(25, remaining));
      });
    }
    return true;
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
