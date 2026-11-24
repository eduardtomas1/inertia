import type { MessageSearchIndexProgress } from "../persistence/message-search-indexer";
import type { DatabaseWriteRunner } from "./database-write-gate";

export const MESSAGE_SEARCH_INDEX_SLICE_MS = 10;
export const MESSAGE_SEARCH_MERGE_SLICE_MS = 10;
export const MESSAGE_SEARCH_INDEX_DELAYS_MS = {
  start: 5_000,
  busy: 1_000,
  settled: 5_000,
  failed: 60_000,
} as const;

export interface MessageSearchIndexIdleState {
  closed: boolean;
  safetyLocked: boolean;
  updatePreparing: boolean;
  recoveryActive: boolean;
  activeRuntimeCommands: number;
  activeTurns: boolean;
  activeRuns: boolean;
  providerMaintenanceActive: boolean;
  backingUp: boolean;
  compacting: boolean;
}

export function messageSearchIndexIdle(state: MessageSearchIndexIdleState): boolean {
  return !state.closed && !state.safetyLocked && !state.updatePreparing && !state.recoveryActive
    && state.activeRuntimeCommands === 0 && !state.activeTurns && !state.activeRuns
    && !state.providerMaintenanceActive && !state.backingUp && !state.compacting;
}

export interface MessageSearchIndexingDependencies {
  index(budgetMs: number): MessageSearchIndexProgress;
  merge(budgetMs: number): boolean;
  writes: DatabaseWriteRunner;
  idle(): boolean;
  signal: AbortSignal;
  onFailure?(error: unknown): void;
  delays?: Partial<Record<keyof typeof MESSAGE_SEARCH_INDEX_DELAYS_MS, number>>;
}

type Slice = "index" | "merge";

export function startMessageSearchIndexing(dependencies: MessageSearchIndexingDependencies): void {
  const delays = { ...MESSAGE_SEARCH_INDEX_DELAYS_MS, ...dependencies.delays };
  const { signal } = dependencies;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number): void => {
    if (signal.aborted) return;
    timer = setTimeout(() => { void run(); }, delay);
    timer.unref?.();
  };
  const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
  const slice = (kind: Slice): Promise<boolean | null> => dependencies.writes.run(async () => {
    if (signal.aborted || !dependencies.idle()) return null;
    return kind === "index"
      ? dependencies.index(MESSAGE_SEARCH_INDEX_SLICE_MS).remaining
      : dependencies.merge(MESSAGE_SEARCH_MERGE_SLICE_MS);
  }, { yieldsToCompaction: true });
  const run = async (): Promise<void> => {
    let indexing = true;
    let merging = true;
    try {
      while (indexing || merging) {
        for (const kind of ["index", "merge"] as const) {
          if (kind === "index" ? !indexing : !merging) continue;
          if (signal.aborted) return;
          const remaining = await slice(kind);
          if (remaining === null) { schedule(delays.busy); return; }
          if (kind === "index") {
            indexing = remaining;
            merging = true;
          } else {
            merging = remaining;
          }
          await yieldToEventLoop();
        }
      }
    } catch (error) {
      if (!signal.aborted) dependencies.onFailure?.(error);
      schedule(delays.failed);
      return;
    }
    schedule(delays.settled);
  };
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  schedule(delays.start);
}
