import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { captureBoundedFailureDiagnostic } from "./bounded-failure-diagnostic";

export const INSTALLER_GUARD_TRACE_LIMIT = 32;
export const INSTALLER_GUARD_QUERY_BYTES = 1024;
export const INSTALLER_GUARD_DIAGNOSTIC_MS = 250;
const phases = ["directories", "compiler-lookup", "compilation", "blocker-copy",
  "blocker-spawn", "blocker-close", "guard", "query-read", "guard-assertions", "blocker-assertions",
  "installed-blocker-close", "blocker-cleanup", "blocker-kill", "root-removal"] as const;
type Phase = typeof phases[number];
type RootCategory = "installed" | "fresh" | "unsafe-file";
export interface InstallerGuardProbe { index: number; expectedCode: number; root: RootCategory }
interface Context { blockerIndex?: number; probe?: InstallerGuardProbe }
interface CompletedProbe { expectedCode: number; exitCode: number | null; elapsedMs: number;
  queryResult: string; powerShellPath: string }

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;
function projectProbe(probe: InstallerGuardProbe) {
  return { index: [0, 1, 2, 3].includes(probe.index) ? probe.index : null,
    expectedCode: [0, 1, 2].includes(probe.expectedCode) ? probe.expectedCode : null,
    root: ["installed", "fresh", "unsafe-file"].includes(probe.root) ? probe.root : "other" };
}

export function projectInstallerGuardQuery(contents: string) {
  const [query = "", path = ""] = contents.slice(0, INSTALLER_GUARD_QUERY_BYTES).split(/\r?\n/u);
  return {
    queryResult: ["0", "1", "2", "error", "timeout", "result-not-recorded"].includes(query)
      ? query : "unrecognized",
    powerShell: /\\Sysnative\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu.test(path)
      ? "native-sysnative" : /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu.test(path)
        ? "system32" : path.length === 0 ? "absent" : "other",
  };
}

export async function readInstallerGuardQuery(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return { state: "not-regular" };
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const bytes = Buffer.alloc(INSTALLER_GUARD_QUERY_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return { state: bytesRead > INSTALLER_GUARD_QUERY_BYTES ? "truncated" : "read",
      ...projectInstallerGuardQuery(bytes.subarray(0, Math.min(bytesRead, INSTALLER_GUARD_QUERY_BYTES)).toString("utf8")) };
  } finally { await file.close(); }
}

export function createInstallerGuardTrace(modulePaths: "inherited" | "external-only" = "inherited") {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  type Entry = { phase: Phase; startMs: number; endMs: number | null;
    outcome: "pending" | "completed" | "rejected"; blockerIndex: number | null;
    ownedPid: number | null; spawnedAtMs: number | null;
    probe: ReturnType<typeof projectProbe> | null };
  const entries: Entry[] = [];
  let dropped = 0;
  const begin = (phase: Phase, context: Context = {}): Entry => {
    const entry: Entry = { phase, startMs: elapsed(), endMs: null, outcome: "pending",
      ownedPid: null, spawnedAtMs: null,
      blockerIndex: context.blockerIndex === 0 || context.blockerIndex === 1 ? context.blockerIndex : null,
      probe: context.probe ? projectProbe(context.probe) : null };
    if (entries.length === INSTALLER_GUARD_TRACE_LIMIT) { entries.shift(); dropped += 1; }
    entries.push(entry);
    return entry;
  };
  const end = (entry: Entry, outcome: "completed" | "rejected") => {
    entry.endMs = elapsed();
    entry.outcome = outcome;
  };
  return {
    spawned(pid: number | undefined) {
      const entry = entries.findLast((value) => value.outcome === "pending"
        && (value.phase === "compilation" || value.phase === "guard"));
      if (entry) { entry.ownedPid = integer(pid); entry.spawnedAtMs = elapsed(); }
    },
    async step<T>(phase: Phase, operation: () => Promise<T>, context?: Context): Promise<T> {
      const entry = begin(phase, context);
      try { const result = await operation(); end(entry, "completed"); return result; }
      catch (error) { end(entry, "rejected"); throw error; }
    },
    check<T>(phase: Phase, operation: () => T, context?: Context): T {
      const entry = begin(phase, context);
      try { const result = operation(); end(entry, "completed"); return result; }
      catch (error) { end(entry, "rejected"); throw error; }
    },
    snapshot(children: readonly ChildProcess[], completed: readonly CompletedProbe[]) {
      const trace = entries.map((entry) => ({ ...entry, probe: entry.probe ? { ...entry.probe } : null }));
      return { modulePaths, startedAt, capturedAtMs: elapsed(), dropped, trace,
        pendingPhase: trace.findLast((entry) => entry.outcome === "pending") ?? null,
        children: children.slice(0, 2).map((child, index) => ({ index,
          pid: integer(child.pid), exitCode: integer(child.exitCode),
          signalCode: child.signalCode === null ? null
            : ["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGBREAK", "SIGHUP"].includes(child.signalCode)
              ? child.signalCode : "other",
          stdinDestroyed: child.stdin?.destroyed ?? null,
        })),
        completedProbes: completed.slice(0, 4).map((probe) => ({
          expectedCode: [0, 1, 2].includes(probe.expectedCode) ? probe.expectedCode : null,
          exitCode: integer(probe.exitCode), elapsedMs: integer(probe.elapsedMs),
          ...projectInstallerGuardQuery(`${probe.queryResult}\n${probe.powerShellPath}`),
        })),
      };
    },
  };
}

// Only the failed scenario reads its four fixed query files. Diagnostic read or
// reporting failure must not escape the hook, await indefinitely, or affect the
// fixture's original assertion error, process cleanup, or success conditions.
export async function reportInstallerGuardFailure(
  trace: ReturnType<typeof createInstallerGuardTrace>,
  root: string,
  children: readonly ChildProcess[],
  completed: readonly CompletedProbe[],
  options: {
    readQuery?: typeof readInstallerGuardQuery;
    write?: (line: string) => void | Promise<unknown>;
  } = {},
): Promise<void> {
  try {
    const snapshot = trace.snapshot(children, completed);
    const queryFiles = await captureBoundedFailureDiagnostic(async () =>
      await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        try {
          const value = await (options.readQuery ?? readInstallerGuardQuery)(join(root, `query-result-${index}.txt`));
          return { index, ...value };
        } catch { return { index, state: "unavailable" }; }
      })), INSTALLER_GUARD_DIAGNOSTIC_MS);
    const line = `Compiled NSIS guard failure: ${JSON.stringify({ ...snapshot, queryFiles })}\n`;
    await captureBoundedFailureDiagnostic(async () => {
      if (options.write) await options.write(line);
      else process.stderr.write(line);
    }, INSTALLER_GUARD_DIAGNOSTIC_MS);
  } catch { /* Diagnostics never replace the original test failure. */ }
}
