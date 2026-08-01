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

import Database from "better-sqlite3";

import { CURRENT_DATABASE_SCHEMA_VERSION } from "./migrations/catalog";

export const DATABASE_BACKUP_INTERVAL_MS = 60 * 60 * 1_000;
export const DATABASE_BACKUP_MAX_COUNT = 5;
export const DATABASE_BACKUP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface DatabaseRecoveryReport {
  readonly checkedAt: string;
  readonly outcome: "healthy" | "restored" | "created-empty";
  readonly trigger: "none" | "primary-missing" | "primary-corrupt";
  readonly restoredBackup: string | null;
  readonly preservedCorruptPrimary: boolean;
  readonly invalidBackupsSkipped: number;
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

function schemaVersion(database: Database.Database): number | null {
  const table = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (!table) return null;
  const row = database.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
  ).get() as { version?: unknown } | undefined;
  return typeof row?.version === "number" && Number.isSafeInteger(row.version)
    ? row.version
    : null;
}

function validatesDatabase(
  path: string,
  check: "quick_check" | "integrity_check",
  requireKnownSchema: boolean,
): boolean {
  if (!regularOwnedFile(path)) return false;
  let database: Database.Database | null = null;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    const result = database.pragma(check, { simple: true });
    if (result !== "ok") return false;
    if (!requireKnownSchema) return true;
    const version = schemaVersion(database);
    return version !== null
      && version >= 1
      && version <= CURRENT_DATABASE_SCHEMA_VERSION;
  } catch {
    return false;
  } finally {
    if (database?.open) database.close();
  }
}

function listValidatedBackups(databasePath: string): {
  invalid: string[];
  valid: ValidatedBackup[];
} {
  const { backupsDirectory } = databaseRecoveryPaths(databasePath);
  if (!existsSync(backupsDirectory)) return { invalid: [], valid: [] };
  const pattern = backupPattern(databasePath);
  const invalid: string[] = [];
  const valid: ValidatedBackup[] = [];
  for (const filename of readdirSync(backupsDirectory)) {
    if (!pattern.test(filename)) continue;
    const path = join(backupsDirectory, filename);
    if (!validatesDatabase(path, "integrity_check", true)) {
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
  return { invalid, valid };
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
  if (!validatesDatabase(restorePartialPath, "integrity_check", true)) {
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
  if (report.outcome === "healthy") return;
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
  if (
    primaryExists
    && validatesDatabase(paths.databasePath, "quick_check", false)
  ) {
    return {
      checkedAt: now.toISOString(),
      outcome: "healthy",
      trigger: "none",
      restoredBackup: null,
      preservedCorruptPrimary: false,
      invalidBackupsSkipped: 0,
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
  };
  persistRecoveryReport(paths.databasePath, report);
  return report;
}

export class DatabaseBackupManager {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<DatabaseBackupResult> | null = null;

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
    const operation = this.createBackupOnce();
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    }).catch(() => undefined);
    return operation;
  }

  private async createBackupOnce(): Promise<DatabaseBackupResult> {
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
      await this.database.backup(partialPath);
      chmodSync(partialPath, FILE_MODE);
      if (!validatesDatabase(partialPath, "integrity_check", true)) {
        throw new Error("The database backup failed validation.");
      }
      renameSync(partialPath, finalPath);
      chmodSync(finalPath, FILE_MODE);
      this.prune();
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

  private prune(): void {
    const paths = databaseRecoveryPaths(this.databasePath);
    const backups = listValidatedBackups(paths.databasePath);
    for (const invalid of backups.invalid) removeIfRegularFile(invalid);
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
    const retained = [...backups.valid];
    let totalBytes = retained.reduce((sum, backup) => sum + backup.size, 0);
    while (
      retained.length > 1
      && (
        retained.length > maxBackups
        || totalBytes > maxTotalBytes
      )
    ) {
      const oldest = retained.pop();
      if (!oldest) break;
      removeIfRegularFile(oldest.path);
      totalBytes -= oldest.size;
    }
  }
}
