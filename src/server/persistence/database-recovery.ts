import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import { validAttachmentCapabilities } from "./attachment-capability-schema";
import {
  regularOwnedFile,
  removeDatabaseFileFamily,
  removeIfRegularFile,
  removeInterruptedDatabaseFileFamily,
  waitForOperationOrAbort,
} from "./database-backup-cancellation";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "./migrations/catalog";
import {
  indexColumns,
  validProviderRunOwnershipSchema,
} from "./provider-run-ownership-schema";
import { validUsageDashboardIndex } from "./usage-dashboard-index-schema";

export const DATABASE_BACKUP_INTERVAL_MS = 60 * 60 * 1_000;
export const DATABASE_INITIAL_BACKUP_QUIET_MS = 30 * 1_000;
export const DATABASE_INITIAL_BACKUP_GRACE_MS = 1_000;
export const DATABASE_INITIAL_BACKUP_RETRY_MS = 5_000;
export const DATABASE_INITIAL_BACKUP_MAX_RETRIES = 5;
export const DATABASE_BACKUP_MAX_COUNT = 5;
export const DATABASE_BACKUP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const DATABASE_BACKUP_VALIDATION_TIMEOUT_MS = 120_000;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REQUIRED_TABLES_BY_SCHEMA_VERSION = [
  [1, ["projects", "conversations", "messages", "app_state"]],
  [2, ["activities", "checkpoints"]],
  [3, ["agent_plans"]],
  [4, ["agent_reasonings", "thread_usage"]],
  [5, ["provider_metadata_cache"]],
  [7, ["diff_review_summaries", "workspace_runs"]],
  [9, ["diff_review_states", "diff_review_notes"]],
  [16, ["agent_turns"]],
  [22, [
    "turn_execution_context_blobs",
    "turn_execution_manifests",
    "turn_execution_context_refs",
  ]],
  [23, ["turn_git_artifacts"]],
  [25, ["model_backend_profiles", "model_backend_defaults"]],
  [26, ["provider_metadata_scoped_cache"]],
  [28, ["subagent_traces"]],
  [32, ["agent_goals"]],
  [38, ["paired_launches", "paired_launch_sides"]],
  [42, ["message_content_chunks", "reasoning_content_chunks"]],
  [43, ["recovery_import_receipts", "recovery_import_journals"]],
  [52, ["conversation_worktree_ownership"]],
  [53, [
    "project_path_authorities",
    "conversation_path_authorities",
    "workspace_path_authority_enrollment",
  ]],
  [54, ["prompt_presets"]],
  [55, ["provider_run_ownership"]],
] as const;

export interface DatabaseRecoveryReport {
  readonly checkedAt: string;
  readonly outcome: "healthy" | "first-launch" | "restored" | "created-empty";
  readonly trigger: "none" | "primary-missing" | "primary-corrupt";
  readonly restoredBackup: string | null;
  readonly preservedCorruptPrimary: boolean;
  readonly invalidBackupsSkipped: number;
  readonly unsupportedBackupsSkipped: number;
}

export interface DatabaseRecoveryPaths {
  readonly backupsDirectory: string;
  readonly corruptDirectory: string;
  readonly databasePath: string;
  readonly recoveryDirectory: string;
  readonly restorePartialPath: string;
}

export interface DatabaseRecoveryOptions {
  readonly now?: () => Date;
}

export interface DatabaseBackupOptions {
  readonly initialDelayMs?: number;
  readonly quietGraceMs?: number;
  readonly retryDelayMs?: number;
  readonly maxInitialRetries?: number;
  readonly intervalMs?: number;
  readonly maxBackups?: number;
  readonly maxTotalBytes?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly onCreated?: (result: DatabaseBackupResult) => void;
  /** Initial backups must not begin while the runtime is in an interaction path. */
  readonly canStartBackup?: () => boolean;
  readonly validateBackup?: (
    path: string,
    signal: AbortSignal,
  ) => Promise<DatabaseValidation>;
}

export interface DatabaseBackupResult {
  readonly createdAt: string;
  readonly filename: string;
  readonly size: number;
}

export interface DatabaseBackupStatus {
  readonly lastValidatedAt: string | null;
}

interface ValidatedBackup {
  readonly filename: string;
  readonly modifiedAt: number;
  readonly path: string;
  readonly size: number;
}

export type DatabaseValidation =
  | "valid-current"
  | "unsupported-future"
  | "corrupt";

type AutomaticBackupTrigger = "hourly" | "initial" | "retry";
type DatabaseSchemaValidator = (database: Database.Database) => boolean;

export class DatabaseBackupCancelledError extends Error {
  constructor() {
    super("The database backup was cancelled.");
    this.name = "DatabaseBackupCancelledError";
  }
}

function safeDatabaseStem(databasePath: string): string {
  const raw = basename(databasePath, extname(databasePath));
  return /^[A-Za-z0-9_-]{1,80}$/u.test(raw) ? raw : "inertia";
}

function escapedRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function backupPattern(databasePath: string, partial = false): RegExp {
  return new RegExp(
    `^${escapedRegularExpression(safeDatabaseStem(databasePath))}-[0-9TZ]+(?:-[0-9]+)?\\.sqlite${partial ? "\\.partial" : ""}$`,
    "u",
  );
}

function partialBackupPattern(databasePath: string): RegExp {
  return backupPattern(databasePath, true);
}

function ensureOwnedDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The database recovery path is not a local directory.");
  }
  chmodSync(path, DIRECTORY_MODE);
}

function validateOpenDatabase(
  database: Database.Database,
  check: "quick_check" | "integrity_check",
  currentSchemaVersion: number,
  requiredTablesBySchemaVersion: readonly (
    readonly [number, readonly string[]]
  )[],
  providerRunOwnershipSchemaIsValid: DatabaseSchemaValidator,
  attachmentCapabilitiesAreValid: DatabaseSchemaValidator,
  usageDashboardIndexIsValid: DatabaseSchemaValidator,
): DatabaseValidation {
  const integrityResult = database.prepare(`PRAGMA ${check}`).get() as
    | Record<string, unknown>
    | undefined;
  if (Object.values(integrityResult ?? {})[0] !== "ok") return "corrupt";
  const tables = new Set(
    (database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as Array<{ name: string }>).map(({ name }) => name),
  );
  if (!tables.has("schema_migrations")) return "corrupt";
  const versions = database.prepare(
    "SELECT version FROM schema_migrations ORDER BY version ASC",
  ).all() as Array<{ version: unknown }>;
  if (
    versions.length < 1
    || versions.some(({ version }, index) =>
      typeof version !== "number"
      || !Number.isSafeInteger(version)
      || version !== index + 1)
  ) return "corrupt";
  const version = versions.length;
  if (version > currentSchemaVersion) return "unsupported-future";
  if (database.prepare("PRAGMA foreign_key_check").get()) return "corrupt";
  for (const [introducedAt, requiredTables] of requiredTablesBySchemaVersion) {
    if (
      version >= introducedAt
      && requiredTables.some((table) => !tables.has(table))
    ) return "corrupt";
  }
  const requiredColumns: Record<string, readonly string[]> = {
    projects: ["id", "name", "path"],
    conversations: ["id", "project_id"],
    messages: ["id", "conversation_id", "content"],
    app_state: ["id"],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const existing = new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (columns.some((column) => !existing.has(column))) return "corrupt";
  }
  if (version >= 42) {
    if (!tables.has("agent_reasonings")) return "corrupt";
    const reasoningColumns = new Set(
      (database.prepare("PRAGMA table_info(agent_reasonings)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (["id", "conversation_id", "content"].some(
      (column) => !reasoningColumns.has(column),
    )) return "corrupt";
    for (const [table, columns] of [
      ["message_content_chunks", ["sequence", "message_id", "content"]],
      ["reasoning_content_chunks", ["sequence", "reasoning_id", "content"]],
    ] as const) {
      if (!tables.has(table)) return "corrupt";
      const existing = new Set(
        (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map(({ name }) => name),
      );
      if (columns.some((column) => !existing.has(column))) return "corrupt";
    }
    const indexes = new Set(
      (database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
      ).all() as Array<{ name: string }>).map(({ name }) => name),
    );
    if (
      !indexes.has("message_content_chunks_message_sequence_idx")
      || !indexes.has("reasoning_content_chunks_reasoning_sequence_idx")
    ) return "corrupt";
  }
  if (version >= 43) {
    if (
      !tables.has("recovery_import_receipts")
      || !tables.has("recovery_import_journals")
    ) return "corrupt";
    const receiptColumns = new Set(
      (database.prepare("PRAGMA table_info(recovery_import_receipts)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if ([
      "digest",
      "projects",
      "conversations",
      "messages",
      "imported_at",
    ].some((column) => !receiptColumns.has(column))) return "corrupt";
    const journalColumns = new Set(
      (database.prepare("PRAGMA table_info(recovery_import_journals)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if ([
      "singleton",
      "operation_id",
      "digest",
      "authorized_root",
      "authorized_root_device",
      "authorized_root_inode",
      "projects",
      "created_at",
    ].some((column) => !journalColumns.has(column))) return "corrupt";
  }
  if (version >= 44) {
    for (const table of [
      "message_content_chunks",
      "reasoning_content_chunks",
    ]) {
      const definition = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table) as { sql: unknown } | undefined;
      const normalized = typeof definition?.sql === "string"
        ? definition.sql.replace(/\s+/gu, "").toLowerCase()
        : "";
      if (!normalized.includes(
        "check(length(cast(contentasblob))between1and4194304)",
      )) return "corrupt";
    }
  }
  if (version >= 47) {
    const conversationColumns = new Set(
      (database.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    const stateColumns = new Set(
      (database.prepare("PRAGMA table_info(app_state)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (
      ["pinned_at", "snoozed_until"].some(
        (column) => !conversationColumns.has(column),
      )
      || !stateColumns.has("desktop_notifications")
    ) return "corrupt";
    const indexes = new Set(
      (database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
      ).all() as Array<{ name: string }>).map(({ name }) => name),
    );
    if (
      !indexes.has("conversations_pinned_at_idx")
      || !indexes.has("conversations_snoozed_until_idx")
    ) return "corrupt";
  }
  if (version >= 48) {
    const stateColumns = new Set(
      (database.prepare("PRAGMA table_info(app_state)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (!stateColumns.has("provider_identity_labels_json")) return "corrupt";
  }
  if (version >= 49) {
    const stateColumns = new Set(
      (database.prepare("PRAGMA table_info(app_state)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (!stateColumns.has("keybindings_json")) return "corrupt";
  }
  if (version >= 52) {
    const ownershipColumns = new Set(
      (database.prepare(
        "PRAGMA table_info(conversation_worktree_ownership)",
      ).all() as Array<{ name: string }>).map(({ name }) => name),
    );
    if ([
      "conversation_id",
      "path",
      "branch",
      "owns_worktree",
      "creation_state",
      "ownership_token",
      "worktree_id",
      "repository_identity",
      "filesystem_identity_json",
      "branch_head",
    ].some((column) => !ownershipColumns.has(column))) return "corrupt";
    const ownershipTrigger = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'conversation_worktree_ownership_project_delete'
    `).get() as { sql: unknown } | undefined;
    const normalizedOwnershipTrigger = typeof ownershipTrigger?.sql === "string"
      ? ownershipTrigger.sql.replace(/\s+/gu, " ").toLowerCase()
      : "";
    if (
      !normalizedOwnershipTrigger.includes("before delete on projects")
      || !normalizedOwnershipTrigger.includes("ownership.owns_worktree = 1")
      || !/raise\s*\(\s*abort/u.test(normalizedOwnershipTrigger)
    ) return "corrupt";
  }
  if (version >= 53) {
    for (const table of [
      "project_path_authorities",
      "conversation_path_authorities",
    ]) {
      const authorityColumns = new Set(
        (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>).map(({ name }) => name),
      );
      const subjectColumn = table === "project_path_authorities"
        ? "project_id"
        : "conversation_id";
      if ([subjectColumn, "path", "receipt_json"].some(
        (column) => !authorityColumns.has(column),
      )) return "corrupt";
    }
    const enrollmentColumns = new Set(
      (database.prepare(
        "PRAGMA table_info(workspace_path_authority_enrollment)",
      ).all() as Array<{ name: string }>).map(({ name }) => name),
    );
    if (["id", "completed"].some(
      (column) => !enrollmentColumns.has(column),
    )) return "corrupt";
    const enrollment = database.prepare(`
      SELECT id, completed FROM workspace_path_authority_enrollment
    `).all() as Array<{ id: number; completed: number }>;
    if (
      enrollment.length !== 1
      || enrollment[0]?.id !== 1
      || ![0, 1].includes(enrollment[0].completed)
    ) return "corrupt";
  }
  if (version >= 54) {
    const promptPresetColumns = new Set(
      (database.prepare("PRAGMA table_info(prompt_presets)").all() as Array<{
        name: string;
      }>).map(({ name }) => name),
    );
    if ([
      "id",
      "name",
      "body",
      "route_json",
      "position",
      "revision",
      "created_at",
      "updated_at",
    ].some((column) => !promptPresetColumns.has(column))) return "corrupt";
    const promptPresetIndex = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'index' AND name = 'prompt_presets_position_idx'
    `).get();
    if (!promptPresetIndex) return "corrupt";
    const promptPresetTrigger = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'prompt_presets_count_limit'
    `).get() as { sql: unknown } | undefined;
    const normalizedPromptPresetTrigger =
      typeof promptPresetTrigger?.sql === "string"
        ? promptPresetTrigger.sql.replace(/\s+/gu, " ").toLowerCase()
        : "";
    if (
      !normalizedPromptPresetTrigger.includes("before insert on prompt_presets")
      || !normalizedPromptPresetTrigger.includes("count(*) from prompt_presets")
      || !/raise\s*\(\s*abort/u.test(normalizedPromptPresetTrigger)
    ) return "corrupt";
  }
  if (version >= 55 && !providerRunOwnershipSchemaIsValid(database)) {
    return "corrupt";
  }
  if (version >= 56 && !attachmentCapabilitiesAreValid(database)) {
    return "corrupt";
  }
  if (version >= 57 && !usageDashboardIndexIsValid(database)) return "corrupt";
  return "valid-current";
}

function validateDatabase(
  path: string,
  check: "quick_check" | "integrity_check",
): DatabaseValidation {
  if (!regularOwnedFile(path)) return "corrupt";
  let database: Database.Database | null = null;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    return validateOpenDatabase(
      database,
      check,
      CURRENT_DATABASE_SCHEMA_VERSION,
      REQUIRED_TABLES_BY_SCHEMA_VERSION,
      validProviderRunOwnershipSchema,
      validAttachmentCapabilities,
      validUsageDashboardIndex,
    );
  } catch {
    return "corrupt";
  } finally {
    if (database?.open) database.close();
  }
}

function validateDatabaseOffThread(
  path: string,
  signal: AbortSignal,
): Promise<DatabaseValidation> {
  if (!regularOwnedFile(path)) return Promise.resolve("corrupt");
  if (signal.aborted) return Promise.reject(new DatabaseBackupCancelledError());
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const indexColumns = ${indexColumns.toString()};
    const validProviderRunOwnershipSchema = ${validProviderRunOwnershipSchema.toString()};
    const validAttachmentCapabilities = ${validAttachmentCapabilities.toString()};
    const validUsageDashboardIndex = ${validUsageDashboardIndex.toString()};
    const validate = ${validateOpenDatabase.toString()};
    let database = null;
    let result = "corrupt";
    try {
      database = new DatabaseSync(workerData.path, { readOnly: true });
      result = validate(
        database,
        "integrity_check",
        workerData.currentSchemaVersion,
        workerData.requiredTablesBySchemaVersion,
        validProviderRunOwnershipSchema,
        validAttachmentCapabilities,
        validUsageDashboardIndex,
      );
    } catch {
      result = "corrupt";
    } finally {
      if (database) database.close();
    }
    // Receipt follows handle closure: Windows cannot publish the validated
    // partial while any worker still holds the SQLite file open.
    parentPort.postMessage({ result });
    parentPort.close();
  `;
  return new Promise<DatabaseValidation>((resolveValidation, rejectValidation) => {
    const worker = new Worker(workerSource, {
      eval: true,
      execArgv: ["--no-warnings"],
      workerData: {
        currentSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
        path,
        requiredTablesBySchemaVersion: REQUIRED_TABLES_BY_SCHEMA_VERSION,
      },
    });
    let receivedResult: DatabaseValidation | undefined;
    let settled = false;
    let stopping = false;
    const finish = (error: unknown, result?: DatabaseValidation): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (error !== undefined) rejectValidation(error);
      else resolveValidation(result ?? "corrupt");
    };
    const stop = (error: unknown): void => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      // Worker.terminate() resolves only after the thread has exited. Do not
      // report validator settlement while Windows may still hold SQLite open.
      // Cancellation is raced by the backup manager, so this worker must not
      // keep a shutting-down runtime process alive while native SQLite exits.
      worker.unref();
      void worker.terminate().then(
        () => finish(error),
        (terminationError: unknown) => finish(terminationError),
      );
    };
    const cancel = (): void => stop(new DatabaseBackupCancelledError());
    const timer = setTimeout(
      () => stop(new Error("The database backup validation timed out.")),
      DATABASE_BACKUP_VALIDATION_TIMEOUT_MS,
    );
    timer.unref();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    worker.once("message", (message: unknown) => {
      const result = (
        message
        && typeof message === "object"
        && "result" in message
        && (
          message.result === "valid-current"
          || message.result === "unsupported-future"
          || message.result === "corrupt"
        )
      ) ? message.result : "corrupt";
      receivedResult = result;
    });
    worker.once("error", (error) => stop(error));
    worker.once("exit", (code) => {
      if (stopping) return;
      if (code !== 0 || receivedResult === undefined) {
        finish(new Error("The database backup validator stopped unexpectedly."));
        return;
      }
      finish(undefined, receivedResult);
    });
  });
}

function listValidatedBackups(databasePath: string): {
  invalid: string[];
  unsupported: string[];
  valid: ValidatedBackup[];
} {
  const { backupsDirectory } = databaseRecoveryPaths(databasePath);
  if (!existsSync(backupsDirectory)) {
    return { invalid: [], unsupported: [], valid: [] };
  }
  const pattern = backupPattern(databasePath);
  const invalid: string[] = [];
  const unsupported: string[] = [];
  const valid: ValidatedBackup[] = [];
  for (const filename of readdirSync(backupsDirectory)) {
    if (!pattern.test(filename)) continue;
    const path = join(backupsDirectory, filename);
    const validation = validateDatabase(path, "integrity_check");
    if (validation === "unsupported-future") {
      unsupported.push(path);
      continue;
    }
    if (validation !== "valid-current") {
      invalid.push(path);
      continue;
    }
    const metadata = statSync(path);
    valid.push({
      filename,
      modifiedAt: metadata.mtimeMs,
      path,
      size: metadata.size,
    });
  }
  valid.sort((left, right) =>
    right.modifiedAt - left.modifiedAt
    || right.filename.localeCompare(left.filename));
  return { invalid, unsupported, valid };
}

function listBackupMetadata(databasePath: string): ValidatedBackup[] {
  const { backupsDirectory } = databaseRecoveryPaths(databasePath);
  if (!existsSync(backupsDirectory)) return [];
  const pattern = backupPattern(databasePath);
  const backups: ValidatedBackup[] = [];
  for (const filename of readdirSync(backupsDirectory)) {
    if (!pattern.test(filename)) continue;
    const path = join(backupsDirectory, filename);
    if (!regularOwnedFile(path)) continue;
    try {
      const metadata = statSync(path);
      backups.push({
        filename,
        modifiedAt: metadata.mtimeMs,
        path,
        size: metadata.size,
      });
    } catch {
      // A concurrently removed backup is no longer part of retention.
    }
  }
  backups.sort((left, right) =>
    right.modifiedAt - left.modifiedAt
    || right.filename.localeCompare(left.filename));
  return backups;
}

function isUnsupportedFutureDatabase(path: string): boolean {
  if (!regularOwnedFile(path)) return false;
  let database: Database.Database | null = null;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    const hasMigrations = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get();
    if (!hasMigrations) return false;
    const versions = database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    ).all() as Array<{ version: unknown }>;
    return versions.length > CURRENT_DATABASE_SCHEMA_VERSION
      && versions.every(({ version }, index) =>
        typeof version === "number"
        && Number.isSafeInteger(version)
        && version === index + 1);
  } catch {
    return false;
  } finally {
    if (database?.open) database.close();
  }
}

function compactTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/gu, "");
}

function availableName(directory: string, stem: string, suffix: string): string {
  let index = 0;
  while (true) {
    const filename = `${stem}${index === 0 ? "" : `-${index}`}${suffix}`;
    if (!existsSync(join(directory, filename))) return filename;
    index += 1;
  }
}

function cleanInterruptedFiles(databasePath: string): void {
  const paths = databaseRecoveryPaths(databasePath);
  removeDatabaseFileFamily(paths.restorePartialPath);
  if (!existsSync(paths.backupsDirectory)) return;
  const partialPattern = partialBackupPattern(databasePath);
  for (const filename of readdirSync(paths.backupsDirectory)) {
    if (partialPattern.test(filename)) {
      removeDatabaseFileFamily(join(paths.backupsDirectory, filename));
    }
  }
}

function quarantinePrimary(
  databasePath: string,
  now: Date,
): boolean {
  const { corruptDirectory } = databaseRecoveryPaths(databasePath);
  ensureOwnedDirectory(corruptDirectory);
  const timestamp = compactTimestamp(now);
  let preserved = false;
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const source = `${databasePath}${suffix}`;
    if (!existsSync(source)) continue;
    if (!regularOwnedFile(source)) {
      throw new Error("The database recovery source is not a local file.");
    }
    const targetName = availableName(
      corruptDirectory,
      `${safeDatabaseStem(databasePath)}-${timestamp}`,
      `.sqlite${suffix}`,
    );
    renameSync(source, join(corruptDirectory, targetName));
    chmodSync(join(corruptDirectory, targetName), FILE_MODE);
    if (suffix === "") preserved = true;
  }
  return preserved;
}

function restoreBackup(databasePath: string, backup: ValidatedBackup): void {
  const { restorePartialPath } = databaseRecoveryPaths(databasePath);
  removeIfRegularFile(restorePartialPath);
  copyFileSync(backup.path, restorePartialPath, constants.COPYFILE_EXCL);
  chmodSync(restorePartialPath, FILE_MODE);
  if (validateDatabase(restorePartialPath, "integrity_check") !== "valid-current") {
    removeIfRegularFile(restorePartialPath);
    throw new Error("The selected database backup failed restore validation.");
  }
  renameSync(restorePartialPath, databasePath);
  chmodSync(databasePath, FILE_MODE);
}

function persistRecoveryReport(
  databasePath: string,
  report: DatabaseRecoveryReport,
): void {
  if (report.outcome === "healthy" || report.outcome === "first-launch") return;
  const { recoveryDirectory } = databaseRecoveryPaths(databasePath);
  ensureOwnedDirectory(recoveryDirectory);
  const finalPath = join(recoveryDirectory, "last-database-recovery.json");
  const partialPath = `${finalPath}.partial`;
  removeIfRegularFile(partialPath);
  const payload = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(partialPath, payload, { flag: "wx", mode: FILE_MODE });
  renameSync(partialPath, finalPath);
  chmodSync(finalPath, FILE_MODE);
}

export function databaseRecoveryPaths(databasePath: string): DatabaseRecoveryPaths {
  const resolvedDatabasePath = resolve(databasePath);
  const parent = dirname(resolvedDatabasePath);
  return {
    backupsDirectory: join(parent, "backups"),
    corruptDirectory: join(parent, "corrupt"),
    databasePath: resolvedDatabasePath,
    recoveryDirectory: join(parent, "recovery"),
    restorePartialPath: `${resolvedDatabasePath}.restore.partial`,
  };
}

export function recoverDatabaseOnStartup(
  databasePath: string,
  options: DatabaseRecoveryOptions = {},
): DatabaseRecoveryReport {
  const now = options.now?.() ?? new Date();
  const paths = databaseRecoveryPaths(databasePath);
  ensureOwnedDirectory(dirname(paths.databasePath));
  ensureOwnedDirectory(paths.backupsDirectory);
  cleanInterruptedFiles(paths.databasePath);

  const primaryExists = existsSync(paths.databasePath);
  if (primaryExists && !regularOwnedFile(paths.databasePath)) {
    throw new Error("The database path is not a local file.");
  }
  if (!primaryExists && listBackupMetadata(paths.databasePath).length === 0) {
    return {
      checkedAt: now.toISOString(),
      outcome: "first-launch",
      trigger: "none",
      restoredBackup: null,
      preservedCorruptPrimary: false,
      invalidBackupsSkipped: 0,
      unsupportedBackupsSkipped: 0,
    };
  }
  const primaryValidation = primaryExists
    ? validateDatabase(paths.databasePath, "quick_check")
    : "corrupt";
  if (primaryValidation === "unsupported-future") {
    throw new Error(
      "The database was created by a newer version of Inertia and was left unchanged.",
    );
  }
  if (primaryValidation === "valid-current") {
    return {
      checkedAt: now.toISOString(),
      outcome: "healthy",
      trigger: "none",
      restoredBackup: null,
      preservedCorruptPrimary: false,
      invalidBackupsSkipped: 0,
      unsupportedBackupsSkipped: 0,
    };
  }

  const trigger = primaryExists ? "primary-corrupt" : "primary-missing";
  const preservedCorruptPrimary = quarantinePrimary(paths.databasePath, now);
  const backups = listValidatedBackups(paths.databasePath);
  const selected = backups.valid[0];
  if (selected) restoreBackup(paths.databasePath, selected);
  for (const invalid of backups.invalid) removeIfRegularFile(invalid);
  const report: DatabaseRecoveryReport = {
    checkedAt: now.toISOString(),
    outcome: selected ? "restored" : "created-empty",
    trigger,
    restoredBackup: selected?.filename ?? null,
    preservedCorruptPrimary,
    invalidBackupsSkipped: backups.invalid.length,
    unsupportedBackupsSkipped: backups.unsupported.length,
  };
  persistRecoveryReport(paths.databasePath, report);
  return report;
}

export class DatabaseBackupManager {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private automaticTimer: NodeJS.Timeout | null = null;
  private automaticTimerDeadline = 0;
  private inFlight: Promise<DatabaseBackupResult> | null = null;
  private inFlightAbort: AbortController | null = null;
  private started = false;
  private initialBackupComplete = false;
  private initialEligible = false;
  private automaticRetryAttempt = 0;
  private automaticObservedOperation: Promise<DatabaseBackupResult> | null = null;
  private readonly pendingAutomaticTriggers = new Set<AutomaticBackupTrigger>();
  private lastPublicationAt = Number.NEGATIVE_INFINITY;
  private quietUntil = 0;
  private retryNotBefore = 0;
  private pendingInitial:
    { promise: Promise<DatabaseBackupResult | null>; resolve: (result: DatabaseBackupResult | null) => void; reject: (error: unknown) => void } | null = null;
  private lastValidatedAt: string | null;

  constructor(
    private readonly database: Database.Database,
    private readonly databasePath: string,
    private readonly options: DatabaseBackupOptions = {},
  ) {
    // A filename and mtime prove only that a previous process left a file.
    // Do not label it as validated until this manager has completed the full
    // integrity/schema check for a newly written backup.
    this.lastValidatedAt = null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleInitialBackup();
    const intervalMs = Math.max(
      1_000,
      Math.trunc(this.options.intervalMs ?? DATABASE_BACKUP_INTERVAL_MS),
    );
    this.timer = setInterval(() => {
      this.requestAutomaticBackup("hourly");
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.started = false;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    this.clearAutomaticTimer();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  createBackup(): Promise<DatabaseBackupResult> {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.inFlight) {
      if (this.pendingAutomaticTriggers.size > 0) {
        this.observeAutomaticOperation(this.inFlight);
      }
      return this.inFlight;
    }
    const controller = new AbortController();
    const operation = this.createBackupOnce(controller.signal);
    this.inFlight = operation;
    this.inFlightAbort = controller;
    void operation.finally(() => {
      if (this.inFlight === operation) {
        this.inFlight = null;
        this.inFlightAbort = null;
        if (!this.initialBackupComplete && !this.initialEligible) {
          this.scheduleInitialBackup();
        }
      }
    }).catch(() => undefined);
    if (this.pendingAutomaticTriggers.size > 0) {
      this.observeAutomaticOperation(operation);
    }
    return operation;
  }

  createInitialBackup(): Promise<DatabaseBackupResult | null> {
    return this.requestInitialBackup();
  }

  /**
   * Marks the initial backup eligible without making the settlement path wait.
   * A caller may provide a small grace period after the last active turn.
   */
  requestInitialBackup(quietGraceMs = 0): Promise<DatabaseBackupResult | null> {
    if (quietGraceMs > 0) this.restartQuietGrace(quietGraceMs);
    if (this.initialBackupComplete) return Promise.resolve(null);
    if (!this.initialEligible) this.automaticRetryAttempt = 0;
    this.initialEligible = true;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    const pending = this.pendingInitial ?? this.createPendingInitial();
    this.requestAutomaticBackup("initial");
    return pending.promise;
  }

  status(): DatabaseBackupStatus {
    return { lastValidatedAt: this.lastValidatedAt };
  }

  async cancelAndWait(): Promise<void> {
    this.stop();
    this.pendingAutomaticTriggers.clear();
    this.quietUntil = 0;
    this.retryNotBefore = 0;
    this.rejectPendingInitial(new DatabaseBackupCancelledError());
    const operation = this.inFlight;
    this.inFlightAbort?.abort();
    if (!operation) return;
    try {
      await operation;
    } catch (error) {
      if (!(error instanceof DatabaseBackupCancelledError)) throw error;
    }
  }

  private async createBackupOnce(signal: AbortSignal): Promise<DatabaseBackupResult> {
    if (!this.database.open) throw new Error("The database is closed.");
    const paths = databaseRecoveryPaths(this.databasePath);
    ensureOwnedDirectory(paths.backupsDirectory);
    cleanInterruptedFiles(paths.databasePath);
    const createdAt = this.options.now?.() ?? new Date();
    const filename = availableName(
      paths.backupsDirectory,
      `${safeDatabaseStem(paths.databasePath)}-${compactTimestamp(createdAt)}`,
      ".sqlite",
    );
    const finalPath = join(paths.backupsDirectory, filename);
    const partialPath = `${finalPath}.partial`;
    try {
      await this.database.backup(partialPath, {
        progress: () => {
          if (signal.aborted) throw new DatabaseBackupCancelledError();
          return 100;
        },
      });
      if (signal.aborted) throw new DatabaseBackupCancelledError();
      chmodSync(partialPath, FILE_MODE);
      const validationOperation = (
        this.options.validateBackup ?? validateDatabaseOffThread
      )(partialPath, signal);
      const validation = await waitForOperationOrAbort(
        validationOperation,
        signal,
        () => new DatabaseBackupCancelledError(),
      );
      if (validation !== "valid-current") {
        throw new Error("The database backup failed validation.");
      }
      if (signal.aborted) throw new DatabaseBackupCancelledError();
      renameSync(partialPath, finalPath);
      chmodSync(finalPath, FILE_MODE);
      this.prune(finalPath);
      const result = {
        createdAt: createdAt.toISOString(),
        filename,
        size: statSync(finalPath).size,
      };
      this.lastValidatedAt = result.createdAt;
      this.lastPublicationAt = Date.now();
      this.initialBackupComplete = true;
      this.initialEligible = false;
      this.automaticRetryAttempt = 0;
      this.retryNotBefore = 0;
      this.resolvePendingInitial(result);
      try {
        this.options.onCreated?.(result);
      } catch (error) {
        this.options.onError?.(error);
      }
      return result;
    } catch (error) {
      removeInterruptedDatabaseFileFamily(partialPath);
      throw error;
    }
  }

  private scheduleInitialBackup(): void {
    if (
      !this.started
      || this.initialBackupComplete
      || this.initialTimer
      || this.inFlight
    ) return;
    const delayMs = Math.max(
      1_000,
      Math.trunc(
        this.options.initialDelayMs ?? DATABASE_INITIAL_BACKUP_QUIET_MS,
      ),
    );
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.requestInitialBackup().catch((error: unknown) => {
        if (error instanceof DatabaseBackupCancelledError) return;
      });
    }, delayMs);
    this.initialTimer.unref();
  }

  private createPendingInitial(): NonNullable<DatabaseBackupManager["pendingInitial"]> {
    let resolve!: (result: DatabaseBackupResult | null) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<DatabaseBackupResult | null>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pendingInitial = { promise, resolve, reject };
    return this.pendingInitial;
  }

  private resolvePendingInitial(result: DatabaseBackupResult | null): void {
    const pending = this.pendingInitial;
    this.pendingInitial = null;
    pending?.resolve(result);
  }

  private rejectPendingInitial(error: unknown): void {
    const pending = this.pendingInitial;
    this.pendingInitial = null;
    pending?.reject(error);
  }

  private requestAutomaticBackup(trigger: AutomaticBackupTrigger): void {
    if (!this.started) return;
    if (trigger === "initial" && this.initialBackupComplete) return;
    if (Date.now() - this.lastPublicationAt < this.quietGraceMs()) return;
    if (this.pendingAutomaticTriggers.size === 0 && trigger !== "retry") {
      this.automaticRetryAttempt = 0;
      this.retryNotBefore = 0;
    }
    this.pendingAutomaticTriggers.add(trigger);
    this.tryStartAutomaticBackup();
  }

  private tryStartAutomaticBackup(): void {
    if (!this.started || this.pendingAutomaticTriggers.size === 0) return;
    if (this.inFlight) {
      this.observeAutomaticOperation(this.inFlight);
      return;
    }
    const now = Date.now();
    const notBefore = Math.max(this.quietUntil, this.retryNotBefore);
    if (now < notBefore) {
      this.scheduleAutomaticWake(notBefore);
      return;
    }
    if (this.options.canStartBackup && !this.options.canStartBackup()) {
      this.scheduleAutomaticWake(now + this.quietGraceMs());
      return;
    }
    this.clearAutomaticTimer();
    this.observeAutomaticOperation(this.createBackup());
  }

  private observeAutomaticOperation(
    operation: Promise<DatabaseBackupResult>,
  ): void {
    if (this.automaticObservedOperation === operation) return;
    this.automaticObservedOperation = operation;
    void operation.then(
      (result) => {
        if (this.automaticObservedOperation === operation) {
          this.automaticObservedOperation = null;
        }
        this.pendingAutomaticTriggers.clear();
        this.clearAutomaticTimer();
        this.resolvePendingInitial(result);
      },
      (error: unknown) => {
        if (this.automaticObservedOperation === operation) {
          this.automaticObservedOperation = null;
        }
        if (error instanceof DatabaseBackupCancelledError) {
          this.pendingAutomaticTriggers.clear();
          this.rejectPendingInitial(error);
          return;
        }
        this.options.onError?.(error);
        this.automaticRetryAttempt += 1;
        if (
          this.started
          && this.automaticRetryAttempt <= this.maxInitialRetries()
        ) {
          this.pendingAutomaticTriggers.add("retry");
          this.retryNotBefore = Date.now() + this.retryDelayMs();
          this.scheduleAutomaticWake(
            Math.max(this.quietUntil, this.retryNotBefore),
            true,
          );
        } else {
          this.initialEligible = false;
          this.pendingAutomaticTriggers.clear();
          this.retryNotBefore = 0;
        }
        this.rejectPendingInitial(error);
      },
    );
  }

  private restartQuietGrace(delayMs: number): void {
    this.quietUntil = Date.now() + Math.max(1_000, Math.trunc(delayMs));
    if (
      this.started
      && this.pendingAutomaticTriggers.size > 0
      && !this.inFlight
    ) {
      this.scheduleAutomaticWake(
        Math.max(this.quietUntil, this.retryNotBefore),
        true,
      );
    }
  }

  private scheduleAutomaticWake(deadline: number, replace = false): void {
    if (!this.started || this.pendingAutomaticTriggers.size === 0 || this.inFlight) return;
    const normalizedDeadline = Math.max(Date.now(), Math.trunc(deadline));
    if (this.automaticTimer) {
      if (!replace && this.automaticTimerDeadline <= normalizedDeadline) return;
      clearTimeout(this.automaticTimer);
    }
    this.automaticTimerDeadline = normalizedDeadline;
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = null;
      this.automaticTimerDeadline = 0;
      this.tryStartAutomaticBackup();
    }, Math.max(0, normalizedDeadline - Date.now()));
    this.automaticTimer.unref();
  }

  private clearAutomaticTimer(): void {
    if (this.automaticTimer) clearTimeout(this.automaticTimer);
    this.automaticTimer = null;
    this.automaticTimerDeadline = 0;
  }

  private quietGraceMs(): number {
    return Math.max(
      1_000,
      Math.trunc(this.options.quietGraceMs ?? DATABASE_INITIAL_BACKUP_GRACE_MS),
    );
  }

  private retryDelayMs(): number {
    const configured = Math.max(
      1_000,
      Math.trunc(this.options.retryDelayMs ?? DATABASE_INITIAL_BACKUP_RETRY_MS),
    );
    return Math.min(configured * 2 ** Math.min(this.automaticRetryAttempt - 1, 5), 5 * 60 * 1_000);
  }

  private maxInitialRetries(): number {
    return Math.max(
      0,
      Math.trunc(this.options.maxInitialRetries ?? DATABASE_INITIAL_BACKUP_MAX_RETRIES),
    );
  }

  private prune(protectedPath: string): void {
    const paths = databaseRecoveryPaths(this.databasePath);
    const maxBackups = Math.max(
      1,
      Math.trunc(this.options.maxBackups ?? DATABASE_BACKUP_MAX_COUNT),
    );
    const maxTotalBytes = Math.max(
      1,
      Math.trunc(
        this.options.maxTotalBytes ?? DATABASE_BACKUP_MAX_TOTAL_BYTES,
      ),
    );
    // The just-created file was already integrity-checked off-thread. Existing
    // files only need a small schema-history read here so downgrade runs never
    // delete future-version backups; full validation remains a startup task.
    const retained = listBackupMetadata(paths.databasePath)
      .filter((backup) =>
        backup.path === protectedPath
        || !isUnsupportedFutureDatabase(backup.path));
    let totalBytes = retained.reduce((sum, backup) => sum + backup.size, 0);
    while (
      retained.length > 1
      && (
        retained.length > maxBackups
        || totalBytes > maxTotalBytes
      )
    ) {
      let oldestIndex = retained.length - 1;
      while (
        oldestIndex >= 0
        && retained[oldestIndex]?.path === protectedPath
      ) oldestIndex -= 1;
      if (oldestIndex < 0) break;
      const [oldest] = retained.splice(oldestIndex, 1);
      if (!oldest) break;
      removeIfRegularFile(oldest.path);
      totalBytes -= oldest.size;
    }
  }
}
