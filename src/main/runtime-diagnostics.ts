import { parseRuntimeOwnedProcessDiagnostic, type RuntimeRestartRequestedEvent } from "../node/runtime-owned-process-diagnostic.js";
import { parseRuntimeFailureDiagnosticMessage } from "../node/runtime-failure-diagnostic.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import { ApplicationIncidentIndex } from "./application-incident-index.js";
import {
  diagnosticDefinition,
  diagnosticRecordSchema,
  type DiagnosticIncident,
  type DiagnosticPage,
  type DiagnosticQuery,
} from "../shared/application-diagnostics.js";

import { FILE_OPEN_NO_FOLLOW } from
  "../node/platform-file-open-flags.js";
import type { RuntimeSupervisorSnapshot } from "./runtime-supervisor.js";
import type { RuntimeLifecycleDiagnosticSnapshot } from
  "../shared/lifecycle-diagnostics.js";
import type { AppUpdateHandoffDiagnostic } from "./app-update-handoff.js";
import {
  isAppUpdatePreparationDiagnostic,
  type AppUpdatePreparationDiagnostic,
} from
  "../shared/app-update-preparation-diagnostic.js";
import { lifecycleActionableStateWithUpdate } from
  "../shared/app-update-preparation-diagnostic.js";
import {
  lifecycleBuildMetadataSchema,
  type LifecycleBuildMetadata,
} from
  "../shared/lifecycle-build-metadata.js";
import { isRuntimeStartupBlockerCode } from
  "../shared/runtime-startup-diagnostics.js";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 4;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOG_FILE_PATTERN = /^runtime(?:\.\d+)?\.log$/u;
const DIAGNOSTIC_SCHEMA_VERSION = 1;
const DIAGNOSTIC_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const DIAGNOSTIC_PHASE_PATTERN =
  /^(?:idle|starting|ready|restarting|stopping|stopped)$/u;
const DETACHED_DRAFT_REASONS = [
  "changed",
  "invalid-json",
  "invalid-schema",
  "missing",
  "permission",
  "too-large",
  "transient-io",
  "unsafe",
] as const;
const DETACHED_DRAFT_OUTCOMES = [
  "blocked",
  "quarantined",
  "recovered",
] as const;

export type RuntimeDiagnosticEvent =
  | "app.start"
  | "app.stop"
  | "detached-draft.recovery"
  | "logs.reveal"
  | "report.copy"
  | "runtime.failure"
  | "runtime.restart-requested"
  | "runtime.state";

export interface RuntimeDiagnosticsOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  retentionMs?: number;
  now?: () => number;
  write?: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => number;
}

export interface RuntimeSupportReportInput {
  version: string;
  channel?: "stable" | "canary";
  platform: string;
  architecture: string;
  runtime: RuntimeSupervisorSnapshot | null;
  lifecycle?: RuntimeLifecycleDiagnosticSnapshot | null;
  updateHandoff?: AppUpdateHandoffDiagnostic | null;
  updatePreparation?: AppUpdatePreparationDiagnostic | null;
  buildMetadata?: LifecycleBuildMetadata | null;
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
    .replace(/(?<![:/])\/(?:[^/\s,;:]+\/)+[^/\s,;:]+/gu, "<path>");
  return text.slice(0, 400);
}

