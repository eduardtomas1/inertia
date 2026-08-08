import type { StructuredDiff } from "@shared/contracts";

interface DiffParseResponse {
  id: number;
  result?: StructuredDiff;
  error?: string;
}

interface DiffParseJob {
  id: number;
  patch: string;
  cancelled: boolean;
  resolve: (result: StructuredDiff) => void;
  reject: (error: Error) => void;
}

interface DiffParserSlot {
  worker: Worker;
  current: DiffParseJob | null;
}

const MAX_DIFF_PARSER_WORKERS = 4;
let pool: DiffParserPool | null = null;

function cancelledError(): Error {
  return new Error("Diff parsing was superseded.");
}

class DiffParserPool {
  readonly #slots: DiffParserSlot[];
  readonly #queue: DiffParseJob[] = [];
  #nextId = 1;

  constructor() {
    const available = Math.max(1, navigator.hardwareConcurrency || 1);
    const size = Math.max(
      1,
      Math.min(MAX_DIFF_PARSER_WORKERS, Math.floor(available / 2)),
    );
    this.#slots = Array.from({ length: size }, () => this.#createSlot());
  }

  parse(patch: string, signal: AbortSignal): Promise<StructuredDiff> {
    if (signal.aborted) return Promise.reject(cancelledError());
    return new Promise((resolve, reject) => {
      const job: DiffParseJob = {
        id: this.#nextId,
        patch,
        cancelled: false,
        resolve,
        reject,
      };
      this.#nextId += 1;
      signal.addEventListener("abort", () => {
        job.cancelled = true;
      }, { once: true });
      this.#queue.push(job);
      this.#pump();
    });
  }

  #createSlot(): DiffParserSlot {
    const slot: DiffParserSlot = {
      worker: undefined as unknown as Worker,
      current: null,
    };
    this.#replaceWorker(slot);
    return slot;
  }

  #replaceWorker(slot: DiffParserSlot): void {
    const worker = new Worker(
      new URL("../workers/diff-parser.worker.ts", import.meta.url),
      { type: "module" },
    );
    slot.worker = worker;
    worker.addEventListener("message", (
      event: MessageEvent<DiffParseResponse>,
    ) => {
      const current = slot.current;
      if (!current || event.data.id !== current.id) return;
      slot.current = null;
      if (current.cancelled) current.reject(cancelledError());
      else if (event.data.result) current.resolve(event.data.result);
      else current.reject(new Error(
        event.data.error ?? "The diff could not be parsed.",
      ));
      this.#pump();
    });
    worker.addEventListener("error", () => {
      const current = slot.current;
      slot.current = null;
      current?.reject(new Error(
        "The diff parser worker stopped unexpectedly.",
      ));
      worker.terminate();
      this.#replaceWorker(slot);
      this.#pump();
    });
  }

  #pump(): void {
    for (const slot of this.#slots) {
      if (slot.current) continue;
      let next = this.#queue.shift() ?? null;
      while (next?.cancelled) {
        next.reject(cancelledError());
        next = this.#queue.shift() ?? null;
      }
      if (!next) return;
      slot.current = next;
      slot.worker.postMessage({ id: next.id, patch: next.patch });
    }
  }
}

export function parseDiffOffMainThread(
  patch: string,
  signal: AbortSignal,
): Promise<StructuredDiff> {
  pool ??= new DiffParserPool();
  return pool.parse(patch, signal);
}
