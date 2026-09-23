import type { TestInfo } from "@playwright/test";
import { attachElectronFixtureRuntimeRecords } from "./electron-failure-evidence";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { FILE_OPEN_NO_FOLLOW } from "../../../src/node/platform-file-open-flags";
import { TEST_SHUTDOWN_TRACE_BYTES, TEST_SHUTDOWN_TRACE_FILE } from
  "../../../src/server/runtime/test-shutdown-trace";
import { captureBoundedFailureDiagnostic } from "../../helpers/bounded-failure-diagnostic";

// Match the fixed labels emitted by the opt-in worker trace. Project fields
// explicitly: a file in a failed fixture is not trusted diagnostic content.
const owners = ["commands", "attachments", "terminals", "maintenance",
  "isolated-runs", "turns-providers", "artifact-reconciliation", "artifact-settlement",
  "clients", "websocket", "http-server", "store"];
const phases = ["cleanup", "runtime command cleanup", "owned-resource cleanup",
  "artifact cleanup", "client cleanup", "server cleanup", "database cleanup"];
interface ShutdownTrace {
  deadlinePhase: string | null;
  elapsedMs: number;
  owners: { owner: string; startMs: number; endMs: number | null;
    state: "started" | "settled" | "rejected" }[];
}
type TraceEvidence = { outcome: "captured"; value: ShutdownTrace }
  | { outcome: "unavailable" | "invalid" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timing(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function projectTrace(value: unknown): ShutdownTrace | null {
  if (!record(value) || !timing(value.elapsedMs)
    || (value.deadlinePhase !== null && (typeof value.deadlinePhase !== "string"
      || !phases.includes(value.deadlinePhase)))
    || !Array.isArray(value.owners) || value.owners.length > 32) return null;
  const entries: ShutdownTrace["owners"] = [];
  for (const entry of value.owners) {
    if (!record(entry) || typeof entry.owner !== "string" || !owners.includes(entry.owner)
      || !timing(entry.startMs) || entry.startMs > value.elapsedMs
      || (entry.state !== "started" && entry.state !== "settled" && entry.state !== "rejected")
      || (entry.state === "started" ? entry.endMs !== null
        : !timing(entry.endMs) || entry.endMs < entry.startMs || entry.endMs > value.elapsedMs)) return null;
    entries.push({ owner: entry.owner, startMs: entry.startMs,
      endMs: entry.endMs as number | null, state: entry.state });
  }
  return { deadlinePhase: value.deadlinePhase, elapsedMs: value.elapsedMs, owners: entries };
}

export async function readRuntimeShutdownTrace(
  testDirectory: string,
  signal: AbortSignal,
): Promise<TraceEvidence> {
  signal.throwIfAborted();
  try {
    const rootMetadata = await lstat(testDirectory);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return { outcome: "invalid" };
    const directory = join(await realpath(testDirectory), "data");
    signal.throwIfAborted();
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(directory) !== directory) {
      return { outcome: "invalid" };
    }
    const path = join(directory, TEST_SHUTDOWN_TRACE_FILE);
    signal.throwIfAborted();
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > TEST_SHUTDOWN_TRACE_BYTES) {
      return { outcome: "invalid" };
    }
    const handle = await open(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
    try {
      signal.throwIfAborted();
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > TEST_SHUTDOWN_TRACE_BYTES
        || opened.dev !== metadata.dev || opened.ino !== metadata.ino
        || await realpath(path) !== path) return { outcome: "invalid" };
      // One extra byte detects growth after stat without an unbounded read.
      const bytes = Buffer.alloc(TEST_SHUTDOWN_TRACE_BYTES + 1);
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      signal.throwIfAborted();
      if (bytesRead > TEST_SHUTDOWN_TRACE_BYTES) return { outcome: "invalid" };
      let value: unknown;
      try { value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
      catch { return { outcome: "invalid" }; }
      const trace = projectTrace(value);
      return trace ? { outcome: "captured", value: trace } : { outcome: "invalid" };
    } finally { await handle.close(); }
  } catch {
    signal.throwIfAborted();
    // Missing evidence cannot establish which owner blocked cleanup.
    return { outcome: "unavailable" };
  }
}

export async function attachRuntimeShutdownTrace(
  readTestInfo: () => Pick<TestInfo, "attach">,
  testDirectory: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const captured = await captureBoundedFailureDiagnostic(
    () => readRuntimeShutdownTrace(testDirectory, signal), 500,
  );
  if (signal.aborted) return;
  const evidence = captured.outcome === "captured" ? captured.value
    : { outcome: captured.outcome === "timed-out" ? "timed-out" : "unavailable" };
  await captureBoundedFailureDiagnostic(async () => {
    if (signal.aborted) return;
    await readTestInfo().attach("runtime-shutdown-trace", {
      body: Buffer.from(JSON.stringify(evidence)), contentType: "application/json",
    });
  }, 250);
}

export async function attachRuntimeCleanupEvidence(
  readTestInfo: () => Pick<TestInfo, "attach">,
  testDirectory: string,
  signal: AbortSignal,
  environment?: Record<string, string>,
): Promise<void> {
  await Promise.all([
    attachElectronFixtureRuntimeRecords(readTestInfo, testDirectory, signal),
    environment?.INERTIA_RUNTIME_SHUTDOWN_TRACE === "1"
      ? attachRuntimeShutdownTrace(readTestInfo, testDirectory, signal)
      : Promise.resolve(),
  ]);
}
