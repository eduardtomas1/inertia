interface AttachmentStoreExecution {
  readonly stopped: Promise<void>;
  readonly termination?: Promise<void>;
}

/** Keeps failed work terminal while allowing Linux close to re-check exact exit proof. */
export class ConversationAttachmentStoreTerminationTracker {
  private failure: Error | null = null;
  private permanentlyUnconfirmed = false;
  private readonly unconfirmed = new Set<object>();

  constructor(private readonly retryUnconfirmedShutdown: boolean) {}

  track(execution: AttachmentStoreExecution): Promise<void> {
    const token = {};
    let stopFailed = false;
    let terminationObserved = false;
    let terminationRejected = false;
    if (execution.termination) {
      void execution.termination.then(() => {
        terminationObserved = true;
        this.unconfirmed.delete(token);
      }, () => {
        terminationRejected = true;
        this.unconfirmed.delete(token);
        if (stopFailed) this.permanentlyUnconfirmed = true;
      });
    }
    return execution.stopped.catch((error: unknown) => {
      stopFailed = true;
      this.failure ??= error instanceof Error ? error : new Error(String(error));
      if (!this.retryUnconfirmedShutdown || !execution.termination) {
        this.permanentlyUnconfirmed = true;
      } else if (terminationRejected) {
        this.permanentlyUnconfirmed = true;
      } else if (!terminationObserved) {
        this.unconfirmed.add(token);
      }
      throw error;
    });
  }

  operationFailure(): Error | null {
    return this.failure;
  }

  closeFailure(): Error | null {
    if (!this.failure) return null;
    return !this.retryUnconfirmedShutdown
      || this.permanentlyUnconfirmed
      || this.unconfirmed.size > 0
      ? this.failure
      : null;
  }
}
