import { createHash } from "node:crypto";
import { parseRuntimeOwnedProcessDiagnostic } from "../node/runtime-owned-process-diagnostic.js";
import { parseRuntimeFailureDiagnosticMessage } from "../node/runtime-failure-diagnostic.js";
import { isPreviewAgentFailureCategory, isPreviewAgentOperationPhase } from "./preview-agent-phase.js";
import { diagnosticRecordSchema } from "../shared/application-diagnostics.js";
import { isRuntimeStartupBlockerCode } from "../shared/runtime-startup-diagnostics.js";
import { SNAPSHOT_CAPTURE_PHASES, SNAPSHOT_DIAGNOSTIC_CATEGORIES } from "../shared/snapshots.js";
import {
  DATABASE_RECOVERY_OUTCOMES,
  DATABASE_RECOVERY_TRIGGERS,
  MAIN_FAILURE_CODES,
  RENDERER_GONE_REASONS,
  RUNTIME_DIAGNOSTIC_EVENTS,
  RUNTIME_STDERR_CODES,
  type RuntimeDiagnosticEvent,
} from "./runtime-diagnostic-events.js";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
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
const DATABASE_RECOVERY_COUNTS = [
  "preservedDatabaseFamilyMembers",
  "invalidBackupsSkipped",
  "unsupportedBackupsSkipped",
] as const;

export type DiagnosticFields = Readonly<Record<string, unknown>>;
export type DiagnosticEntryValue = Record<string, string | number | boolean>;

export function allowlisted<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

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

export function runtimeFailureSummary(value: unknown): string | undefined {
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
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ));
}

export function diagnosticRecordDigest(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(diagnosticRecordPayload(value))
    .digest("hex");
}

export function serializeDiagnosticRecord(
  value: Record<string, unknown>,
): string {
  const recordDigest = diagnosticRecordDigest(value);
  return `${JSON.stringify({ ...value, recordDigest })}\n`;
}

function allowedKeys(event: RuntimeDiagnosticEvent): string[] {
  const baseKeys = ["schemaVersion", "at", "event", "recordDigest"];
  switch (event) {
    case "browser.operation-failure":
    case "snapshot.failure":
      return [...baseKeys, "phase", "category"];
    case "detached-draft.recovery":
      return [...baseKeys, "reason", "outcome", "evidencePreserved"];
    case "runtime.failure":
    case "runtime.state":
      return [
        ...baseKeys,
        "phase",
        "generation",
        "processId",
        "restartAttempt",
        "restartScheduled",
        "startupBlockerCode",
        ...(event === "runtime.failure" ? ["message"] : []),
      ];
    case "runtime.restart-requested":
      return [...baseKeys, "generation", "reason", "stage", "signal", "exitCode", "probe"];
    case "renderer.crash":
      return [...baseKeys, "reason", "exitCode"];
    case "runtime.stderr":
      return [...baseKeys, "code", "count"];
    case "main.failure":
      return [...baseKeys, "code"];
    case "runtime.database-recovery":
      return [...baseKeys, "outcome", "trigger", "preservedCorruptPrimary", ...DATABASE_RECOVERY_COUNTS];
    default:
      return baseKeys;
  }
}

function validEventFields(record: Record<string, unknown>, event: RuntimeDiagnosticEvent): boolean {
  switch (event) {
    case "runtime.restart-requested":
      if (boundedInteger(record.generation, 0, Number.MAX_SAFE_INTEGER) === undefined
        || (record.reason !== "owned-process-tainted" && record.reason !== "owned-process-cleanup-unconfirmed")) return false;
      if (record.stage === undefined && record.signal === undefined && record.exitCode === undefined && record.probe === undefined) return true;
      return record.reason === "owned-process-tainted" && Boolean(parseRuntimeOwnedProcessDiagnostic({
        stage: record.stage,
        ...(record.signal !== undefined ? { signal: record.signal } : {}),
        ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
        ...(record.probe !== undefined ? { probe: record.probe } : {}),
      }));
    case "snapshot.failure":
      return allowlisted(SNAPSHOT_DIAGNOSTIC_CATEGORIES, record.category)
        && (record.phase === undefined || allowlisted(SNAPSHOT_CAPTURE_PHASES, record.phase));
    case "browser.operation-failure":
      return isPreviewAgentOperationPhase(record.phase) && isPreviewAgentFailureCategory(record.category);
    case "detached-draft.recovery":
      return (record.reason === undefined || allowlisted(DETACHED_DRAFT_REASONS, record.reason))
        && (record.outcome === undefined || allowlisted(DETACHED_DRAFT_OUTCOMES, record.outcome))
        && (record.evidencePreserved === undefined || typeof record.evidencePreserved === "boolean");
    case "runtime.failure":
    case "runtime.state":
      return (record.phase === undefined || (typeof record.phase === "string" && DIAGNOSTIC_PHASE_PATTERN.test(record.phase)))
        && (record.generation === undefined || boundedInteger(record.generation, 0, Number.MAX_SAFE_INTEGER) !== undefined)
        && (record.processId === undefined || boundedInteger(record.processId, 1, 2_147_483_647) !== undefined)
        && (record.restartAttempt === undefined || boundedInteger(record.restartAttempt, 0, 1_000_000) !== undefined)
        && (record.restartScheduled === undefined || typeof record.restartScheduled === "boolean")
        && (record.startupBlockerCode === undefined || isRuntimeStartupBlockerCode(record.startupBlockerCode))
        && (event !== "runtime.failure" || record.message === undefined || runtimeFailureSummary(record.message) === record.message);
    case "renderer.crash":
      return allowlisted(RENDERER_GONE_REASONS, record.reason)
        && (record.exitCode === undefined || boundedInteger(record.exitCode, -2_147_483_648, 4_294_967_295) !== undefined);
    case "runtime.stderr":
      return allowlisted(RUNTIME_STDERR_CODES, record.code)
        && boundedInteger(record.count, 1, 1_000_000) !== undefined;
    case "main.failure":
      return allowlisted(MAIN_FAILURE_CODES, record.code);
    case "runtime.database-recovery":
      return allowlisted(DATABASE_RECOVERY_OUTCOMES, record.outcome)
        && allowlisted(DATABASE_RECOVERY_TRIGGERS, record.trigger)
        && typeof record.preservedCorruptPrimary === "boolean"
        && DATABASE_RECOVERY_COUNTS.every((key) => boundedInteger(record[key], 0, 1_000_000) !== undefined);
    default:
      return true;
  }
}

