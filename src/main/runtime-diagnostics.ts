import type { RuntimeRestartRequestedEvent } from "../node/runtime-owned-process-diagnostic.js";
import { chmodSync, lstatSync, mkdirSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApplicationIncidentIndex } from "./application-incident-index.js";
import {
  diagnosticDefinition,
  diagnosticRecordSchema,
  type DiagnosticEventEntry,
  type DiagnosticIncident,
  type DiagnosticPage,
  type DiagnosticQuery,
} from "../shared/application-diagnostics.js";
import type { RuntimeSupervisorSnapshot } from "./runtime-supervisor.js";
import {
  DiagnosticJournalFiles,
  removeStalePruneFiles,
  type JournalWrite,
} from "./diagnostic-journal-files.js";
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  buildDiagnosticEntry,
  diagnosticRecordDetail,
  parseDiagnosticRecord,
  serializeDiagnosticRecord,
  type DiagnosticFields,
} from "./runtime-diagnostic-records.js";
import {
  ALWAYS_ON_DIAGNOSTIC_EVENTS,
  diagnosticEventEntry,
  type RuntimeDiagnosticEvent,
} from "./runtime-diagnostic-events.js";
import {
  renderSupportSummary,
  type RuntimeSupportReport,
  type RuntimeSupportReportInput,
} from "./runtime-support-summary.js";

export type { RuntimeDiagnosticEvent } from "./runtime-diagnostic-events.js";
export type { RuntimeSupportReport, RuntimeSupportReportInput } from "./runtime-support-summary.js";
export { sanitizeRuntimeDiagnosticText } from "./runtime-diagnostic-records.js";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 4;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const RECORD_PRUNE_INTERVAL_MS = 5 * 60 * 1_000;
const DIRECTORY_MODE = 0o700;

export interface DiagnosticCaptureState {
  enabled: boolean;
  since: string | null;
}

export interface RuntimeDiagnosticsOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  retentionMs?: number;
  now?: () => number;
  write?: JournalWrite;
  capture?: DiagnosticCaptureState;
}

export function runtimeDiagnosticsDirectory(userDataDirectory: string): string {
  return resolve(userDataDirectory, "logs", "runtime");
}

export class RuntimeDiagnostics {
  readonly directory: string;
  private readonly maxFileBytes: number;
  private readonly retentionMs: number;
  private readonly recordPruneIntervalMs: number;
  private lastRecordPruneAt: number | null = null;
  private readonly now: () => number;
  private readonly lifecycle: DiagnosticJournalFiles;
  private readonly incidentFiles: DiagnosticJournalFiles;
  private readonly incidents: ApplicationIncidentIndex;
  private capture: DiagnosticCaptureState;
  private stalePruneFilesRemoved = false;
  private eventCache: DiagnosticEventEntry[] | null = null;
  private lastDatabaseRecovery: string | null = null;

  constructor(directory: string, options: RuntimeDiagnosticsOptions = {}) {
    this.directory = resolve(directory);
    this.maxFileBytes = Math.max(256, Math.min(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 4 * 1024 * 1024));
    const maxFiles = Math.max(2, Math.min(Math.trunc(options.maxFiles ?? DEFAULT_MAX_FILES), 10));
    this.retentionMs = Math.max(1_000, Math.min(options.retentionMs ?? DEFAULT_RETENTION_MS, 30 * 24 * 60 * 60 * 1_000));
    this.recordPruneIntervalMs = Math.min(RECORD_PRUNE_INTERVAL_MS, this.retentionMs);
    this.now = options.now ?? Date.now;
    this.capture = options.capture ?? { enabled: true, since: null };
    const files = {
      directory: this.directory,
      maxFileBytes: this.maxFileBytes,
      maxFiles,
      retentionMs: this.retentionMs,
      now: this.now,
      write: options.write ?? ((descriptor: number, buffer: Buffer, offset: number, length: number) =>
        writeSync(descriptor, buffer, offset, length)),
    };
    this.lifecycle = new DiagnosticJournalFiles({ ...files, baseName: "runtime" });
    this.incidentFiles = new DiagnosticJournalFiles({ ...files, baseName: "incidents" });
    this.incidents = new ApplicationIncidentIndex({
      now: this.now, retentionMs: this.retentionMs,
      load: () => {
        this.ensureDirectory();
        return this.readRecords()
          .filter((record) => record.event === "application.incident")
          .map((record) => record.incident);
      },
      append: (incident) => {
        this.revalidateDirectory(false);
        const line = serializeDiagnosticRecord({
          schemaVersion: 2, event: "application.incident", at: incident.at, incident,
        });
        if (Buffer.byteLength(line) > this.maxFileBytes) throw new Error("Diagnostic record exceeds the journal bound.");
        this.incidentFiles.appendRecord(line);
      },
    });
  }