function runtimeFailureSummary(value: unknown): string | undefined {
  if (parseRuntimeFailureDiagnosticMessage(value)) return value as string;
  const text = sanitizeRuntimeDiagnosticText(value);
  if (!text) return undefined;
  const exactSummaries = [
    "The runtime generation ownership lease could not be persisted.",
    "The unstarted runtime generation lease could not be retired.",
    "The confirmed runtime cleanup receipt could not be persisted.",
    "The runtime cleanup receipt could not be consumed safely.",
    "The runtime could not confirm complete process cleanup.",
    "The runtime restarted because owned process containment could not be confirmed.",
    "The runtime restarted because owned process cleanup could not be confirmed.",
    "Runtime shutdown failed while closing local resources.",
    "Runtime shutdown exceeded its deadline while closing local resources.",
    "Runtime shutdown could not confirm owned-process cleanup.",
    "Runtime shutdown could not confirm cleanup after incomplete startup.",
    "Conversation attachment storage shutdown could not be confirmed.",
  ];
  if (exactSummaries.includes(text)) return text;
  const fixedPrefixSummaries = [
    "The runtime process tree could not be confirmed stopped.",
    "The runtime exited before complete process-tree cleanup was confirmed.",
    "The runtime process tree was stopped, but prior detached work could not be confirmed cleaned up.",
    "A prior runtime generation still has unconfirmed process cleanup.",
  ];
  const fixedPrefix = fixedPrefixSummaries.find((summary) =>
    text.startsWith(summary));
  if (fixedPrefix) return fixedPrefix;
  if (/did not become ready|startup.*timed out|start.*timed out/iu.test(text)) return "Runtime startup timed out.";
  if (/invalid lifecycle (?:command|message)/iu.test(text)) return "Runtime lifecycle validation failed.";
  if (/could not be created|spawn/iu.test(text)) return "Runtime process could not be created.";
  if (/shutdown deadline|forced termination/iu.test(text)) return "Runtime shutdown exceeded its deadline.";
  const exitCode = text.match(/exited unexpectedly \(code (-?\d+)\)/iu)?.[1];
  if (exitCode) return `Runtime process exited unexpectedly (code ${exitCode}).`;
  if (/encountered/iu.test(text)) return "Runtime process reported an operating-system error.";
  return "Runtime lifecycle failure detail omitted.";
}

function diagnosticRecordPayload(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "recordDigest")
      // Persisted digests must not depend on the host locale or ICU build.
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ));
}

function diagnosticRecordDigest(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(diagnosticRecordPayload(value))
    .digest("hex");
}

function serializeDiagnosticRecord(
  value: Record<string, unknown>,
): string {
  const recordDigest = diagnosticRecordDigest(value);
  return `${JSON.stringify({ ...value, recordDigest })}\n`;
}

function parseDiagnosticRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 2 && record.event === "application.incident") {
    const incident = diagnosticRecordSchema.safeParse(record.incident);
    if (!incident.success || record.at !== incident.data.at
      || Object.keys(record).some((key) => !["schemaVersion", "event", "at", "incident", "recordDigest"].includes(key))
      || typeof record.recordDigest !== "string"
      || diagnosticRecordDigest(record) !== record.recordDigest) return null;
    return { ...record, incident: incident.data };
  }
  if (
    record.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION
    || typeof record.at !== "string"
    || record.at.length > 40
    || !Number.isFinite(Date.parse(record.at))
    || new Date(record.at).toISOString() !== record.at
    || typeof record.event !== "string"
    || ![
      "app.start",
      "app.stop",
      "detached-draft.recovery",
      "logs.reveal",
      "report.copy",
      "runtime.failure",
      "runtime.restart-requested",
      "runtime.state",
    ].includes(record.event)
    || typeof record.recordDigest !== "string"
    || !DIAGNOSTIC_DIGEST_PATTERN.test(record.recordDigest)
    || diagnosticRecordDigest(record) !== record.recordDigest
  ) return null;

  const baseKeys = ["schemaVersion", "at", "event", "recordDigest"];
  const runtimeKeys = [
    ...baseKeys,
    "phase",
    "generation",
    "processId",
    "restartAttempt",
    "restartScheduled",
    "startupBlockerCode",
    ...(record.event === "runtime.failure" ? ["message"] : []),
  ];
  const detachedDraftKeys = [
    ...baseKeys,
    "reason",
    "outcome",
    "evidencePreserved",
  ];
  const allowedKeys = record.event === "detached-draft.recovery"
    ? detachedDraftKeys
    : record.event === "runtime.failure" || record.event === "runtime.state"
      ? runtimeKeys
      : record.event === "runtime.restart-requested"
        ? [...baseKeys, "generation", "reason", "stage", "signal", "exitCode", "probe"] : baseKeys;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    return null;
  }

  if (record.event === "runtime.restart-requested") {
    if (boundedInteger(record.generation, 0, Number.MAX_SAFE_INTEGER) === undefined
      || (record.reason !== "owned-process-tainted" && record.reason !== "owned-process-cleanup-unconfirmed")) return null;
    if (record.stage !== undefined || record.signal !== undefined || record.exitCode !== undefined || record.probe !== undefined) {
      if (record.reason !== "owned-process-tainted" || !parseRuntimeOwnedProcessDiagnostic({
        stage: record.stage,
        ...(record.signal !== undefined ? { signal: record.signal } : {}),
        ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
        ...(record.probe !== undefined ? { probe: record.probe } : {}),
      })) return null;
    }
    return record;
  }

  if (record.event === "detached-draft.recovery") {
    if (
      (record.reason !== undefined
        && (typeof record.reason !== "string"
          || !DETACHED_DRAFT_REASONS.includes(
            record.reason as (typeof DETACHED_DRAFT_REASONS)[number],
          )))
      || (record.outcome !== undefined
        && (typeof record.outcome !== "string"
          || !DETACHED_DRAFT_OUTCOMES.includes(
            record.outcome as (typeof DETACHED_DRAFT_OUTCOMES)[number],
          )))
      || (record.evidencePreserved !== undefined
        && typeof record.evidencePreserved !== "boolean")
    ) return null;
    return record;
  }

  if (record.event === "runtime.failure" || record.event === "runtime.state") {
    if (
      (record.phase !== undefined
        && (typeof record.phase !== "string"
          || !DIAGNOSTIC_PHASE_PATTERN.test(record.phase)))
      || (record.generation !== undefined
        && boundedInteger(
          record.generation,
          0,
          Number.MAX_SAFE_INTEGER,
        ) === undefined)
      || (record.processId !== undefined
        && boundedInteger(record.processId, 1, 2_147_483_647) === undefined)
      || (record.restartAttempt !== undefined
        && boundedInteger(record.restartAttempt, 0, 1_000_000) === undefined)
      || (record.restartScheduled !== undefined
        && typeof record.restartScheduled !== "boolean")
      || (record.startupBlockerCode !== undefined
        && !isRuntimeStartupBlockerCode(record.startupBlockerCode))
      || (record.event === "runtime.failure"
        && record.message !== undefined
        && runtimeFailureSummary(record.message) !== record.message)
    ) return null;
  }
  return record;
}

