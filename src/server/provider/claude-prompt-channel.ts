import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * One persistent SDK input stream for a parent session. Follow-ups are queued
 * in wire order and consumed by the same Query; they never start a detached
 * session or pretend to message a child task directly.
 */
export class ClaudePromptChannel implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<SDKUserMessage>) => void
  > = [];
  private closed = false;

  push(message: SDKUserMessage): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.queued.push(message);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.queued.length > 0) return;
    this.finishWaiters();
  }

  /** Stop semantics discard input that was accepted but not yet consumed. */
  cancel(): void {
    this.closed = true;
    this.queued.length = 0;
    this.finishWaiters();
  }

  private finishWaiters(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        const queued = this.queued.shift();
        if (queued) {
          if (this.closed && this.queued.length === 0) {
            this.finishWaiters();
          }
          return { done: false, value: queued };
        }
        if (this.closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}
