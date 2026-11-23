import { Worker } from "node:worker_threads";
import type { MessageSearchIndexProgress } from "./message-search-indexer";
import {
  messageSearchIndexWorkerResponseSchema,
  type MessageSearchIndexWorkerRequest,
} from "./message-search-index-worker-protocol";

const BATCH_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;

interface PendingBatch {
  resolve(progress: MessageSearchIndexProgress): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class MessageSearchIndexWorker {
  #worker: Worker | null = null;
  #closed = false;
  #next = 1;
  readonly #pending = new Map<number, PendingBatch>();
  readonly #inflight = new Set<Promise<MessageSearchIndexProgress>>();

  constructor(
    private readonly databasePath: string,
    private readonly entry = new URL("./message-search-index-worker.js", import.meta.url),
    private readonly timeoutMs = BATCH_TIMEOUT_MS,
  ) {}

  batch(options: { budgetMs: number; mergeMs: number }): Promise<MessageSearchIndexProgress> {
    if (this.#closed) return Promise.reject(new Error("The message search index worker is closed."));
    const worker = this.#worker ?? this.#start();
    const id = this.#next++;
    const batch = new Promise<MessageSearchIndexProgress>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error("The message search index batch timed out.")), this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      const request: MessageSearchIndexWorkerRequest = { type: "batch", id, ...options };
      worker.postMessage(request);
    });
    this.#inflight.add(batch);
    void batch.catch(() => undefined).finally(() => this.#inflight.delete(batch));
    return batch;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#inflight);
    const worker = this.#worker;
    this.#worker = null;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { void worker.terminate(); }, CLOSE_TIMEOUT_MS);
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      const request: MessageSearchIndexWorkerRequest = { type: "close" };
      worker.postMessage(request);
    });
  }

  #start(): Worker {
    const worker = new Worker(this.entry, {
      workerData: { databasePath: this.databasePath },
      resourceLimits: { maxOldGenerationSizeMb: 96 },
    });
    worker.unref();
    worker.on("message", (value: unknown) => {
      const response = messageSearchIndexWorkerResponseSchema.safeParse(value);
      if (!response.success) {
        this.#fail(new Error("The message search index worker sent an invalid response."));
        return;
      }
      const pending = this.#pending.get(response.data.id);
      if (!pending) return;
      this.#pending.delete(response.data.id);
      clearTimeout(pending.timer);
      if ("progress" in response.data) pending.resolve(response.data.progress);
      else pending.reject(new Error("The message search index batch failed."));
    });
    worker.once("error", () => this.#fail(new Error("The message search index worker failed.")));
    worker.once("exit", () => {
      if (this.#worker === worker) this.#fail(new Error("The message search index worker stopped."), false);
    });
    this.#worker = worker;
    return worker;
  }

  #fail(error: Error, terminate = true): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
    if (!terminate) return;
    const worker = this.#worker;
    this.#worker = null;
    if (worker) void worker.terminate();
  }
}