export class RuntimeDiagnostics {
  readonly directory: string;
  private readonly activePath: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly write: NonNullable<RuntimeDiagnosticsOptions["write"]>;
  private readonly incidents: ApplicationIncidentIndex;

  constructor(directory: string, options: RuntimeDiagnosticsOptions = {}) {
    this.directory = resolve(directory);
    this.activePath = join(this.directory, "runtime.log");
    this.maxFileBytes = Math.max(256, Math.min(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 4 * 1024 * 1024));
    this.maxFiles = Math.max(2, Math.min(Math.trunc(options.maxFiles ?? DEFAULT_MAX_FILES), 10));
    this.retentionMs = Math.max(1_000, Math.min(options.retentionMs ?? DEFAULT_RETENTION_MS, 30 * 24 * 60 * 60 * 1_000));
    this.now = options.now ?? Date.now;
    this.write = options.write ?? ((descriptor, buffer, offset, length) =>
      writeSync(descriptor, buffer, offset, length));
    this.incidents = new ApplicationIncidentIndex({
      now: this.now, retentionMs: this.retentionMs,
      load: () => {
        this.ensureDirectory();
        const records: unknown[] = [];
        this.readEvents((record) => {
          // Legacy lifecycle records remain in support summaries. Do not invent
          // incident identities/causes for them or duplicate modern failures.
          if (record.event === "application.incident") records.push(record.incident);
        });
        return records;
      },
      append: (incident) => {
        this.ensureDirectory();
        const line = serializeDiagnosticRecord({
          schemaVersion: 2, event: "application.incident", at: incident.at, incident,
        });
        if (Buffer.byteLength(line) > this.maxFileBytes) throw new Error("Diagnostic record exceeds the journal bound.");
        this.rotateIfNeeded(Buffer.byteLength(line));
        this.append(line);
      },
    });
  }

  recordIncident(incident: DiagnosticIncident): ReturnType<ApplicationIncidentIndex["record"]> {
    try { return this.incidents.record(incident); } catch { return null; }
  }

