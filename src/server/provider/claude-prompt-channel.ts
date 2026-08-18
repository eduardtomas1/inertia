import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_PROMPT_MAX_QUEUED_MESSAGES = 16;
export const CLAUDE_PROMPT_MAX_QUEUED_BYTES = 32 * 1024 * 1024;

export interface ClaudePromptReservation {
  readonly token: symbol;
}

interface QueuedClaudePrompt {
  readonly message: SDKUserMessage;
  readonly reservation: ClaudePromptReservation;
}

/**
 * One persistent SDK input stream for a parent session. Follow-ups are queued
 * in wire order and consumed by the same Query; they never start a detached
 * session or pretend to message a child task directly.
 */
export class ClaudePromptChannel implements AsyncIterable<SDKUserMessage> {
  private readonly queued: QueuedClaudePrompt[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<SDKUserMessage>) => void
  > = [];
  private readonly reservations = new Map<ClaudePromptReservation, number>();
  private reservedBytes = 0;
  private closed = false;

  constructor(
    private readonly maxQueuedMessages = CLAUDE_PROMPT_MAX_QUEUED_MESSAGES,
    private readonly maxQueuedBytes = CLAUDE_PROMPT_MAX_QUEUED_BYTES,
  ) {}

  reserve(bytes: number): ClaudePromptReservation | null {
    if (
      this.closed
      || !Number.isSafeInteger(bytes)
      || bytes <= 0
      || bytes > this.maxQueuedBytes
      || this.reservations.size >= this.maxQueuedMessages
      || this.reservedBytes + bytes > this.maxQueuedBytes
    ) return null;
    const reservation = { token: Symbol("claude-prompt") };
    this.reservations.set(reservation, bytes);
    this.reservedBytes += bytes;
    return reservation;
  }

  release(reservation: ClaudePromptReservation): void {
    const bytes = this.reservations.get(reservation);
    if (bytes === undefined) return;
    this.reservations.delete(reservation);
    this.reservedBytes -= bytes;
  }

  push(
    message: SDKUserMessage,
    reservation: ClaudePromptReservation,
  ): boolean {
    if (this.closed || !this.reservations.has(reservation)) {
      this.release(reservation);
      return false;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      this.release(reservation);
      waiter({ done: false, value: message });
    } else {
      this.queued.push({ message, reservation });
    }
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
    for (const { reservation } of this.queued) this.release(reservation);
    this.queued.length = 0;
    for (const reservation of this.reservations.keys()) {
      this.release(reservation);
    }
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
          this.release(queued.reservation);
          if (this.closed && this.queued.length === 0) {
            this.finishWaiters();
          }
          return { done: false, value: queued.message };
        }
        if (this.closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<SDKUserMessage>> => {
        this.cancel();
        return { done: true, value: undefined };
      },
    };
  }
}