export function parseDiagnosticRecord(
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
    || !allowlisted(RUNTIME_DIAGNOSTIC_EVENTS, record.event)
    || typeof record.recordDigest !== "string"
    || !DIAGNOSTIC_DIGEST_PATTERN.test(record.recordDigest)
    || diagnosticRecordDigest(record) !== record.recordDigest
  ) return null;
  const event = record.event;
  const keys = allowedKeys(event);
  if (Object.keys(record).some((key) => !keys.includes(key))) return null;
  return validEventFields(record, event) ? record : null;
}

export function buildDiagnosticEntry(
  event: RuntimeDiagnosticEvent,
  fields: DiagnosticFields,
  at: string,
): DiagnosticEntryValue | null {
  const entry: DiagnosticEntryValue = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    at,
    event,
  };
  const phase = typeof fields.phase === "string" && DIAGNOSTIC_PHASE_PATTERN.test(fields.phase)
    ? fields.phase
    : undefined;
  const generation = boundedInteger(fields.generation, 0, Number.MAX_SAFE_INTEGER);
  const processId = boundedInteger(fields.processId, 1, 2_147_483_647);
  const restartAttempt = boundedInteger(fields.restartAttempt, 0, 1_000_000);
  switch (event) {
    case "runtime.restart-requested": {
      if (generation === undefined || (fields.reason !== "owned-process-tainted" && fields.reason !== "owned-process-cleanup-unconfirmed")) return null;
      entry.generation = generation;
      entry.reason = fields.reason;
      const diagnostic = parseRuntimeOwnedProcessDiagnostic({
        stage: fields.stage,
        ...(fields.signal !== undefined ? { signal: fields.signal } : {}),
        ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
        ...(fields.probe !== undefined ? { probe: fields.probe } : {}),
      });
      if (fields.reason === "owned-process-tainted" && diagnostic) Object.assign(entry, diagnostic);
      return entry;
    }
    case "browser.operation-failure":
      if (!isPreviewAgentOperationPhase(fields.phase) || !isPreviewAgentFailureCategory(fields.category)) return null;
      entry.phase = fields.phase;
      entry.category = fields.category;
      return entry;
    case "runtime.failure":
    case "runtime.state": {
      if (phase) entry.phase = phase;
      if (generation !== undefined) entry.generation = generation;
      if (processId !== undefined) entry.processId = processId;
      if (restartAttempt !== undefined) entry.restartAttempt = restartAttempt;
      if (typeof fields.restartScheduled === "boolean") entry.restartScheduled = fields.restartScheduled;
      if (isRuntimeStartupBlockerCode(fields.startupBlockerCode)) entry.startupBlockerCode = fields.startupBlockerCode;
      const message = event === "runtime.failure" ? runtimeFailureSummary(fields.message) : undefined;
      if (message) entry.message = message;
      return entry;
    }
    case "detached-draft.recovery":
      if (allowlisted(DETACHED_DRAFT_REASONS, fields.reason)) entry.reason = fields.reason;
      if (allowlisted(DETACHED_DRAFT_OUTCOMES, fields.outcome)) entry.outcome = fields.outcome;
      if (typeof fields.evidencePreserved === "boolean") entry.evidencePreserved = fields.evidencePreserved;
      return entry;
    case "snapshot.failure":
      if (!allowlisted(SNAPSHOT_DIAGNOSTIC_CATEGORIES, fields.category)) return null;
      if (allowlisted(SNAPSHOT_CAPTURE_PHASES, fields.phase)) entry.phase = fields.phase;
      entry.category = fields.category;
      return entry;
    case "renderer.crash": {
      if (!allowlisted(RENDERER_GONE_REASONS, fields.reason)) return null;
      entry.reason = fields.reason;
      const exitCode = boundedInteger(fields.exitCode, -2_147_483_648, 4_294_967_295);
      if (exitCode !== undefined) entry.exitCode = exitCode;
      return entry;
    }
    case "runtime.stderr": {
      const count = boundedInteger(fields.count, 1, 1_000_000);
      if (!allowlisted(RUNTIME_STDERR_CODES, fields.code) || count === undefined) return null;
      entry.code = fields.code;
      entry.count = count;
      return entry;
    }
    case "main.failure":
      if (!allowlisted(MAIN_FAILURE_CODES, fields.code)) return null;
      entry.code = fields.code;
      return entry;
    case "runtime.database-recovery":
      if (!allowlisted(DATABASE_RECOVERY_OUTCOMES, fields.outcome)
        || !allowlisted(DATABASE_RECOVERY_TRIGGERS, fields.trigger)
        || typeof fields.preservedCorruptPrimary !== "boolean") return null;
      entry.outcome = fields.outcome;
      entry.trigger = fields.trigger;
      entry.preservedCorruptPrimary = fields.preservedCorruptPrimary;
      for (const key of DATABASE_RECOVERY_COUNTS) {
        const count = boundedInteger(fields[key], 0, 1_000_000);
        if (count === undefined) return null;
        entry[key] = count;
      }
      return entry;
    default:
      return entry;
  }
}

