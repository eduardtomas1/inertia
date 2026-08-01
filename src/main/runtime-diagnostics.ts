import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { RuntimeSupervisorSnapshot } from "./runtime-supervisor.js";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 4;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOG_FILE_PATTERN = /^runtime(?:\.\d+)?\.log$/u;

export type RuntimeDiagnosticEvent =
  | "app.start"
  | "app.stop"
  | "logs.reveal"
  | "report.copy"
  | "runtime.failure"
  | "runtime.state";

export interface RuntimeDiagnosticsOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  retentionMs?: number;
  now?: () => number;
}

export interface RuntimeSupportReportInput {
  version: string;
  platform: string;
  architecture: string;
  runtime: RuntimeSupervisorSnapshot | null;
}

export interface RuntimeSupportReport {
  text: string;
  eventCount: number;
}

type DiagnosticFields = Readonly<Record<string, unknown>>;

export function runtimeDiagnosticsDirectory(userDataDirectory: string): string {
  return resolve(userDataDirectory, "logs", "runtime");
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

/**
 * Failure text is intentionally lossy. Runtime diagnostics are for lifecycle
 * triage, not provider transcripts, and must never become a second content log.
 */
export function sanitizeRuntimeDiagnosticText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  text = text
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "<redacted>")
    .replace(/\b(Bearer|Basic)\s+\S+/giu, "$1 <redacted>")
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/)(?:[^/\s@]+)@/giu, (match) => {
      const separator = match.indexOf("://");
      return `${match.slice(0, separator + 3)}<redacted>@`;
    })
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, "<redacted-email>")
    .replace(/\b(api[_ -]?key|authorization|cookie|credential|password|prompt|secret|source|tokens?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=<redacted>")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "<path>")
    .replace(/\/(?:Users|home|private|tmp|var|opt|run)(?:\/[^\s,;:]+)+/gu, "<path>");
  return text.slice(0, 400);
}

function runtimeFailureSummary(value: unknown): string | undefined {
  const text = sanitizeRuntimeDiagnosticText(value);
  if (!text) return undefined;
  if (/did not become ready|startup.*timed out|start.*timed out/iu.test(text)) return "Runtime startup timed out.";
  if (/invalid lifecycle (?:command|message)/iu.test(text)) return "Runtime lifecycle validation failed.";
  if (/could not be created|spawn/iu.test(text)) return "Runtime process could not be created.";
  if (/shutdown deadline|forced termination/iu.test(text)) return "Runtime shutdown exceeded its deadline.";
  const exitCode = text.match(/exited unexpectedly \(code (-?\d+)\)/iu)?.[1];
  if (exitCode) return `Runtime process exited unexpectedly (code ${exitCode}).`;
  if (/encountered/iu.test(text)) return "Runtime process reported an operating-system error.";
  return "Runtime lifecycle failure detail omitted.";
}

export class RuntimeDiagnostics {
  readonly directory: string;
  private readonly activePath: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(directory: string, options: RuntimeDiagnosticsOptions = {}) {
    this.directory = resolve(directory);
    this.activePath = join(this.directory, "runtime.log");
    this.maxFileBytes = Math.max(256, Math.min(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 4 * 1024 * 1024));
    this.maxFiles = Math.max(2, Math.min(Math.trunc(options.maxFiles ?? DEFAULT_MAX_FILES), 10));
    this.retentionMs = Math.max(1_000, Math.min(options.retentionMs ?? DEFAULT_RETENTION_MS, 30 * 24 * 60 * 60 * 1_000));
    this.now = options.now ?? Date.now;
  }

  ensureDirectory(): string {
    mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("The runtime diagnostics path is not a local directory.");
    }
    chmodSync(this.directory, DIRECTORY_MODE);
    this.pruneExpired();
    return this.directory;
  }

  record(event: RuntimeDiagnosticEvent, fields: DiagnosticFields = {}): void {
    try {
      this.ensureDirectory();
      const entry: Record<string, string | number | boolean> = {
        at: new Date(this.now()).toISOString(),
        event,
      };
      const phase = typeof fields.phase === "string" && /^(?:idle|starting|ready|restarting|stopping|stopped)$/u.test(fields.phase)
        ? fields.phase
        : undefined;
      const generation = boundedInteger(fields.generation, 0, Number.MAX_SAFE_INTEGER);
      const processId = boundedInteger(fields.processId, 1, 2_147_483_647);
      const restartAttempt = boundedInteger(fields.restartAttempt, 0, 1_000_000);
      const message = event === "runtime.failure"
        ? runtimeFailureSummary(fields.message)
        : sanitizeRuntimeDiagnosticText(fields.message);
      if (phase) entry.phase = phase;
      if (generation !== undefined) entry.generation = generation;
      if (processId !== undefined) entry.processId = processId;
      if (restartAttempt !== undefined) entry.restartAttempt = restartAttempt;
      if (typeof fields.restartScheduled === "boolean") entry.restartScheduled = fields.restartScheduled;
      if (message) entry.message = message;

      let line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line) > this.maxFileBytes) {
        delete entry.message;
        line = `${JSON.stringify(entry)}\n`;
      }
      if (Buffer.byteLength(line) > this.maxFileBytes) {
        line = `${JSON.stringify({ at: entry.at, event })}\n`;
      }
      this.rotateIfNeeded(Buffer.byteLength(line));
      this.append(line);
    } catch {
      // Diagnostics are best effort and must never affect application startup.
    }
  }

  recordState(snapshot: RuntimeSupervisorSnapshot): void {
    const recovery = snapshot.databaseRecovery;
    const recoveryMessage = recovery?.outcome === "restored"
      ? `Database restored from validated backup ${recovery.restoredBackup ?? "unknown"}; corrupt primary preserved: ${recovery.preservedCorruptPrimary ? "yes" : "no"}; invalid backups skipped: ${recovery.invalidBackupsSkipped}.`
      : recovery?.outcome === "created-empty"
        ? `Database started empty after ${recovery.trigger}; corrupt primary preserved: ${recovery.preservedCorruptPrimary ? "yes" : "no"}; invalid backups skipped: ${recovery.invalidBackupsSkipped}.`
        : undefined;
    this.record(snapshot.lastError ? "runtime.failure" : "runtime.state", {
      phase: snapshot.phase,
      generation: snapshot.generation,
      processId: snapshot.pid,
      restartAttempt: snapshot.restartAttempt,
      restartScheduled: snapshot.restartScheduled,
      message: snapshot.lastError ?? recoveryMessage,
      // websocketUrl is deliberately excluded because it contains a capability.
    });
  }

  supportReport(input: RuntimeSupportReportInput): RuntimeSupportReport {
    this.ensureDirectory();
    const events = this.readEvents().slice(-120);
    const runtime = input.runtime;
    const preface = [
      "Inertia support summary",
      `Generated: ${new Date(this.now()).toISOString()}`,
      `Version: ${sanitizeRuntimeDiagnosticText(input.version) ?? "unknown"}`,
      `Platform: ${sanitizeRuntimeDiagnosticText(input.platform) ?? "unknown"}`,
      `Architecture: ${sanitizeRuntimeDiagnosticText(input.architecture) ?? "unknown"}`,
      `Runtime: ${runtime?.phase ?? "unavailable"}`,
      `Runtime generation: ${runtime?.generation ?? 0}`,
      `Restart attempt: ${runtime?.restartAttempt ?? 0}`,
      `Restart scheduled: ${runtime?.restartScheduled === true ? "yes" : "no"}`,
      "",
    ];
    const footer = [
      "Privacy: prompts, source, project paths, token values, credentials, connection capabilities, and provider output are excluded.",
    ];
    const render = (selected: string[]): string => [
      ...preface,
      selected.length === events.length
        ? `Recent lifecycle events (${selected.length}):`
        : `Recent lifecycle events (${selected.length} of ${events.length} copied):`,
      ...(selected.length > 0 ? selected : ["No lifecycle events recorded."]),
      "",
      ...footer,
    ].join("\n");
    let selected: string[] = [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = [events[index]!, ...selected];
      if (Buffer.byteLength(render(candidate), "utf8") > 64 * 1_024) break;
      selected = candidate;
    }
    return {
      text: render(selected),
      eventCount: selected.length,
    };
  }

  private readEvents(): string[] {
    const names = readdirSync(this.directory)
      .filter((name) => LOG_FILE_PATTERN.test(name))
      .sort((left, right) => {
        if (left === "runtime.log") return 1;
        if (right === "runtime.log") return -1;
        const leftIndex = Number(left.match(/\.(\d+)\./u)?.[1] ?? 0);
        const rightIndex = Number(right.match(/\.(\d+)\./u)?.[1] ?? 0);
        return rightIndex - leftIndex;
      });
    const events: string[] = [];
    for (const name of names) {
      let content: string;
      try {
        const path = join(this.directory, name);
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        content = readFileSync(path, "utf8").slice(0, this.maxFileBytes);
      } catch {
        // Rotation can race a support-summary read. Skip the disappeared file.
        continue;
      }
      for (const line of content.split(/\r?\n/u)) {
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          const event = typeof value.event === "string"
            && [
              "app.start",
              "app.stop",
              "logs.reveal",
              "report.copy",
              "runtime.failure",
              "runtime.state",
            ].includes(value.event)
              ? value.event
              : null;
          const at = typeof value.at === "string"
            && Number.isFinite(Date.parse(value.at))
              ? new Date(value.at).toISOString()
              : null;
          if (!event || !at) continue;
          const fields = [
            typeof value.phase === "string" ? `phase=${value.phase}` : null,
            boundedInteger(value.generation, 0, Number.MAX_SAFE_INTEGER) !== undefined
              ? `generation=${value.generation}`
              : null,
            boundedInteger(value.restartAttempt, 0, 1_000_000) !== undefined
              ? `restart=${value.restartAttempt}`
              : null,
            typeof value.restartScheduled === "boolean"
              ? `scheduled=${value.restartScheduled ? "yes" : "no"}`
              : null,
            sanitizeRuntimeDiagnosticText(value.message),
          ].filter((field): field is string => Boolean(field));
          events.push(`${at} · ${event}${fields.length > 0 ? ` · ${fields.join(" · ")}` : ""}`);
        } catch {
          // A malformed diagnostic line is ignored rather than copied.
        }
      }
    }
    return events;
  }

  private append(line: string): void {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const descriptor = openSync(
      this.activePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
      FILE_MODE,
    );
    try {
      fchmodSync(descriptor, FILE_MODE);
      writeSync(descriptor, line, undefined, "utf8");
    } finally {
      closeSync(descriptor);
    }
  }

  private rotatedPath(index: number): string {
    return join(this.directory, `runtime.${index}.log`);
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (!existsSync(this.activePath)) return;
    const current = lstatSync(this.activePath);
    if (current.isSymbolicLink() || !current.isFile()) {
      unlinkSync(this.activePath);
      return;
    }
    if (current.size + incomingBytes <= this.maxFileBytes) return;
    this.rotateActive();
  }

  private rotateActive(): void {
    const last = this.rotatedPath(this.maxFiles - 1);
    if (existsSync(last)) unlinkSync(last);
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      const source = this.rotatedPath(index);
      if (!existsSync(source)) continue;
      const target = this.rotatedPath(index + 1);
      if (existsSync(target)) unlinkSync(target);
      renameSync(source, target);
      chmodSync(target, FILE_MODE);
    }
    if (existsSync(this.activePath)) {
      renameSync(this.activePath, this.rotatedPath(1));
      chmodSync(this.rotatedPath(1), FILE_MODE);
    }
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const name of readdirSync(this.directory)) {
      if (!LOG_FILE_PATTERN.test(name)) continue;
      const path = join(this.directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.mtimeMs < cutoff) unlinkSync(path);
    }
  }
}
