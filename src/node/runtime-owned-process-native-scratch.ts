// Scratch CI only: observe the native guardian's existing stderr marker inside
// the explicitly enabled synthetic Kimi home. Never use this as cleanup proof.
import type { ChildProcess } from "node:child_process";
import { appendFileSync, lstatSync } from "node:fs";
import { basename, join } from "node:path";

const phases = new Set([
  "unknown", "freeze-initial-census", "freeze-stop-signal",
  "freeze-post-stop-census", "freeze-unstable-members", "term-signal",
  "term-census", "term-fork-taint", "kill-signal", "resume-direct-child",
  "resume-descendant", "drain-census", "drain-fork-taint", "drain-timeout",
  "forced-test-failure",
]);
const censusReasons = new Set([
  "none", "pid-buffer-allocation", "pid-list", "session-status-unreadable",
  "session-live-identity-unreadable", "tracked-status-unreadable",
  "tracked-live-identity-unreadable", "member-capacity", "owned-capacity",
]);
const signals = new Set(["SIGUSR2", "SIGKILL", "SIGTERM", "SIGINT"]);
const providerCommands = new Set(["kimi", "codex", "claude", "opencode", "gemini", "cursor-agent", "amp"]);
const scratchFile = ".inertia-native-phase-scratch.jsonl";
const observerReasons = new Set(["none", "note-fork", "event-error", "syscall-error", "retry-budget"]);
const stopTriggers = new WeakMap<object, { reason: "timeout" | "abort"; at: number }>();

export function recordNativePreparationScratch(outcome: "start" | "path" | "resolved" | "cleanup-unconfirmed" | "timeout" | "unavailable" | "failed"): void {
  const home = process.env.HOME;
  if (process.platform !== "darwin" || process.env.NODE_ENV !== "test" || !home || basename(home) !== "provider-home") return;
  try {
    const path = join(home, scratchFile);
    const stat = lstatSync(path);
    const line = JSON.stringify({ event: "git-executable-prepare", at: Date.now(), outcome }) + "\n";
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size + Buffer.byteLength(line) > 16_384) return;
    appendFileSync(path, line);
  } catch { /* Synthetic observation does not change startup behavior. */ }
}

export function recordNativePhaseStopScratch(child: ChildProcess, reason: "timeout" | "abort"): void {
  if (!stopTriggers.has(child)) stopTriggers.set(child, { reason, at: Date.now() });
}

export function observeNativePhaseScratch(child: Pick<ChildProcess, "stderr" | "spawnargs" | "stdout">):
  (code: number | null, signal: NodeJS.Signals | null, stopRequested: boolean) => void {
  const ignored = (): void => undefined;
  const home = process.env.HOME;
  if (process.platform !== "darwin" || process.env.NODE_ENV !== "test"
    || !home || basename(home) !== "provider-home") return ignored;
  const path = join(home, scratchFile);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 16_384) return ignored;
  } catch { return ignored; }
  const command = basename(child.spawnargs[4] ?? "");
  const kind = command === "git" ? "git" : command === "xcrun" ? "tool-lookup"
    : providerCommands.has(command)
      || (command === "node" && ["app-server", "login"].includes(child.spawnargs[5] ?? ""))
      ? "provider" : "other";
  const args = child.spawnargs.slice(5);
  const gitOperation = kind !== "git" ? null
    : args.includes("rev-parse") ? args.includes("--show-toplevel") ? "rev-parse-toplevel"
      : args.includes("--git-common-dir") ? "rev-parse-common" : "rev-parse-other"
      : ["status", "diff", "config", "ls-files", "log", "for-each-ref"].find(value => args.includes(value)) ?? "other";
  const startedAt = Date.now();
  let stdoutBytes = 0;
  let firstOutputAt: number | null = null;
  let lastOutputAt: number | null = null;
  const observeOutput = (chunk: Buffer | string): void => {
    firstOutputAt ??= Date.now();
    lastOutputAt = Date.now();
    stdoutBytes = Math.min(262_144, stdoutBytes + chunk.length);
  };
  child.stdout?.on("data", observeOutput);
  let tail = "";
  let failure: { phase: string; census: string } | null = null;
  let observer: string | null = null;
  const observe = (chunk: Buffer | string): void => {
    // Preserve split markers with bounded scratch memory. No raw text is saved.
    if (failure && observer || chunk.length > 65_536) { tail = ""; return; }
    const text = tail + String(chunk);
    for (const match of text.matchAll(
      /\[Inertia guardian cleanup unproved: ([a-z-]{1,48})\/([a-z-]{1,48})\]/gu,
    )) {
      const phase = match[1]!;
      const census = match[2]!;
      if (!failure && phases.has(phase) && censusReasons.has(census)) {
        failure = { phase, census };
        break;
      }
    }
    for (const match of text.matchAll(/\[Inertia guardian observer taint: ([a-z-]{1,48})\]/gu)) {
      if (!observer && observerReasons.has(match[1]!)) observer = match[1]!;
    }
    tail = failure && observer ? "" : text.slice(-256);
  };
  child.stderr?.on("data", observe);
  return (code, signal, stopRequested) => {
    child.stderr?.off("data", observe);
    child.stdout?.off("data", observeOutput);
    tail = "";
    try {
      const line = JSON.stringify({
        event: "guardian-close", at: Date.now(), elapsedMs: Date.now() - startedAt,
        kind, gitOperation, stopRequested, stopTrigger: stopTriggers.get(child) ?? null,
        stdoutBytes, firstOutputAt, lastOutputAt,
        signal: signal === null ? "none" : signals.has(signal) ? signal : "other",
        code: Number.isInteger(code) && code! >= 0 && code! <= 255 ? code : null,
        failure, observer,
      }) + "\n";
      if (lstatSync(path).size + Buffer.byteLength(line) > 16_384) return;
      appendFileSync(path, line);
    } catch { /* Scratch observation never changes cleanup or error handling. */ }
  };
}