export function diagnosticRecordDetail(value: Record<string, unknown>): string[] {
  const event = value.event as RuntimeDiagnosticEvent;
  const lifecycleEvent = event === "app.start" || event === "app.stop"
    || event === "runtime.failure" || event === "runtime.state"
    || event === "runtime.restart-requested" || event === "browser.operation-failure"
    || event === "logs.reveal" || event === "report.copy";
  return [
    event === "runtime.restart-requested" ? `reason=${value.reason}` : null,
    event === "runtime.restart-requested" && value.stage !== undefined ? `stage=${value.stage}` : null,
    event === "runtime.restart-requested" && value.signal !== undefined ? `signal=${value.signal}` : null,
    event === "runtime.restart-requested" && value.exitCode !== undefined ? `exit-code=${value.exitCode}` : null,
    event === "runtime.restart-requested" && value.probe !== undefined ? `probe=${value.probe}` : null,
    lifecycleEvent && typeof value.phase === "string" ? `phase=${value.phase}` : null,
    lifecycleEvent && boundedInteger(value.generation, 0, Number.MAX_SAFE_INTEGER) !== undefined
      ? `generation=${value.generation}`
      : null,
    lifecycleEvent && boundedInteger(value.restartAttempt, 0, 1_000_000) !== undefined
      ? `restart=${value.restartAttempt}`
      : null,
    lifecycleEvent && typeof value.restartScheduled === "boolean"
      ? `scheduled=${value.restartScheduled ? "yes" : "no"}`
      : null,
    event === "browser.operation-failure" && isPreviewAgentFailureCategory(value.category)
      ? `category=${value.category}`
      : null,
    event === "detached-draft.recovery" && allowlisted(DETACHED_DRAFT_REASONS, value.reason)
      ? `reason=${value.reason}`
      : null,
    event === "detached-draft.recovery" && allowlisted(DETACHED_DRAFT_OUTCOMES, value.outcome)
      ? `outcome=${value.outcome}`
      : null,
    event === "detached-draft.recovery" && typeof value.evidencePreserved === "boolean"
      ? `evidence=${value.evidencePreserved ? "preserved" : "unavailable"}`
      : null,
    event === "snapshot.failure" && value.phase !== undefined ? `phase=${value.phase}` : null,
    event === "snapshot.failure" ? `category=${value.category}` : null,
    event === "renderer.crash" ? `reason=${value.reason}` : null,
    event === "renderer.crash" && value.exitCode !== undefined ? `exit-code=${value.exitCode}` : null,
    event === "runtime.stderr" || event === "main.failure" ? `code=${value.code}` : null,
    event === "runtime.stderr" ? `count=${value.count}` : null,
    event === "runtime.database-recovery" ? `outcome=${value.outcome}` : null,
    event === "runtime.database-recovery" ? `trigger=${value.trigger}` : null,
    event === "runtime.database-recovery" ? `corrupt-primary-preserved=${value.preservedCorruptPrimary ? "yes" : "no"}` : null,
    event === "runtime.database-recovery" ? `family-members-preserved=${value.preservedDatabaseFamilyMembers}` : null,
    event === "runtime.database-recovery" ? `invalid-backups-skipped=${value.invalidBackupsSkipped}` : null,
    event === "runtime.database-recovery" ? `newer-backups-preserved=${value.unsupportedBackupsSkipped}` : null,
    event === "runtime.failure" ? runtimeFailureSummary(value.message) ?? null : null,
    isRuntimeStartupBlockerCode(value.startupBlockerCode)
      ? `startup-blocker=${value.startupBlockerCode}`
      : null,
  ].filter((field): field is string => Boolean(field));
}
