import type { TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../../../src/node/platform-file-open-flags";
import { isRuntimeStartupBlockerCode } from "../../../src/shared/runtime-startup-diagnostics";
import { captureBoundedFailureDiagnostic } from "../../helpers/bounded-failure-diagnostic";
import type { AppFixture } from "./app-fixture";
import { attachRuntimeLifecycleFailureDiagnostic } from "./runtime-lifecycle-diagnostics";

const phases = new Set(["idle", "starting", "ready", "restarting", "stopping", "stopped"]);
const failureCodes = new Map([
  ["The runtime generation ownership lease could not be persisted.", "lease-persist-failed"],
  ["The unstarted runtime generation lease could not be retired.", "lease-retire-failed"],
  ["The confirmed runtime cleanup receipt could not be persisted.", "receipt-persist-failed"],
  ["The runtime cleanup receipt could not be consumed safely.", "receipt-consume-failed"],
  ["The runtime could not confirm complete process cleanup.", "cleanup-unconfirmed"],
  ["Runtime shutdown failed while closing local resources.", "resource-close-failed"],
  ["Runtime shutdown exceeded its deadline while closing local resources.", "resource-close-deadline"],
  ["Runtime shutdown could not confirm owned-process cleanup.", "owned-process-cleanup-unconfirmed"],
  ["Runtime shutdown could not confirm cleanup after incomplete startup.", "startup-cleanup-unconfirmed"],
  ["Conversation attachment storage shutdown could not be confirmed.", "attachment-close-unconfirmed"],
  ["The runtime process did not become ready in time.", "startup-timeout"],
  ["Runtime startup timed out.", "startup-timeout"],
  ["The runtime process sent an invalid lifecycle message.", "invalid-lifecycle-message"],
  ["Runtime lifecycle validation failed.", "invalid-lifecycle-message"],
  ["Runtime process could not be created.", "spawn-failed"],
  ["Runtime shutdown exceeded its deadline.", "shutdown-deadline"],
  ["Runtime process reported an operating-system error.", "operating-system-error"],
]);
const failurePrefixes = [
  ["The runtime process tree could not be confirmed stopped.", "process-tree-stop-unconfirmed"],
  ["The runtime exited before complete process-tree cleanup was confirmed.", "exit-before-cleanup"],
  ["The runtime process tree was stopped, but prior detached work could not be confirmed cleaned up.", "detached-cleanup-unconfirmed"],
  ["A prior runtime generation still has unconfirmed process cleanup.", "prior-generation-cleanup-unconfirmed"],
] as const;

function failureCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 4_096) return "detail-omitted";
  return failureCodes.get(value)
    ?? failurePrefixes.find(([prefix]) => value.startsWith(prefix))?.[1]
    ?? (/^(?:The runtime|Runtime) process exited unexpectedly \(code -?\d{1,10}\)\.$/u.test(value)
      ? "unexpected-exit" : "detail-omitted");
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value : null;
}

export function projectImageSendRuntimeSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  return {
    phase: typeof snapshot.phase === "string" && phases.has(snapshot.phase) ? snapshot.phase : null,
    generation: integer(snapshot.generation),
    pid: integer(snapshot.pid, 2_147_483_647),
    restartAttempt: integer(snapshot.restartAttempt, 1_000_000),
    restartScheduled: typeof snapshot.restartScheduled === "boolean" ? snapshot.restartScheduled : null,
    lastErrorCode: failureCode(snapshot.lastError),
    startupBlockerCode: isRuntimeStartupBlockerCode(snapshot.startupBlockerCode)
      ? snapshot.startupBlockerCode : null,
  };
}

function projectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !["runtime.state", "runtime.failure"].includes(String(record.event))
    || typeof record.at !== "string" || record.at.length > 40 || !Number.isFinite(Date.parse(record.at))
    || new Date(record.at).toISOString() !== record.at
    || typeof record.recordDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.recordDigest)) return null;
  const allowed = new Set(["schemaVersion", "at", "event", "recordDigest", "phase", "generation",
    "processId", "restartAttempt", "restartScheduled", "startupBlockerCode", "message"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  const payload = JSON.stringify(Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== "recordDigest")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
  if (createHash("sha256").update(payload).digest("hex") !== record.recordDigest) return null;
  return { at: record.at, event: record.event, ...projectImageSendRuntimeSnapshot({
    ...record, pid: record.processId, lastError: record.message,
  }) };
}

export async function readImageSendRuntimeRecords(
  testDirectory: string,
  signal: AbortSignal,
): Promise<readonly Record<string, unknown>[]> {
  // Only the private fixture's four known log files are inspected. Never call
  // RuntimeDiagnostics.supportReport(): it creates/prunes the log directory.
  const root = await realpath(testDirectory);
  let directory = root;
  for (const part of ["electron-profile", "logs", "runtime"]) {
    signal.throwIfAborted();
    directory = join(directory, part);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) return [];
  }
  let result: Record<string, unknown>[] = [];
  for (const name of ["runtime.3.log", "runtime.2.log", "runtime.1.log", "runtime.log"]) {
    signal.throwIfAborted();
    const path = join(directory, name);
    const metadata = await lstat(path).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1_024) continue;
    const handle = await open(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW).catch(() => null);
    if (!handle) continue;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) continue;
      signal.throwIfAborted();
      const bytes = Buffer.alloc(Math.min(opened.size, 256 * 1_024));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      signal.throwIfAborted();
      const lines = bytes.subarray(0, bytesRead).toString("utf8").split("\n");
      // A concurrent write can leave a partial final record; omit it.
      lines.pop();
      for (const line of lines) {
        if (line.length > 4_096) continue;
        let record: Record<string, unknown> | null;
        try { record = projectRecord(JSON.parse(line)); } catch { continue; }
        if (record) result = [...result.slice(-31), record];
      }
    } finally { await handle.close(); }
  }
  return result;
}

export async function attachImageSendFailureDiagnostics(
  testInfo: Pick<TestInfo, "attach">,
  app: Pick<AppFixture, "runtimeSnapshot" | "testDirectory">,
): Promise<void> {
  // Capture before fixture close: supervisor.stop() can replace the original
  // error with a generic prior-generation cleanup failure. No raw error or
  // authenticated endpoint is retained in an attachment.
  const controller = new AbortController();
  let websocketUrl: string | null = null;
  const [runtime, records] = await Promise.all([
    captureBoundedFailureDiagnostic(async () => {
      const snapshot = await app.runtimeSnapshot();
      if (controller.signal.aborted) return null;
      websocketUrl = snapshot.websocketUrl;
      return projectImageSendRuntimeSnapshot(snapshot);
    }, 500),
    captureBoundedFailureDiagnostic(() =>
      readImageSendRuntimeRecords(app.testDirectory, controller.signal), 500),
  ]);
  controller.abort();
  const boundedTestInfo = { attach: async (...args: Parameters<TestInfo["attach"]>): Promise<void> => {
    await captureBoundedFailureDiagnostic(() => testInfo.attach(...args), 250);
  } };
  await Promise.all([
    boundedTestInfo.attach("image-send-pre-close-runtime", {
      body: JSON.stringify({ runtime, records }, null, 2), contentType: "application/json",
    }),
    attachRuntimeLifecycleFailureDiagnostic(boundedTestInfo, async () => websocketUrl),
  ]);
}
