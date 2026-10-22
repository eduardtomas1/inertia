import type { RuntimeStore } from "../../database";

export const JUDGE_CHECKOUT_BUSY_NOTICE =
  "Another operation is using the judge's folder, such as a resumed terminal, a run or a review. The judge starts by itself as soon as the folder is free.";

const CHECKOUT_ACQUIRE_POLL_MS = 50;

export type JudgeCheckoutReservation =
  | { kind: "reserved" }
  | { kind: "busy" }
  | { kind: "closing" }
  | { kind: "unavailable"; error: unknown };

export async function reserveJudgeCheckout(
  store: Pick<RuntimeStore, "conversationWork">,
  conversationId: string,
  timeoutMs: number,
  closing: () => boolean,
): Promise<JudgeCheckoutReservation> {
  const deadlineAt = Date.now() + timeoutMs;
  while (true) {
    if (closing()) return { kind: "closing" };
    try {
      if (store.conversationWork.reserve(conversationId)) {
        return { kind: "reserved" };
      }
    } catch (error) {
      return { kind: "unavailable", error };
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return { kind: "busy" };
    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.min(CHECKOUT_ACQUIRE_POLL_MS, remainingMs),
      ).unref();
    });
  }
}

interface ScheduledRetry {
  timer: ReturnType<typeof setTimeout> | null;
  delayMs: number;
}

export class JudgeRetrySchedule {
  private readonly retries = new Map<string, ScheduledRetry>();

  constructor(
    private readonly initialDelayMs: number,
    private readonly maximumDelayMs: number,
  ) {}

  schedule(launchId: string, run: () => void): void {
    const previous = this.retries.get(launchId);
    if (previous?.timer) return;
    const delayMs = previous
      ? Math.min(previous.delayMs * 2, this.maximumDelayMs)
      : this.initialDelayMs;
    const retry: ScheduledRetry = { timer: null, delayMs };
    retry.timer = setTimeout(() => {
      retry.timer = null;
      run();
    }, delayMs);
    retry.timer.unref();
    this.retries.set(launchId, retry);
  }

  has(launchId: string): boolean {
    return this.retries.get(launchId)?.timer != null;
  }

  clear(launchId: string): void {
    const retry = this.retries.get(launchId);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retries.delete(launchId);
  }
}