  queryIncidents(query: DiagnosticQuery): DiagnosticPage { return this.incidents.query(query); }
  exportIncidents(query: DiagnosticQuery): string { return this.incidents.export(query); }
  flushIncidents(): void { this.incidents.flush(); }
  onIncidentsChanged(notify: () => void): void { this.incidents.onChange(notify); }
  setIncidentRuntimeReady(ready: boolean, generationHash: string | null = null): void { this.incidents.setRuntime(ready, generationHash); }

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
      if (event === "app.stop") this.flushIncidents();
      this.ensureDirectory();
      const entry: Record<string, string | number | boolean> = {
        schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
        at: new Date(this.now()).toISOString(),
        event,
      };
      const phase = typeof fields.phase === "string" && DIAGNOSTIC_PHASE_PATTERN.test(fields.phase)
        ? fields.phase
        : undefined;
      const generation = boundedInteger(fields.generation, 0, Number.MAX_SAFE_INTEGER);
      const processId = boundedInteger(fields.processId, 1, 2_147_483_647);
      const restartAttempt = boundedInteger(fields.restartAttempt, 0, 1_000_000);
      const message = event === "runtime.failure"
        ? runtimeFailureSummary(fields.message)
        : undefined;
      if (event === "runtime.restart-requested") {
        if (generation === undefined || (fields.reason !== "owned-process-tainted" && fields.reason !== "owned-process-cleanup-unconfirmed")) return;
        entry.generation = generation;
        entry.reason = fields.reason as string;
        const diagnostic = parseRuntimeOwnedProcessDiagnostic({
          stage: fields.stage,
          ...(fields.signal !== undefined ? { signal: fields.signal } : {}),
          ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
          ...(fields.probe !== undefined ? { probe: fields.probe } : {}),
        });
        if (fields.reason === "owned-process-tainted" && diagnostic) Object.assign(entry, diagnostic);
      }
      if (event === "runtime.failure" || event === "runtime.state") {
        if (phase) entry.phase = phase;
        if (generation !== undefined) entry.generation = generation;
        if (processId !== undefined) entry.processId = processId;
        if (restartAttempt !== undefined) entry.restartAttempt = restartAttempt;
        if (typeof fields.restartScheduled === "boolean") entry.restartScheduled = fields.restartScheduled;
        if (isRuntimeStartupBlockerCode(fields.startupBlockerCode)) {
          entry.startupBlockerCode = fields.startupBlockerCode;
        }
      }
      if (
        event === "detached-draft.recovery"
        && typeof fields.reason === "string"
        && DETACHED_DRAFT_REASONS.includes(
          fields.reason as (typeof DETACHED_DRAFT_REASONS)[number],
        )
      ) entry.reason = fields.reason;
      if (
        event === "detached-draft.recovery"
        && typeof fields.outcome === "string"
        && DETACHED_DRAFT_OUTCOMES.includes(
          fields.outcome as (typeof DETACHED_DRAFT_OUTCOMES)[number],
        )
      ) entry.outcome = fields.outcome;
      if (
        event === "detached-draft.recovery"
        && typeof fields.evidencePreserved === "boolean"
      ) entry.evidencePreserved = fields.evidencePreserved;
      if (message) entry.message = message;

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
      this.rotateIfNeeded(Buffer.byteLength(line));
      this.append(line);
    } catch {
      // Diagnostics are best effort and must never affect application startup.
    }
  }

  recordRestartRequested(event: RuntimeRestartRequestedEvent, generation: number): void {
    this.record("runtime.restart-requested", { generation, reason: event.reason, ...event.diagnostic });
  }

  recordState(snapshot: RuntimeSupervisorSnapshot): void {
    const recovery = snapshot.databaseRecovery;
    const recoveryMessage = recovery?.outcome === "restored"
      ? `Database restored from validated backup ${recovery.restoredBackup ?? "unknown"}; corrupt primary preserved: ${recovery.preservedCorruptPrimary ? "yes" : "no"}; database family members preserved: ${recovery.preservedDatabaseFamilyMembers}; invalid backups skipped: ${recovery.invalidBackupsSkipped}; newer backups preserved: ${recovery.unsupportedBackupsSkipped}.`
      : recovery?.outcome === "created-empty"
        ? `Database started empty after ${recovery.trigger}; corrupt primary preserved: ${recovery.preservedCorruptPrimary ? "yes" : "no"}; database family members preserved: ${recovery.preservedDatabaseFamilyMembers}; invalid backups skipped: ${recovery.invalidBackupsSkipped}; newer backups preserved: ${recovery.unsupportedBackupsSkipped}.`
        : undefined;
    this.record(snapshot.lastError ? "runtime.failure" : "runtime.state", {
      phase: snapshot.phase,
      generation: snapshot.generation,
      processId: snapshot.pid,
      restartAttempt: snapshot.restartAttempt,
      restartScheduled: snapshot.restartScheduled,
      message: snapshot.lastError ?? recoveryMessage,
      startupBlockerCode: snapshot.startupBlockerCode,
      // websocketUrl is deliberately excluded because it contains a capability.
    });
  }

  supportReport(input: RuntimeSupportReportInput): RuntimeSupportReport {
    this.ensureDirectory();
    const events = this.readEvents().slice(-120);
    const runtime = input.runtime;
    const submittedLifecycle = input.lifecycle ?? null;
    // Renderer state can outlive a disconnected worker. Main accepts it only
    // while the exact current generation is ready and the hashes agree.
    const lifecycle = runtime?.phase === "ready"
      && runtime.runtimeGenerationHash !== null
      && submittedLifecycle?.runtimeGenerationHash
        === runtime.runtimeGenerationHash
      ? submittedLifecycle
      : null;
    const updatePreparation = isAppUpdatePreparationDiagnostic(
      input.updatePreparation,
    )
      ? input.updatePreparation
      : null;
    const lifecycleState = lifecycle
      ? lifecycleActionableStateWithUpdate(
          lifecycle.actionableState,
          updatePreparation,
        )
      : null;
    const buildMetadataCandidate = input.buildMetadata === undefined
      ? lifecycle?.buildMetadata ?? null
      : input.buildMetadata;
    const parsedBuildMetadata = lifecycleBuildMetadataSchema.safeParse(
      buildMetadataCandidate,
    );
    const buildMetadata = parsedBuildMetadata.success
      ? parsedBuildMetadata.data
      : null;
    const updateHandoffPhase = input.updateHandoff?.state === "none"
      ? lifecycle?.updateHandoffPhase ?? "none"
      : input.updateHandoff?.phase ?? lifecycle?.updateHandoffPhase ?? "unavailable";
    const startupBlockerCode = runtime?.startupBlockerCode ?? null;
    const lifecycleLines = lifecycle
      ? [
          `Lifecycle state: ${lifecycleState}`,
          `Runtime generation hash: ${lifecycle.runtimeGenerationHash}`,
          `System boot relationship: ${lifecycle.systemBootRelationship}`,
          `Startup blockers: ${lifecycle.startupBlockerCodes.join(", ") || "none"}`,
          `Quarantine reason: ${lifecycle.quarantineReason ?? "none"}`,
          `Cleanup proof: ${lifecycle.cleanupProofMethod}`,
          `Owned resources: provider-runs=${lifecycle.ownedResources.providerRuns}, turns=${lifecycle.ownedResources.turns}, terminals=${lifecycle.ownedResources.terminals}, workspace-runs=${lifecycle.ownedResources.workspaceRuns}, interactions=${lifecycle.ownedResources.interactions}, maintenance=${lifecycle.ownedResources.maintenanceOperations}`,
          `Unresolved: turns=${lifecycle.unresolvedTurnCount}, interactions=${lifecycle.unresolvedInteractionCount}`,
          `Active providers: ${lifecycle.activeProviders.length > 0
            ? lifecycle.activeProviders.map((provider) => (
                `${provider.providerId}/${provider.harnessId}@${provider.version ?? "unknown"}`
                + ` manifest=${provider.capabilityManifestDigest ?? "unverified"}`
                + ` verified=${provider.installationVerified ? "yes" : "no"}`
                + ` maintenance=${provider.maintenanceState}`
              )).join(", ")
            : "none"}`,
          `Provider maintenance: ${lifecycle.providerMaintenance.length > 0
            ? lifecycle.providerMaintenance.map(
                ({ providerId, state }) => `${providerId}=${state}`,
              ).join(", ")
            : "none"}`,
          `Runtime lifecycle started: ${lifecycle.runtimeStartedAt ?? "unavailable"}`,
          `Runtime lifecycle captured: ${lifecycle.capturedAt}`,
          `Runtime lifecycle uptime: ${lifecycle.runtimeUptimeMs}ms`,
        ]
      : startupBlockerCode
        ? [
            `Lifecycle state: ${startupBlockerCode === "prior-runtime-cleanup-unconfirmed"
              ? "previous-runtime-cleanup-unconfirmed"
              : "recovery-requires-manual-attention"}`,
            `Startup blockers: ${startupBlockerCode}`,
            `Quarantine reason: ${startupBlockerCode === "prior-runtime-cleanup-unconfirmed"
              ? "prior-runtime-cleanup-unconfirmed"
              : "provider-maintenance-recovery-required"}`,
            `Cleanup proof: ${startupBlockerCode === "prior-runtime-cleanup-unconfirmed"
              ? "unconfirmed"
              : "unavailable"}`,
          ]
        : ["Lifecycle state: unavailable"];
    const preface = [
      "Inertia support summary",
      `Generated: ${new Date(this.now()).toISOString()}`,
      `Version: ${sanitizeRuntimeDiagnosticText(input.version) ?? "unknown"}`,
      `Channel: ${input.channel ?? "stable"}`,
      `Platform: ${sanitizeRuntimeDiagnosticText(input.platform) ?? "unknown"}`,
      `Architecture: ${sanitizeRuntimeDiagnosticText(input.architecture) ?? "unknown"}`,
      `Runtime: ${runtime?.phase ?? "unavailable"}`,
      `Runtime generation: ${runtime?.generation ?? 0}`,
      `Restart attempt: ${runtime?.restartAttempt ?? 0}`,
      `Restart scheduled: ${runtime?.restartScheduled === true ? "yes" : "no"}`,
      `Build metadata: ${buildMetadata
        ? `${buildMetadata.source} revision=${buildMetadata.sourceRevision} run=${buildMetadata.runId} attempt=${buildMetadata.runAttempt} release=${buildMetadata.releaseTag ?? "none"}`
        : "unavailable"}`,
      ...lifecycleLines,
      `Update preparation: ${updatePreparation?.phase ?? "unavailable"}${
        updatePreparation?.blocker
          ? ` blocker=${updatePreparation.blocker}`
          : ""
      }`,
      `Update handoff: ${updateHandoffPhase}`,
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

  private readEvents(onRecord?: (record: Record<string, unknown>) => void): string[] {
    const names = readdirSync(this.directory)
      .filter((name) => LOG_FILE_PATTERN.test(name))
      .sort((left, right) => {
        if (left === "runtime.log") return 1;
        if (right === "runtime.log") return -1;
        const leftIndex = Number(left.match(/\.(\d+)\./u)?.[1] ?? 0);
        const rightIndex = Number(right.match(/\.(\d+)\./u)?.[1] ?? 0);
        return rightIndex - leftIndex;
      }).slice(-this.maxFiles);
    const events: string[] = [];
    for (const name of names) {
      let content: string;
      try {
        const path = join(this.directory, name);
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
        const descriptor = openSync(path, constants.O_RDONLY | noFollow);
        try {
          const opened = fstatSync(descriptor);
          if (
            !opened.isFile()
            || opened.dev !== metadata.dev
            || opened.ino !== metadata.ino
          ) continue;
          const bytes = Buffer.allocUnsafe(
            Math.min(this.maxFileBytes, Math.max(0, opened.size)),
          );
          const read = bytes.length > 0
            ? readSync(descriptor, bytes, 0, bytes.length, 0)
            : 0;
          content = bytes.subarray(0, read).toString("utf8");
        } finally {
          closeSync(descriptor);
        }
      } catch {
        // Rotation can race a support-summary read. Skip the disappeared file.
        continue;
      }
      for (const line of content.split(/\r?\n/u)) {
        if (!line) continue;
        try {
          const value = parseDiagnosticRecord(JSON.parse(line));
          if (!value) continue;
          onRecord?.(value);
          if (value.event === "application.incident") {
            const incident = diagnosticRecordSchema.parse(value.incident);
            events.push(`${incident.at} · ${incident.code} · ${diagnosticDefinition(incident.code).title} · ${incident.outcome}`);
            continue;
          }
          const event = value.event as RuntimeDiagnosticEvent;
          const at = value.at as string;
          const lifecycleEvent = event !== "detached-draft.recovery";
          const fields = [
            event === "runtime.restart-requested" ? `reason=${value.reason}` : null,
            event === "runtime.restart-requested" && value.stage !== undefined ? `stage=${value.stage}` : null,
            event === "runtime.restart-requested" && value.signal !== undefined ? `signal=${value.signal}` : null,
            event === "runtime.restart-requested" && value.exitCode !== undefined ? `exit-code=${value.exitCode}` : null,
            event === "runtime.restart-requested" && value.probe !== undefined ? `probe=${value.probe}` : null,
            lifecycleEvent && typeof value.phase === "string"
              ? `phase=${value.phase}`
              : null,
            lifecycleEvent
              && boundedInteger(value.generation, 0, Number.MAX_SAFE_INTEGER) !== undefined
              ? `generation=${value.generation}`
              : null,
            lifecycleEvent
              && boundedInteger(value.restartAttempt, 0, 1_000_000) !== undefined
              ? `restart=${value.restartAttempt}`
              : null,
            lifecycleEvent && typeof value.restartScheduled === "boolean"
              ? `scheduled=${value.restartScheduled ? "yes" : "no"}`
              : null,
            event === "detached-draft.recovery"
              && typeof value.reason === "string"
              && [
                "changed",
                "invalid-json",
                "invalid-schema",
                "missing",
                "permission",
                "too-large",
                "transient-io",
                "unsafe",
              ].includes(value.reason)
              ? `reason=${value.reason}`
              : null,
            event === "detached-draft.recovery"
              && typeof value.outcome === "string"
              && ["blocked", "quarantined", "recovered"].includes(value.outcome)
              ? `outcome=${value.outcome}`
              : null,
            event === "detached-draft.recovery"
              && typeof value.evidencePreserved === "boolean"
              ? `evidence=${value.evidencePreserved ? "preserved" : "unavailable"}`
              : null,
            event === "runtime.failure"
              ? runtimeFailureSummary(value.message)
              : null,
            isRuntimeStartupBlockerCode(value.startupBlockerCode)
              ? `startup-blocker=${value.startupBlockerCode}`
              : null,
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
    const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
    const descriptor = openSync(
      this.activePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
      FILE_MODE,
    );
    try {
      fchmodSync(descriptor, FILE_MODE);
      const bytes = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = this.write(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
        );
        if (!Number.isInteger(written) || written <= 0) {
          throw new Error("The runtime diagnostic record could not be written.");
        }
        offset += Math.min(written, bytes.length - offset);
      }
      fsyncSync(descriptor);
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
      if (
        metadata.isSymbolicLink()
        || !metadata.isFile()
        || metadata.mtimeMs < cutoff
        || metadata.size > this.maxFileBytes
      ) {
        unlinkSync(path);
        continue;
      }
      this.pruneExpiredRecords(path, metadata, cutoff);
    }
  }

  private pruneExpiredRecords(
    path: string,
    metadata: Stats,
    cutoff: number,
  ): void {
    if (metadata.size === 0) return;
    const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
    const descriptor = openSync(path, constants.O_RDONLY | noFollow);
    let content: string;
    try {
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile()
        || opened.dev !== metadata.dev
        || opened.ino !== metadata.ino
        || opened.size !== metadata.size
      ) return;
      const bytes = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (read <= 0) return;
        offset += read;
      }
      content = bytes.toString("utf8");
    } finally {
      closeSync(descriptor);
    }
    let expired = false;
    const retained = content.split(/\r?\n/u).filter((line) => {
      if (!line) return false;
      try {
        const value = JSON.parse(line) as { at?: unknown };
        if (typeof value.at !== "string") return false;
        const timestamp = Date.parse(value.at);
        if (!Number.isFinite(timestamp)) return false;
        if (timestamp < cutoff) {
          expired = true;
          return false;
        }
        return true;
      } catch {
        return false;
      }
    });
    if (!expired) return;
    const current = lstatSync(path);
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.dev !== metadata.dev
      || current.ino !== metadata.ino
      || current.size !== metadata.size
      || current.mtimeMs !== metadata.mtimeMs
    ) return;
    if (retained.length === 0) {
      unlinkSync(path);
      return;
    }
    const temporary = join(
      this.directory,
      `.runtime-diagnostics-${randomUUID()}.prune.tmp`,
    );
    const output = Buffer.from(`${retained.join("\n")}\n`, "utf8");
    let temporaryDescriptor: number | null = null;
    try {
      temporaryDescriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        FILE_MODE,
      );
      fchmodSync(temporaryDescriptor, FILE_MODE);
      let offset = 0;
      while (offset < output.length) {
        const written = writeSync(
          temporaryDescriptor,
          output,
          offset,
          output.length - offset,
        );
        if (written <= 0) return;
        offset += written;
      }
      fsyncSync(temporaryDescriptor);
      closeSync(temporaryDescriptor);
      temporaryDescriptor = null;
      const unchanged = lstatSync(path);
      if (
        unchanged.isFile()
        && !unchanged.isSymbolicLink()
        && unchanged.dev === metadata.dev
        && unchanged.ino === metadata.ino
        && unchanged.size === metadata.size
        && unchanged.mtimeMs === metadata.mtimeMs
      ) {
        renameSync(temporary, path);
        chmodSync(path, FILE_MODE);
      }
    } finally {
      if (temporaryDescriptor !== null) closeSync(temporaryDescriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
