import { Worker } from "node:worker_threads";
import { type MessageSearchResult } from "../../shared/message-search";
import { messageSearchResultSchema } from "../../shared/message-search-schema";

export function runMessageSearchWorker(
  databasePath: string,
  query: string,
  signal: AbortSignal,
): Promise<MessageSearchResult> {
  if (signal.aborted) return Promise.reject(new Error("Search cancelled."));
  const worker = new Worker(new URL("./message-search-worker.js", import.meta.url), {
    workerData: { databasePath, query },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  return new Promise((resolve, reject) => {
    let result: MessageSearchResult | null = null;
    let failed = false;
    let stopping = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      worker.removeAllListeners();
    };
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void worker.terminate().then(() => {
        cleanup();
        reject(new Error("Search cancelled or timed out."));
      }, () => {
        cleanup();
        reject(new Error("Search worker could not stop."));
      });
    };
    const timer = setTimeout(stop, 5_000);
    signal.addEventListener("abort", stop, { once: true });
    worker.on("message", (value: unknown) => {
      const parsed = messageSearchResultSchema.safeParse(value);
      if (!parsed.success || parsed.data.query !== query || result) failed = true;
      else result = parsed.data;
    });
    worker.once("error", () => { failed = true; });
    worker.once("exit", (code) => {
      if (stopping) return;
      cleanup();
      if (failed || code !== 0 || !result) reject(new Error("Message search failed."));
      else resolve(result);
    });
    if (signal.aborted) stop();
  });
}
