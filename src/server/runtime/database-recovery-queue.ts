export class DatabaseRecoveryOperationCancelledError extends Error {
  constructor() {
    super("The database recovery operation was cancelled during runtime shutdown.");
    this.name = "DatabaseRecoveryOperationCancelledError";
  }
}

export class DatabaseRecoveryOperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private accepting = true;

  enqueue<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new DatabaseRecoveryOperationCancelledError());
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const result = this.tail.then(async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    }).finally(() => {
      this.controllers.delete(controller);
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async closeAndDrain(): Promise<void> {
    if (this.accepting) {
      this.accepting = false;
      for (const controller of this.controllers) {
        controller.abort(new DatabaseRecoveryOperationCancelledError());
      }
    }
    await this.tail;
  }
}
