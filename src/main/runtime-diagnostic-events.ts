import type {
  DiagnosticEventEntry,
  DiagnosticSeverity,
  DiagnosticSubsystem,
} from "../shared/application-diagnostics.js";

export const RUNTIME_DIAGNOSTIC_EVENTS = [
  "app.start",
  "app.stop",
  "browser.operation-failure",
  "detached-draft.recovery",
  "diagnostics.capture-started",
  "diagnostics.capture-stopped",
  "diagnostics.history-cleared",
  "diagnostics.preferences-unreadable",
  "logs.reveal",
  "main.failure",
  "mascot.feed-rejected",
  "renderer.crash",
  "report.copy",
  "runtime.database-recovery",
  "runtime.failure",
  "runtime.restart-requested",
  "runtime.state",
  "runtime.stderr",
  "snapshot.failure",
] as const;
export type RuntimeDiagnosticEvent = (typeof RUNTIME_DIAGNOSTIC_EVENTS)[number];

export const ALWAYS_ON_DIAGNOSTIC_EVENTS: ReadonlySet<RuntimeDiagnosticEvent> = new Set([
  "app.start",
  "app.stop",
  "renderer.crash",
  "runtime.failure",
  "runtime.restart-requested",
  "diagnostics.capture-started",
  "diagnostics.capture-stopped",
  "diagnostics.history-cleared",
  "diagnostics.preferences-unreadable",
]);

export const RENDERER_GONE_REASONS = [
  "abnormal-exit",
  "crashed",
  "integrity-failure",
  "killed",
  "launch-failed",
  "memory-eviction",
  "oom",
] as const;

export const DATABASE_RECOVERY_OUTCOMES = ["restored", "created-empty"] as const;
export const DATABASE_RECOVERY_TRIGGERS = ["none", "primary-missing", "primary-corrupt"] as const;

interface Presentation {
  severity: DiagnosticSeverity;
  title: string;
}

const RUNTIME_STDERR_PRESENTATION = {
  "database-backup-failed": { severity: "error", title: "A scheduled database backup failed" },
  "database-migration-failed": { severity: "error", title: "A database migration failed and was rolled back" },
  "git-scan-cleanup-failed": { severity: "warning", title: "Git scan cleanup failed after a timeout" },
  "review-summary-malformed": { severity: "warning", title: "A saved review summary could not be read" },
  "settlement-snapshot-unpublished": { severity: "warning", title: "A finished turn could not be published" },
  "suspend-accounting-failed": { severity: "warning", title: "System sleep could not be recorded" },
  "terminal-resume-rejected": { severity: "warning", title: "A terminal session could not resume" },
  "turn-diagnostic-unpersisted": { severity: "warning", title: "A turn diagnostic could not be saved" },
  "turn-update-unpublished": { severity: "warning", title: "A turn update could not be published" },
  omitted: { severity: "info", title: "Runtime stderr line omitted" },
} as const satisfies Record<string, Presentation>;
export type RuntimeStderrCode = keyof typeof RUNTIME_STDERR_PRESENTATION;
export const RUNTIME_STDERR_CODES = Object.keys(RUNTIME_STDERR_PRESENTATION) as RuntimeStderrCode[];

const MAIN_FAILURE_PRESENTATION = {
  "app-update-candidate-failed": "An app update could not start",
  "app-update-preparation-failed": "An app update could not be prepared",
  "private-connect-stop-failed": "Private Connect did not stop cleanly",
  "privileged-shutdown-failed": "Shutdown cleanup did not finish",
  "temporary-attachment-cleanup-failed": "Temporary attachments could not be removed",
} as const;
export type MainFailureCode = keyof typeof MAIN_FAILURE_PRESENTATION;
export const MAIN_FAILURE_CODES = Object.keys(MAIN_FAILURE_PRESENTATION) as MainFailureCode[];

const EVENT_PRESENTATION: Record<RuntimeDiagnosticEvent, Presentation & { subsystem: DiagnosticSubsystem }> = {
  "app.start": { severity: "info", subsystem: "application", title: "Inertia started" },
  "app.stop": { severity: "info", subsystem: "application", title: "Inertia quit" },
  "browser.operation-failure": { severity: "warning", subsystem: "application", title: "A browser preview operation failed" },
  "detached-draft.recovery": { severity: "warning", subsystem: "application", title: "A chat draft needed recovery" },
  "diagnostics.capture-started": { severity: "info", subsystem: "application", title: "Diagnostics capture turned on" },
  "diagnostics.capture-stopped": { severity: "info", subsystem: "application", title: "Diagnostics capture turned off" },
  "diagnostics.history-cleared": { severity: "info", subsystem: "application", title: "Diagnostics history cleared" },
  "diagnostics.preferences-unreadable": { severity: "warning", subsystem: "application", title: "Diagnostics settings could not be read, so capture is off" },
  "logs.reveal": { severity: "info", subsystem: "application", title: "Log folder opened" },
  "main.failure": { severity: "error", subsystem: "application", title: "An app operation failed" },
  "mascot.feed-rejected": { severity: "warning", subsystem: "application", title: "A desktop mascot update was dropped" },
  "renderer.crash": { severity: "error", subsystem: "application", title: "The app window stopped unexpectedly" },
  "report.copy": { severity: "info", subsystem: "application", title: "Support summary copied" },
  "runtime.database-recovery": { severity: "warning", subsystem: "runtime", title: "The database was restored from a backup" },
  "runtime.failure": { severity: "error", subsystem: "runtime", title: "The local runtime reported a failure" },
  "runtime.restart-requested": { severity: "warning", subsystem: "runtime", title: "A runtime restart was requested" },
  "runtime.state": { severity: "info", subsystem: "runtime", title: "Local runtime state changed" },
  "runtime.stderr": { severity: "warning", subsystem: "runtime", title: "The local runtime reported a problem" },
  "snapshot.failure": { severity: "warning", subsystem: "application", title: "A snapshot could not be captured" },
};

const RUNTIME_PHASE_TITLES: Readonly<Record<string, string>> = {
  idle: "Local runtime idle",
  starting: "Local runtime starting",
  ready: "Local runtime ready",
  restarting: "Local runtime restarting",
  stopping: "Local runtime stopping",
  stopped: "Local runtime stopped",
};

function presentation(record: Record<string, unknown>): Presentation & { subsystem: DiagnosticSubsystem } {
  const event = record.event as RuntimeDiagnosticEvent;
  const base = EVENT_PRESENTATION[event];
  if (event === "runtime.stderr") {
    return { ...RUNTIME_STDERR_PRESENTATION[record.code as RuntimeStderrCode], subsystem: base.subsystem };
  }
  if (event === "main.failure") {
    return { ...base, title: MAIN_FAILURE_PRESENTATION[record.code as MainFailureCode] };
  }
  if (event === "runtime.database-recovery" && record.outcome === "created-empty") {
    return { ...base, severity: "error", title: "The database started empty" };
  }
  if (event === "runtime.state" && typeof record.phase === "string" && RUNTIME_PHASE_TITLES[record.phase]) {
    return { ...base, title: RUNTIME_PHASE_TITLES[record.phase]! };
  }
  return base;
}

export function diagnosticEventEntry(
  record: Record<string, unknown>,
  detail: string[],
): DiagnosticEventEntry {
  const { severity, subsystem, title } = presentation(record);
  return {
    id: `event-${String(record.recordDigest).slice(0, 16)}`,
    at: record.at as string,
    event: record.event as string,
    severity,
    subsystem,
    title,
    detail,
  };
}
