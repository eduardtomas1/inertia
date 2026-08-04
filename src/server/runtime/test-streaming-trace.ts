import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

export type StreamingTraceStage =
  | "provider-delta-received"
  | "delta-accepted-by-channel"
  | "stream-flush-started"
  | "sqlite-append-started"
  | "sqlite-append-completed"
  | "projection-event-created"
  | "runtime-event-serialized"
  | "runtime-websocket-send-accepted"
  | "provider-completion-received"
  | "terminal-persistence-completed"
  | "terminal-event-projected";

export interface StreamingTrace {
  mark(stage: StreamingTraceStage): void;
}

const NOOP_TRACE: StreamingTrace = { mark: () => undefined };

/**
 * Benchmark-only, metadata-only attribution. It is enabled explicitly by the
 * desktop benchmark and writes to its private temporary data directory. No
 * provider text, paths, credentials, or identities are recorded.
 */
export function createTestStreamingTrace(dataDirectory: string): StreamingTrace {
  if (process.env.INERTIA_STREAMING_TRACE !== "1") return NOOP_TRACE;
  const path = join(dataDirectory, "streaming-trace.jsonl");
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
  } catch {
    return NOOP_TRACE;
  }
  return {
    mark(stage) {
      try {
        appendFileSync(path, `${JSON.stringify({
          stage,
          monotonicMs: performance.now(),
          wallTimeMs: Date.now(),
        })}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Attribution must never affect the production lifecycle.
      }
    },
  };
}