  captureState(): DiagnosticCaptureState {
    return { ...this.capture };
  }

  setCapture(enabled: boolean, persist: (state: DiagnosticCaptureState) => void = () => undefined): DiagnosticCaptureState {
    if (enabled === this.capture.enabled) return this.captureState();
    const next = { enabled, since: new Date(this.now()).toISOString() };
    persist(next);
    if (enabled) {
      this.capture = next;
      this.record("diagnostics.capture-started");
    } else {
      this.flushIncidents();
      this.record("diagnostics.capture-stopped");
      this.capture = next;
    }
    this.incidents.touch();
    return this.captureState();
  }

  clearHistory(): void {
    const parent = lstatSync(dirname(this.directory));
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("The runtime diagnostics path is not a local directory.");
    }
    this.revalidateDirectory(false);
    this.incidents.clear();
    this.lifecycle.clear();
    this.incidentFiles.clear();
    removeStalePruneFiles(this.directory);
    this.eventCache = null;
    this.record("diagnostics.history-cleared");
  }

  recordIncident(incident: DiagnosticIncident): ReturnType<ApplicationIncidentIndex["record"]> {
    if (!this.capture.enabled) return null;
    try { return this.incidents.record(incident); } catch { return null; }
  }

  query(query: DiagnosticQuery): DiagnosticPage {
    return { ...this.incidents.query(query, this.eventEntries()), ...this.pageCapture() };
  }

  queryIncidents(query: DiagnosticQuery): DiagnosticPage {
    return { ...this.incidents.query(query), ...this.pageCapture() };
  }

  exportDiagnostics(query: DiagnosticQuery): string { return this.incidents.export(query, this.eventEntries()); }
  exportIncidents(query: DiagnosticQuery): string { return this.incidents.export(query); }
  exportForReport(sinceMs: number, maxBytes: number): string {
    return this.incidents.exportWithin(
      { severity: "all", after: new Date(sinceMs).toISOString() },
      maxBytes,
      this.eventEntries().filter((entry) => entry.severity !== "info" || entry.event.startsWith("diagnostics.")),
    );
  }
  flushIncidents(): void { this.incidents.flush(); }
  onIncidentsChanged(notify: () => void): void { this.incidents.onChange(notify); }
  setIncidentRuntimeReady(ready: boolean, generationHash: string | null = null): void { this.incidents.setRuntime(ready, generationHash); }

  ensureDirectory(): string {
    return this.revalidateDirectory(true);
  }

  record(event: RuntimeDiagnosticEvent, fields: DiagnosticFields = {}): void {
    if (!this.capture.enabled && !ALWAYS_ON_DIAGNOSTIC_EVENTS.has(event)) return;
    try {
      if (event === "app.stop") this.flushIncidents();
      this.revalidateDirectory(false);
      const entry = buildDiagnosticEntry(event, fields, new Date(this.now()).toISOString());
      if (!entry) return;
      let line = serializeDiagnosticRecord(entry);
      if (Buffer.byteLength(line) > this.maxFileBytes) {
        delete entry.message;
        line = serializeDiagnosticRecord(entry);
      }
      if (Buffer.byteLength(line) > this.maxFileBytes) {
        line = serializeDiagnosticRecord({
          schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
          at: entry.at,
          event,
        });
      }
      this.lifecycle.appendRecord(line, event !== "runtime.state");
      this.eventCache = null;
      this.incidents.touch();
    } catch {
      return;
    }
  }

  recordRestartRequested(event: RuntimeRestartRequestedEvent, generation: number): void {
    this.record("runtime.restart-requested", { generation, reason: event.reason, ...event.diagnostic });
  }

  recordState(snapshot: RuntimeSupervisorSnapshot): void {
    this.record(snapshot.lastError ? "runtime.failure" : "runtime.state", {
      phase: snapshot.phase,
      generation: snapshot.generation,
      processId: snapshot.pid,
      restartAttempt: snapshot.restartAttempt,
      restartScheduled: snapshot.restartScheduled,
      message: snapshot.lastError,
      startupBlockerCode: snapshot.startupBlockerCode,
    });
    const recovery = snapshot.databaseRecovery;
    if (
      (recovery?.outcome === "restored" || recovery?.outcome === "created-empty")
      && recovery.checkedAt !== this.lastDatabaseRecovery
    ) {
      this.lastDatabaseRecovery = recovery.checkedAt;
      this.record("runtime.database-recovery", {
        outcome: recovery.outcome,
        trigger: recovery.trigger,
        preservedCorruptPrimary: recovery.preservedCorruptPrimary,
        preservedDatabaseFamilyMembers: recovery.preservedDatabaseFamilyMembers,
        invalidBackupsSkipped: recovery.invalidBackupsSkipped,
        unsupportedBackupsSkipped: recovery.unsupportedBackupsSkipped,
      });
    }
  }

  supportReport(input: RuntimeSupportReportInput): RuntimeSupportReport {
    this.ensureDirectory();
    const events = this.readRecords().map((value) => {
      if (value.event === "application.incident") {
        const incident = diagnosticRecordSchema.parse(value.incident);
        return `${incident.at} · ${incident.code} · ${diagnosticDefinition(incident.code).title} · ${incident.outcome}`;
      }
      const detail = diagnosticRecordDetail(value);
      return `${value.at as string} · ${value.event as string}${detail.length > 0 ? ` · ${detail.join(" · ")}` : ""}`;
    });
    return renderSupportSummary(input, events, this.now());
  }

  private pageCapture(): Pick<DiagnosticPage, "capture" | "since"> {
    return { capture: this.capture.enabled, since: this.capture.since };
  }

  private eventEntries(): DiagnosticEventEntry[] {
    try {
      this.revalidateDirectory(false);
      this.eventCache ??= this.lifecycle.readLines().flatMap((line) => {
        const record = this.parseLine(line);
        return record && record.event !== "application.incident"
          ? [diagnosticEventEntry(record, diagnosticRecordDetail(record))]
          : [];
      });
      const cutoff = this.now() - this.retentionMs;
      return this.eventCache.filter((entry) => Date.parse(entry.at) >= cutoff);
    } catch {
      return [];
    }
  }

  private parseLine(line: string): Record<string, unknown> | null {
    try { return parseDiagnosticRecord(JSON.parse(line)); } catch { return null; }
  }

  private readRecords(): Record<string, unknown>[] {
    return [...this.lifecycle.readLines(), ...this.incidentFiles.readLines()]
      .flatMap((line) => {
        const record = this.parseLine(line);
        return record ? [record] : [];
      })
      .map((record, index) => ({ record, index, at: Date.parse(record.at as string) }))
      .sort((left, right) => left.at - right.at || left.index - right.index)
      .map(({ record }) => record);
  }

  private revalidateDirectory(forceRecordPrune: boolean): string {
    mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("The runtime diagnostics path is not a local directory.");
    }
    chmodSync(this.directory, DIRECTORY_MODE);
    if (!this.stalePruneFilesRemoved) {
      removeStalePruneFiles(this.directory);
      this.stalePruneFilesRemoved = true;
    }
    this.pruneExpired(forceRecordPrune);
    return this.directory;
  }

  private pruneExpired(forceRecordPrune: boolean): void {
    const now = this.now();
    const cutoff = now - this.retentionMs;
    const pruneRecords = forceRecordPrune
      || this.lastRecordPruneAt === null
      || Math.abs(now - this.lastRecordPruneAt) >= this.recordPruneIntervalMs;
    if (pruneRecords) {
      this.lastRecordPruneAt = now;
      this.eventCache = null;
    }
    this.lifecycle.prune(cutoff, pruneRecords);
    this.incidentFiles.prune(cutoff, pruneRecords);
  }
}
