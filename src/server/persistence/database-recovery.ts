import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import { CURRENT_DATABASE_SCHEMA_VERSION } from "./migrations/catalog";

export const DATABASE_BACKUP_INTERVAL_MS = 60 * 60 * 1_000;
export const DATABASE_BACKUP_MAX_COUNT = 5;
export const DATABASE_BACKUP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const DATABASE_BACKUP_VALIDATION_TIMEOUT_MS = 120_000;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

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
  readonly intervalMs?: number;
  readonly maxBackups?: number;
  readonly maxTotalBytes?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
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

export class DatabaseBackupCancelledError extends Error {
  constructor() {
    super("The database backup was cancelled.");
    this.name = "DatabaseBackupCancelledError";
  }
}

const betterSqlite3ModulePath = createRequire(import.meta.url)
  .resolve("better-sqlite3");

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

function regularOwnedFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function removeIfRegularFile(path: string): void {
  if (regularOwnedFile(path)) unlinkSync(path);
}

function validateOpenDatabase(
  database: Database.Database,
  check: "quick_check" | "integrity_check",
  currentSchemaVersion: number,
): DatabaseValidation {
  if (database.pragma(check, { simple: true }) !== "ok") return "corrupt";
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
  for (const table of [
    "projects",
    "conversations",
    "messages",
    "app_state",
  ]) {
    if (!tables.has(table)) return "corrupt";
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
  if (version >= 38) {
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
  if (version >= 39) {
    if (!tables.has("recovery_import_receipts")) return "corrupt";
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
  }
  if (version >= 40) {
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
    const Database = require(workerData.modulePath);
    const validate = ${validateOpenDatabase.toString()};
    let database = null;
    let result = "corrupt";
    try {
      database = new Database(workerData.path, { readonly: true, fileMustExist: true });
      result = validate(
        database,
        "integrity_check",
        workerData.currentSchemaVersion,
      );
    } catch {
      result = "corrupt";
    } finally {
      if (database && database.open) database.close();
    }
    // Receipt follows handle closure: Windows cannot publish the validated
    // partial while any worker still holds the SQLite file open.
    parentPort.postMessage({ result });
    parentPort.close();
  `;
  return new Promise<DatabaseValidation>((resolveValidation, rejectValidation) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        currentSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
        modulePath: betterSqlite3ModulePath,
        path,
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
      // release the backup operation while Windows may still hold SQLite open.
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
  removeIfRegularFile(paths.restorePartialPath);
  if (!existsSync(paths.backupsDirectory)) return;
  const partialPattern = partialBackupPattern(databasePath);
  for (const filename of readdirSync(paths.backupsDirectory)) {
    if (partialPattern.test(filename)) {
      removeIfRegularFile(join(paths.backupsDirectory, filename));
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
  copyFileSync(backup.path, restorePartialPath);
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
  private inFlight: Promise<DatabaseBackupResult> | null = null;
  private inFlightAbort: AbortController | null = null;

  constructor(
    private readonly database: Database.Database,
    private readonly databasePath: string,
    private readonly options: DatabaseBackupOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.max(
      1_000,
      Math.trunc(this.options.intervalMs ?? DATABASE_BACKUP_INTERVAL_MS),
    );
    this.timer = setInterval(() => {
      void this.createBackup().catch((error: unknown) => {
        this.options.onError?.(error);
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  createBackup(): Promise<DatabaseBackupResult> {
    if (this.inFlight) return this.inFlight;
    const controller = new AbortController();
    const operation = this.createBackupOnce(controller.signal);
    this.inFlight = operation;
    this.inFlightAbort = controller;
    void operation.finally(() => {
      if (this.inFlight === operation) {
        this.inFlight = null;
        this.inFlightAbort = null;
      }
    }).catch(() => undefined);
    return operation;
  }

  async cancelAndWait(): Promise<void> {
    this.stop();
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
      const validation = await (
        this.options.validateBackup ?? validateDatabaseOffThread
      )(partialPath, signal);
      if (validation !== "valid-current") {
        throw new Error("The database backup failed validation.");
      }
      if (signal.aborted) throw new DatabaseBackupCancelledError();
      renameSync(partialPath, finalPath);
      chmodSync(finalPath, FILE_MODE);
      this.prune(finalPath);
      return {
        createdAt: createdAt.toISOString(),
        filename,
        size: statSync(finalPath).size,
      };
    } catch (error) {
      removeIfRegularFile(partialPath);
      throw error;
    }
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
