import type { MessageSearchIndexProgress } from "../persistence/message-search-indexer";
import type { DatabaseWriteRunner } from "./database-write-gate";

export const MESSAGE_SEARCH_INDEX_BATCH_MS = 10;
export const MESSAGE_SEARCH_MERGE_SLICE_MS = 25;
export const MESSAGE_SEARCH_INDEX_DELAYS_MS = {
  start: 5_000,
  continue: 40,
  busy: 1_000,
  settled: 5_000,
  failed: 60_000,
} as const;

export type MessageSearchIndexAvailability = "idle" | "busy" | "blocked";

export interface MessageSearchIndexingDependencies {
  index(options: { budgetMs: number; mergeMs: number }): Promise<MessageSearchIndexProgress>;
  writes: DatabaseWriteRunner;
  availability(): MessageSearchIndexAvailability;
  signal: AbortSignal;
  onFailure?(error: unknown): void;
  delays?: Partial<Record<keyof typeof MESSAGE_SEARCH_INDEX_DELAYS_MS, number>>;
}

export function startMessageSearchIndexing(dependencies: MessageSearchIndexingDependencies): void {
  const delays = { ...MESSAGE_SEARCH_INDEX_DELAYS_MS, ...dependencies.delays };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number): void => {
    if (dependencies.signal.aborted) return;
    timer = setTimeout(() => { void tick(); }, delay);
    timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    if (dependencies.signal.aborted) return;
    const availability = dependencies.availability();
    if (availability === "blocked") { schedule(delays.busy); return; }
    let progress: MessageSearchIndexProgress;
    try {
      progress = await dependencies.writes.run(() => dependencies.signal.aborted
        ? Promise.resolve({ remaining: false, backfillComplete: false })
        : dependencies.index({
          budgetMs: MESSAGE_SEARCH_INDEX_BATCH_MS,
          mergeMs: availability === "idle" ? MESSAGE_SEARCH_MERGE_SLICE_MS : 0,
        }));
    } catch (error) {
      if (!dependencies.signal.aborted) dependencies.onFailure?.(error);
      schedule(delays.failed);
      return;
    }
    schedule(!progress.remaining ? delays.settled : availability === "busy" ? delays.busy : delays.continue);
  };
  dependencies.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  schedule(delays.start);
}
