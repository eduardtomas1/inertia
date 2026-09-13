// NONSHIPPING exact-5c9 diagnostic. These records never authorize cleanup.
import type { ChildProcess } from "node:child_process";
import { OWNED_PROCESS_PROBE_CLASSES, type RuntimeOwnedProcessProbe } from "./runtime-owned-process-diagnostic.js";

export const KIMI_GUARDIAN_DIAGNOSTIC_PREFIX = "[INERTIA_KIMI_GUARDIAN] ";
const cleanupReasons = new Set([
  "unknown", "freeze-initial-census", "freeze-stop-signal", "freeze-post-stop-census",
  "freeze-unstable-members", "term-signal", "term-census", "term-fork-taint",
  "kill-signal", "resume-direct-child", "resume-descendant", "drain-census",
  "drain-fork-taint", "drain-timeout", "forced-test-failure", "unavailable",
]);
const censusReasons = new Set([
  "none", "pid-buffer-allocation", "pid-list", "session-status-unreadable",
  "session-live-identity-unreadable", "tracked-status-unreadable",
  "tracked-live-identity-unreadable", "member-capacity", "owned-capacity", "unavailable",
]);
const signals = new Set(["none", "SIGUSR2", "SIGKILL", "SIGTERM", "SIGINT", "other"]);
const phases = new Set(["idle", "starting", "ready", "restarting", "stopping", "stopped"]);
export type KimiGuardianDiagnostic = Record<string, string | number | boolean | null>;
let sequence = 0;
const gitOperations = new WeakMap<ChildProcess, "apple-git-selection" | "other">();
export function noteKimiGuardianGitOperation(child: ChildProcess, appleGitSelection: boolean): void {
  gitOperations.set(child, appleGitSelection ? "apple-git-selection" : "other");
}
const finiteInteger = (value: unknown): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value >= 0;

export function guardianFailureReason(line: string): { cleanupReason: string; censusReason: string } | null {
  const match = /^\[Inertia guardian cleanup unproved: ([a-z-]+)\/([a-z-]+)\]$/u.exec(line.trim());
  return match && cleanupReasons.has(match[1]!) && censusReasons.has(match[2]!)
    ? { cleanupReason: match[1]!, censusReason: match[2]! } : null;
}

export function parseKimiGuardianDiagnostic(line: string): KimiGuardianDiagnostic | null {
  if (!line.startsWith(KIMI_GUARDIAN_DIAGNOSTIC_PREFIX) || line.length > 1_024) return null;
  let value: unknown;
  try { value = JSON.parse(line.slice(KIMI_GUARDIAN_DIAGNOSTIC_PREFIX.length)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!finiteInteger(record.at) || !finiteInteger(record.sequence) || !finiteInteger(record.elapsedMs)
    || !finiteInteger(record.observerPid)) return null;
  if (record.event === "guardian-close") {
    if (Object.keys(record).sort().join() !== "admissionSucceeded,at,authorizationObserved,censusReason,cleanupReason,elapsedMs,event,exitCode,observerPid,operation,probe,sequence,signal,stopRequested"
      || typeof record.cleanupReason !== "string" || !cleanupReasons.has(record.cleanupReason)
      || typeof record.censusReason !== "string" || !censusReasons.has(record.censusReason)
      || typeof record.signal !== "string" || !signals.has(record.signal)
      || !["apple-git-selection", "other"].includes(record.operation as string)
      || typeof record.stopRequested !== "boolean" || typeof record.admissionSucceeded !== "boolean"
      || typeof record.authorizationObserved !== "boolean"
      || ![...OWNED_PROCESS_PROBE_CLASSES, "unclassified"].includes(record.probe as RuntimeOwnedProcessProbe)
      || (record.exitCode !== null && (!finiteInteger(record.exitCode) || record.exitCode > 255))) return null;
  } else if (record.event === "runtime-state") {
    if (Object.keys(record).sort().join() !== "at,elapsedMs,event,generation,observerPid,phase,restartAttempt,sequence"
      || typeof record.phase !== "string" || !phases.has(record.phase) || !finiteInteger(record.generation)
      || !finiteInteger(record.restartAttempt)) return null;
  } else return null;
  return record as KimiGuardianDiagnostic;
}

export function consumeKimiGuardianDiagnostics(accept: (record: KimiGuardianDiagnostic) => void): (chunk: Buffer) => void {
  let pending = "";
  return (chunk) => {
    pending = (pending + chunk.subarray(-4_096).toString("utf8")).slice(-4_096);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const record = parseKimiGuardianDiagnostic(line);
      if (record) accept(record);
    }
  };
}

export function emitKimiGuardianDiagnostic(record: KimiGuardianDiagnostic): void {
  if (process.env.INERTIA_DIAG_KIMI_GUARDIAN !== "1") return;
  const line = KIMI_GUARDIAN_DIAGNOSTIC_PREFIX + JSON.stringify({ ...record,
    sequence: sequence++, elapsedMs: Math.floor(performance.now()), observerPid: process.pid,
  });
  if (parseKimiGuardianDiagnostic(line)) console.error(line);
}

export function observeKimiGuardianFailure(child: ChildProcess, probe: RuntimeOwnedProcessProbe | undefined,
  claim: { stopRequested: boolean; admissionSucceeded: boolean; authorizationObserved: boolean }): void {
  if (process.env.INERTIA_DIAG_KIMI_GUARDIAN !== "1") return;
  let pending = "";
  let reason = { cleanupReason: "unavailable", censusReason: "unavailable" };
  const onData = (chunk: Buffer): void => {
    pending = (pending + chunk.subarray(-4_096).toString("utf8")).slice(-4_096);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) reason = guardianFailureReason(line) ?? reason;
  };
  child.stderr?.on("data", onData);
  child.once("close", (code, signal) => {
    child.stderr?.off("data", onData);
    if (typeof code === "number" && signal === null) return;
    emitKimiGuardianDiagnostic({ event: "guardian-close", at: Date.now(), probe: probe ?? "unclassified",
      ...reason, signal: signal === null ? "none" : signals.has(signal) ? signal : "other", exitCode: code,
      operation: gitOperations.get(child) ?? "other",
      stopRequested: claim.stopRequested, admissionSucceeded: claim.admissionSucceeded,
      authorizationObserved: claim.authorizationObserved });
  });
}
