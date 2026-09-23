import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const TEST_SHUTDOWN_TRACE_FILE = "runtime-shutdown-trace.json";
export const TEST_SHUTDOWN_TRACE_BYTES = 8_192;
const owners = ["commands", "attachments", "terminals", "maintenance",
  "isolated-runs", "turns-providers", "artifact-reconciliation", "artifact-settlement",
  "clients", "websocket", "http-server", "store"] as const;
type Owner = typeof owners[number];
interface Entry {
  owner: Owner;
  startMs: number;
  endMs: number | null;
  state: "started" | "settled" | "rejected";
}
const phases = ["cleanup", "runtime command cleanup", "owned-resource cleanup",
  "artifact cleanup", "client cleanup", "server cleanup", "database cleanup"];
const disabled = {
  observe<T>(_owner: Owner, operation: () => T): T { return operation(); },
  failure(_phase: unknown): void {},
};

// Opt-in native-test evidence. The worker ignores stdout/stderr.
// One exclusive synchronous write completes before runtime.close() rejects and
// the worker posts shutdown-unconfirmed (which triggers supervisor termination).
export function createTestShutdownTrace(dataDirectory: string): typeof disabled {
  if (process.env.NODE_ENV !== "test" || process.env.INERTIA_RUNTIME_SHUTDOWN_TRACE !== "1") return disabled;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const entries: Entry[] = [];
  return {
    observe<T>(owner: Owner, operation: () => T): T {
      if (!owners.includes(owner) || entries.length === 32) return operation();
      const entry: Entry = { owner, startMs: elapsed(), endMs: null, state: "started" };
      entries.push(entry);
      const end = (state: "settled" | "rejected") => { entry.endMs = elapsed(); entry.state = state; };
      try {
        const result = operation();
        // Observe the original promise without replacing it or adding an await.
        if (result instanceof Promise) void result.then(() => end("settled"), () => end("rejected"));
        else end("settled");
        return result;
      } catch (error) { end("rejected"); throw error; }
    },
    failure(phase: unknown): void {
      try {
        const payload = JSON.stringify({
          deadlinePhase: typeof phase === "string" && phases.includes(phase) ? phase : null,
          elapsedMs: elapsed(), owners: entries,
        });
        if (Buffer.byteLength(payload) <= TEST_SHUTDOWN_TRACE_BYTES) {
          writeFileSync(join(dataDirectory, TEST_SHUTDOWN_TRACE_FILE), payload,
            { encoding: "utf8", mode: 0o600, flag: "wx" });
        }
      } catch { /* Diagnostic failure must not replace the original close error. */ }
    },
  };
}
