// Temporary Intel CI capture. No filesystem work occurs until startup rejects.
import { appendFileSync, existsSync, lstatSync } from "node:fs";
import { basename, join } from "node:path";
import {
  parseRuntimeOwnedProcessDiagnostic,
  type RuntimeOwnedProcessDiagnostic,
} from "../node/runtime-owned-process-diagnostic";
import { isGitProcessTreeTerminationFailure } from "./git/types";

export const startupFailureScratch = {
  stage: "preflight",
  startedAt: 0,
  lookupStartedAt: 0,
  lookupElapsedMs: null as number | null,
  taint: null as RuntimeOwnedProcessDiagnostic | null,
  startRuntimeResolved: false,
  stoppingOnResolution: false,
  restartReasonOnResolution: null as string | null,
};

let lookupFailure: {
  error: unknown;
  stderr: readonly Buffer[];
  stdoutBytes: number;
  terminalCode: string | null;
  signal: NodeJS.Signals | null;
  exitCode: number | null;
} | null = null;

// Called only after the original lookup Promise has been rejected. The existing
// bounded stderr buffers remain process-local and are parsed only after failure.
export function rememberRejectedLookupScratch(value: NonNullable<typeof lookupFailure>): void {
  lookupFailure ??= value;
  startupFailureScratch.lookupElapsedMs = Date.now() - startupFailureScratch.lookupStartedAt;
}

const names = new Set(["Error", "GitError", "TypeError", "RangeError", "SyntaxError", "SqliteError", "RuntimeStartupBlockerError"]);
const codes = new Set(["invalid-input", "not-repository", "not-found", "conflict", "nothing-to-commit", "authentication", "output-limit", "timeout", "git-unavailable", "operation-failed", "ENOENT", "EACCES", "EPERM", "EIO", "EMFILE", "ENFILE", "EEXIST", "ENOTDIR", "EADDRINUSE", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_ERROR", "SQLITE_CORRUPT", "SQLITE_CANTOPEN"]);
const phases = new Set(["unknown", "freeze-initial-census", "freeze-stop-signal", "freeze-post-stop-census", "freeze-unstable-members", "term-signal", "term-census", "term-fork-taint", "kill-signal", "resume-direct-child", "resume-descendant", "drain-census", "drain-fork-taint", "drain-timeout", "forced-test-failure"]);
const censusReasons = new Set(["none", "pid-buffer-allocation", "pid-list", "session-status-unreadable", "session-live-identity-unreadable", "tracked-status-unreadable", "tracked-live-identity-unreadable", "member-capacity", "owned-capacity"]);
const signals = new Set(["SIGUSR2", "SIGKILL", "SIGTERM", "SIGINT"]);
const stages = new Set(["preflight", "startup-recovery", "git-prewarm", "generated-attachments", "persistence", "backend-setup", "backend-initialize", "services-and-listen"]);
const restartReasons = new Set(["owned-process-tainted", "owned-process-cleanup-unconfirmed"]);

function category(error: unknown): { name: string | null; code: string | null } {
  const value = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : null;
  return {
    name: typeof value?.name === "string" && names.has(value.name) ? value.name : error === undefined ? null : "other",
    code: typeof value?.code === "string" && codes.has(value.code) ? value.code : null,
  };
}

export function writeRejectedStartupScratch(error: unknown, stopping: boolean, restartReason: string | null): void {
  const home = process.env.HOME;
  if (process.platform !== "darwin" || process.env.NODE_ENV !== "test"
    || !home || basename(home) !== "provider-home") return;
  try {
    let guardianMarker: { phase: string; census: string } | null = null;
    if (lookupFailure) {
      const stderr = Buffer.concat(lookupFailure.stderr).subarray(0, 16_384).toString("utf8");
      for (const match of stderr.matchAll(/\[Inertia guardian cleanup unproved: ([a-z-]{1,48})\/([a-z-]{1,48})\]/gu)) {
        if (phases.has(match[1]!) && censusReasons.has(match[2]!)) {
          guardianMarker = { phase: match[1]!, census: match[2]! };
          break;
        }
      }
    }
    const line = JSON.stringify({
      event: "startup-chain-caught", at: Date.now(),
      startRuntimeResolved: startupFailureScratch.startRuntimeResolved,
      stoppingOnResolution: startupFailureScratch.stoppingOnResolution,
      restartReasonOnResolution: restartReasons.has(startupFailureScratch.restartReasonOnResolution ?? "") ? startupFailureScratch.restartReasonOnResolution : null,
      stoppingOnCatch: stopping,
      restartReasonOnCatch: restartReasons.has(restartReason ?? "") ? restartReason : null,
      elapsedMs: startupFailureScratch.startedAt ? Date.now() - startupFailureScratch.startedAt : null,
      stage: stages.has(startupFailureScratch.stage) ? startupFailureScratch.stage : "other",
      error: category(error),
      isGitTreeFailure: isGitProcessTreeTerminationFailure(error),
      lookupElapsedMs: startupFailureScratch.lookupElapsedMs,
      taint: parseRuntimeOwnedProcessDiagnostic(startupFailureScratch.taint),
      lookupFailure: lookupFailure ? {
        error: category(lookupFailure.error),
        sameStartupError: lookupFailure.error === error,
        terminalCode: lookupFailure.terminalCode && codes.has(lookupFailure.terminalCode) ? lookupFailure.terminalCode : null,
        stdoutBytes: Math.min(4_096, lookupFailure.stdoutBytes),
        signal: lookupFailure.signal === null ? "none" : signals.has(lookupFailure.signal) ? lookupFailure.signal : "other",
        exitCode: Number.isInteger(lookupFailure.exitCode) && lookupFailure.exitCode! >= 0 && lookupFailure.exitCode! <= 255 ? lookupFailure.exitCode : null,
        guardianMarker,
      } : null,
    }) + "\n";
    const path = join(home, ".inertia-startup-postfailure.jsonl");
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size + Buffer.byteLength(line) > 16_384) return;
    }
    appendFileSync(path, line, { mode: 0o600 });
  } catch { /* Capture failure cannot replace the original startup rejection. */ }
}
