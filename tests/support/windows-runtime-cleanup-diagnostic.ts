// Scratch diagnostic instrumentation; never shipped in the application.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { vi } from "vitest";
import { TerminalManager } from "../../src/server/terminal";

type Session = { pty: { pid: number }; outputObserved: boolean; exitObserved: boolean; exitCode: number | null; exitSignal: number | null; terminationRequested: boolean; closing: unknown };
type Manager = { sessions: Map<string, Session>; createProcessReplacing: (...args: unknown[]) => string };
let active: { root: string; output: string; marker: string; originalMarker: string | undefined; sessions: Session[]; stages: unknown[] } | null = null;
const positivePid = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff;
function sessions(): unknown[] {
  return active?.sessions.map((session) => ({ pid: session.pty.pid, outputObserved: session.outputObserved,
    exitObserved: session.exitObserved, exitCode: session.exitCode, exitSignal: session.exitSignal,
    terminationRequested: session.terminationRequested, closing: session.closing !== null })) ?? [];
}
export function prepareWindowsRuntimeCleanupDiagnostic(root: string): void {
  if (process.platform !== "win32" || process.env.INERTIA_WINDOWS_RUNTIME_CLEANUP_DIAGNOSTIC !== "1") return;
  const attempt = process.env.INERTIA_DIAGNOSTIC_ATTEMPT;
  if (!/^[1-5]$/.test(attempt ?? "") || !process.env.RUNNER_TEMP) throw new Error("Invalid diagnostic scope");
  root = realpathSync(root);
  if (dirname(root).toLowerCase() !== realpathSync(process.env.RUNNER_TEMP).toLowerCase()
    || !/^inertia-runtime-[A-Za-z0-9]+$/.test(basename(root))) throw new Error("Invalid diagnostic fixture root");
  const output = resolve("diagnostic-results", `attempt-${attempt}`);
  mkdirSync(output, { recursive: true });
  const marker = join(output, "preview-pids.jsonl");
  active = { root, output, marker, originalMarker: process.env.INERTIA_DIAGNOSTIC_PREVIEW_FILE, sessions: [], stages: [] };
  process.env.INERTIA_DIAGNOSTIC_PREVIEW_FILE = marker;
  const prototype = TerminalManager.prototype as unknown as Manager;
  const original = prototype.createProcessReplacing;
  vi.spyOn(prototype, "createProcessReplacing").mockImplementation(function (this: Manager, ...args: unknown[]) {
    const id = original.apply(this, args);
    const session = this.sessions.get(id);
    if (session && active && active.sessions.length < 32 && !active.sessions.includes(session)) active.sessions.push(session);
    return id;
  });
}
export function markWindowsRuntimeCleanupDiagnostic(stage: "before-first-stop" | "before-rerun-stop"): void {
  if (active) active.stages.push({ stage, at: Date.now(), sessions: sessions() });
}
export function restoreWindowsRuntimeCleanupDiagnostic(): void {
  if (!active) return;
  if (active.originalMarker === undefined) delete process.env.INERTIA_DIAGNOSTIC_PREVIEW_FILE;
  else process.env.INERTIA_DIAGNOSTIC_PREVIEW_FILE = active.originalMarker;
  active = null;
}
export function captureWindowsRuntimeCleanupFailure(directories: string[], error: unknown, runtimesClosed: boolean): void {
  if (!active || !directories.includes(active.root)) return;
  try {
    let previews: Array<{ pid: number; ppid: number; at: number; uptimeMs: number }> = [];
    try {
      const stat = lstatSync(active.marker);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192) {
        previews = readFileSync(active.marker, "utf8").split("\n").filter(Boolean).slice(0, 32).flatMap((line) => {
          const value = JSON.parse(line) as Record<string, unknown>;
          return positivePid(value.pid) && positivePid(value.ppid) && Number.isSafeInteger(value.at)
            && Number.isSafeInteger(value.uptimeMs) && Number(value.uptimeMs) >= 0
            ? [{ pid: value.pid, ppid: value.ppid, at: Number(value.at), uptimeMs: Number(value.uptimeMs) }] : [];
        });
      }
    } catch { /* Missing marker means the preview may not have started. */ }
    const pids = [...new Set([...active.sessions.map((session) => session.pty.pid), ...previews.flatMap((item) => [item.pid, item.ppid])])].filter(positivePid).slice(0, 64);
    let native: unknown = { failure: "helper-unavailable" };
    try {
      const output = execFileSync(resolve("diagnostic-results/tools/cleanup-snapshot.exe"),
        [String(process.pid), active.root, pids.join(",")], { shell: false, encoding: "utf8", timeout: 2_000, maxBuffer: 65_536, windowsHide: true });
      // The fixed native producer emits metadata only and has no application input channel.
      native = JSON.parse(output);
    } catch { native = { failure: "helper-failed-or-deadline" }; }
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    writeFileSync(join(active.output, "cleanup-failure.json"), JSON.stringify({ schema: 1, workerPid: process.pid,
      at: Date.now(), runtimesClosed, errorCode: ["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(code)) ? code : "other",
      stages: active.stages, afterCloseSessions: sessions(), previews, native,
      limits: { processTable: 4096, selectedProcesses: 256, previewRecords: 32, nativeDeadlineMs: 2000 },
      identityLimit: "Kernel creation times are sampled only after failure; pre-stop PTY IDs and descendant links are diagnostic hints, not cleanup authority.",
    }, null, 2));
    console.log("INERTIA_WINDOWS_RUNTIME_CLEANUP_FAILURE_CAPTURED");
  } catch { console.log("INERTIA_WINDOWS_RUNTIME_CLEANUP_DIAGNOSTIC_FAILED"); }
}
