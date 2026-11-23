import { lstatSync, realpathSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import type Database from "better-sqlite3";

import {
  AUTO_COMPACT_MAX_FULL_VACUUM_BYTES,
  AUTO_COMPACT_MIN_RECLAIMABLE_BYTES,
  AUTO_COMPACT_MIN_RECLAIMABLE_RATIO,
  FULL_VACUUM_DISK_MARGIN_BYTES,
  INCREMENTAL_VACUUM_PAGES_PER_STEP,
  type DatabaseAutoVacuumMode,
  type DatabaseCompactionState,
  type DatabaseCompactionSummary,
  type DatabaseStorageStatus,
} from "../../shared/database-storage";
import {
  regularOwnedFile,
  waitForOperationOrAbort,
} from "./database-backup-cancellation";
import {
  type DatabaseBackupResult,
  listBackupMetadata,
} from "./database-recovery";
import { RUNTIME_MMAP_SIZE_BYTES } from "./runtime-connection-pragmas";

export const DATABASE_COMPACTION_IDLE_INTERVAL_MS = 10 * 60 * 1_000;
export const DATABASE_COMPACTION_INITIAL_IDLE_DELAY_MS = 60 * 1_000;
export const DATABASE_COMPACTION_STEP_YIELD_MS = 25;
export const DATABASE_COMPACTION_MAX_IDLE_STEPS = 64;
export const DATABASE_COMPACTION_VACUUM_TIMEOUT_MS = 5 * 60 * 1_000;

export type DatabaseCompactionTriggerMode = "manual" | "idle";
export type AvailableDiskBytesProbe = (directoryPath: string) => number | Promise<number>;

export interface DatabaseCompactionBackupAuthority {
  hasFreshBackup(): boolean;
  createBackup(): Promise<DatabaseBackupResult>;
}

export interface DatabaseCompactionOptions {
  readonly blockedReason?: (mode: DatabaseCompactionTriggerMode) => string | null;
  readonly availableDiskBytes?: AvailableDiskBytesProbe;
  readonly diskMarginBytes?: number;
  readonly autoConvertMinBytes?: number;
  readonly autoConvertMaxBytes?: number;
  readonly autoConvertMinRatio?: number;
  readonly incrementalPagesPerStep?: number;
  readonly incrementalStepYieldMs?: number;
  readonly maxIdleIncrementalSteps?: number;
  readonly idleIntervalMs?: number;
  readonly initialIdleDelayMs?: number;
  readonly vacuumTimeoutMs?: number;
  readonly trackOperation?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly onStateChange?: (status: DatabaseStorageStatus) => void;
  readonly onError?: (error: unknown) => void;
  readonly runFullVacuum?: (databasePath: string, signal: AbortSignal) => Promise<void>;
}

export function runtimeDatabaseCompactionBlocker(
  mode: DatabaseCompactionTriggerMode,
  state: {
    closed: boolean;
    updatePreparing: boolean;
    recoveryActive: boolean;
    activeTurns: boolean;
    activeRuns: boolean;
    providerMaintenanceActive: boolean;
    activeRuntimeCommands: number;
    activeNonStorageCommands: number;
    activeProviderRefreshes: number;
  },
): string | null {
  if (state.closed) return "The runtime is shutting down.";
  if (state.updatePreparing) {
    return "Database compaction cannot run while preparing for an application update.";
  }
  if (state.recoveryActive) {
    return "Database compaction cannot run while database recovery is in progress.";
  }
  if (state.activeTurns) {
    return "Wait for active turns to finish before compacting the database.";
  }
  if (state.activeRuns) {
    return "Wait for active runs to finish before compacting the database.";
  }
  if (state.providerMaintenanceActive) {
    return "Wait for provider maintenance to finish before compacting the database.";
  }
  if (mode === "idle" && (state.activeRuntimeCommands > 0 || state.activeProviderRefreshes > 0)) {
    return "Runtime work is active.";
  }
  if (mode === "manual" && state.activeNonStorageCommands > 0) {
    return "Wait for pending operations to finish before compacting the database.";
  }
  return null;
}

export class DatabaseCompactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseCompactionError";
  }
}

export class DatabaseCompactionCancelledError extends Error {
  constructor() {
    super("Database compaction was cancelled.");
    this.name = "DatabaseCompactionCancelledError";
  }
}

function formatRequiredBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1_024 && index < units.length - 1) {
    value /= 1_024;
    index += 1;
  }
  const precision = index === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[index]}`;
}

function readPragmaNonNegativeInteger(database: Database.Database, pragma: string): number {
  const value = database.pragma(pragma, { simple: true });
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function autoVacuumModeFromCode(code: number): DatabaseAutoVacuumMode {
  if (code === 1) return "full";
  if (code === 2) return "incremental";
  return "none";
}

function regularFileBytes(path: string): number {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink() ? metadata.size : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    return 0;
  }
}

export function walFileBytes(databasePath: string): number {
  return regularFileBytes(`${resolve(databasePath)}-wal`);
}

export function defaultAvailableDiskBytes(directoryPath: string): number {
  const stats = statfsSync(directoryPath, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(bytes);
}

export function measureDatabaseStorage(
  database: Database.Database,
  databasePath: string,
  state: DatabaseCompactionState = "idle",
  blockedReason: string | null = null,
): DatabaseStorageStatus {
  const pageSize = readPragmaNonNegativeInteger(database, "page_size");
  const pageCount = readPragmaNonNegativeInteger(database, "page_count");
  const rawFreelist = readPragmaNonNegativeInteger(database, "freelist_count");
  const freelistCount = Math.min(rawFreelist, pageCount);
  const autoVacuum = autoVacuumModeFromCode(
    readPragmaNonNegativeInteger(database, "auto_vacuum"),
  );
  const backups = listBackupMetadata(databasePath);
  const backupBytes = backups.reduce((sum, backup) => sum + backup.size, 0);
  return {
    pageSize,
    pageCount,
    freelistCount,
    databaseBytes: pageCount * pageSize,
    reclaimableBytes: freelistCount * pageSize,
    walBytes: walFileBytes(databasePath),
    backupCount: backups.length,
    backupBytes,
    autoVacuum,
    compactionState: state,
    busy: state !== "idle",
    blockedReason,
  };
}

export function shouldAutoConvertToIncremental(
  status: Pick<DatabaseStorageStatus, "autoVacuum" | "databaseBytes" | "reclaimableBytes">,
  minBytes = AUTO_COMPACT_MIN_RECLAIMABLE_BYTES,
  minRatio = AUTO_COMPACT_MIN_RECLAIMABLE_RATIO,
): boolean {
  return status.autoVacuum !== "incremental"
    && status.databaseBytes > 0
    && status.reclaimableBytes > minBytes
    && status.reclaimableBytes > status.databaseBytes * minRatio;
}

function yieldStep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DatabaseCompactionCancelledError());
  return new Promise<void>((resolveYield, rejectYield) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectYield(new DatabaseCompactionCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveYield();
    }, Math.max(0, Math.trunc(delayMs)));
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function runFullVacuumOffThread(
  databasePath: string,
  signal: AbortSignal,
  timeoutMs = DATABASE_COMPACTION_VACUUM_TIMEOUT_MS,
): Promise<void> {
  const resolvedPath = resolve(databasePath);
  if (!regularOwnedFile(resolvedPath)) {
    return Promise.reject(new DatabaseCompactionError("The database path is not a local file."));
  }
  const canonicalPath = resolve(realpathSync(resolvedPath));
  if (canonicalPath !== resolvedPath) {
    return Promise.reject(new DatabaseCompactionError("The database path must not traverse a symbolic link."));
  }
  if (signal.aborted) return Promise.reject(new DatabaseCompactionCancelledError());
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    let database = null;
    let ok = false;
    let message = "Database compaction failed.";
    try {
      database = new DatabaseSync(workerData.path);
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA mmap_size = 0");
      database.exec("PRAGMA auto_vacuum = INCREMENTAL");
      database.exec("VACUUM");
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      ok = true;
    } catch (error) {
      message = error instanceof Error && error.message ? error.message : message;
    } finally {
      if (database) {
        try { database.close(); } catch {}
      }
    }
    parentPort.postMessage(ok ? { ok: true } : { ok: false, message });
    parentPort.close();
  `;
  return new Promise<void>((resolveVacuum, rejectVacuum) => {
    const worker = new Worker(workerSource, {
      eval: true,
      execArgv: ["--no-warnings"],
      workerData: { path: canonicalPath },
    });
    let receipt: { ok: true } | { ok: false; message: string } | undefined;
    let settled = false;
    let stopping = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (error !== undefined) rejectVacuum(error);
      else resolveVacuum();
    };
    const stop = (error: unknown): void => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      worker.unref();
      void worker.terminate().then(
        () => finish(error),
        (terminationError: unknown) => finish(terminationError),
      );
    };
    const cancel = (): void => stop(new DatabaseCompactionCancelledError());
    const timer = setTimeout(
      () => stop(new DatabaseCompactionError("Database compaction timed out.")),
      Math.max(1_000, Math.trunc(timeoutMs)),
    );
    timer.unref();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    worker.once("message", (value: unknown) => {
      if (value && typeof value === "object" && "ok" in value && value.ok === true) {
        receipt = { ok: true };
      } else {
        const message = value && typeof value === "object" && "message" in value && typeof value.message === "string"
          ? value.message
          : "Database compaction failed.";
        receipt = { ok: false, message };
      }
    });
    worker.once("error", (error) => stop(error));
    worker.once("exit", (code) => {
      if (stopping) return;
      if (code !== 0 || receipt === undefined) {
        finish(new DatabaseCompactionError("The database compaction worker stopped unexpectedly."));
        return;
      }
      if (!receipt.ok) {
        finish(new DatabaseCompactionError(receipt.message));
        return;
      }
      finish();
    });
  });
}

export class DatabaseCompactionManager {
  private state: DatabaseCompactionState = "idle";
  private cachedStatus: DatabaseStorageStatus | null = null;
  private inFlight: Promise<unknown> | null = null;
  private inFlightAbort: AbortController | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    private readonly database: Database.Database,
    private readonly databasePath: string,
    private readonly backup: DatabaseCompactionBackupAuthority,
    private readonly options: DatabaseCompactionOptions = {},
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const initialDelayMs = Math.max(
      1_000,
      Math.trunc(this.options.initialIdleDelayMs ?? DATABASE_COMPACTION_INITIAL_IDLE_DELAY_MS),
    );
    const intervalMs = Math.max(
      1_000,
      Math.trunc(this.options.idleIntervalMs ?? DATABASE_COMPACTION_IDLE_INTERVAL_MS),
    );
    const schedulePass = (): void => {
      const run = (): Promise<DatabaseCompactionSummary | null> => this.runIdlePass();
      const promise = this.options.trackOperation ? this.options.trackOperation(run) : run();
      void promise.catch((error: unknown) => {
        if (error instanceof DatabaseCompactionCancelledError) return;
        this.options.onError?.(error);
      });
    };
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      if (this.started) schedulePass();
    }, initialDelayMs);
    this.initialTimer.unref();
    this.intervalTimer = setInterval(() => {
      if (this.started) schedulePass();
    }, intervalMs);
    this.intervalTimer.unref();
  }

  stop(): void {
    this.started = false;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  isCompacting(): boolean {
    return this.inFlight !== null || this.state !== "idle";
  }

  isHoldingExclusiveWork(): boolean {
    return this.state === "checkpointing" || this.state === "vacuuming";
  }

  status(): DatabaseStorageStatus {
    const blockedReason = this.blockedReason("manual");
    if (this.state !== "idle" && this.cachedStatus !== null) {
      return {
        ...this.cachedStatus,
        compactionState: this.state,
        busy: true,
        blockedReason,
      };
    }
    const measured = measureDatabaseStorage(
      this.database,
      this.databasePath,
      this.state,
      blockedReason,
    );
    this.cachedStatus = measured;
    return measured;
  }

  async compactNow(): Promise<{
    storage: DatabaseStorageStatus;
    compaction: DatabaseCompactionSummary;
  }> {
    if (!this.database.open) {
      throw new DatabaseCompactionError("The database is closed.");
    }
    if (this.inFlight) {
      throw new DatabaseCompactionError("Database compaction is already in progress.");
    }
    const blocked = this.blockedReason("manual");
    if (blocked !== null) {
      throw new DatabaseCompactionError(blocked);
    }
    const controller = new AbortController();
    const operation = this.executeCompaction("manual", controller.signal);
    this.inFlight = operation;
    this.inFlightAbort = controller;
    try {
      const compaction = await operation;
      return { storage: this.status(), compaction };
    } finally {
      if (this.inFlight === operation) {
        this.inFlight = null;
        this.inFlightAbort = null;
      }
    }
  }

  async runIdlePass(): Promise<DatabaseCompactionSummary | null> {
    if (!this.database.open || this.inFlight) return null;
    if (this.blockedReason("idle") !== null) return null;
    const before = this.status();
    const shouldFullVacuum = before.databaseBytes + before.walBytes
        <= (this.options.autoConvertMaxBytes ?? AUTO_COMPACT_MAX_FULL_VACUUM_BYTES)
      && shouldAutoConvertToIncremental(
        before,
        this.options.autoConvertMinBytes ?? AUTO_COMPACT_MIN_RECLAIMABLE_BYTES,
        this.options.autoConvertMinRatio ?? AUTO_COMPACT_MIN_RECLAIMABLE_RATIO,
      );
    const shouldIncremental = before.autoVacuum === "incremental" && before.freelistCount > 0;
    if (!shouldFullVacuum && !shouldIncremental) return null;
    const controller = new AbortController();
    const operation = this.executeCompaction("idle", controller.signal);
    this.inFlight = operation;
    this.inFlightAbort = controller;
    try {
      return await operation;
    } catch (error) {
      if (error instanceof DatabaseCompactionError) return null;
      throw error;
    } finally {
      if (this.inFlight === operation) {
        this.inFlight = null;
        this.inFlightAbort = null;
      }
    }
  }

  async cancelAndWait(): Promise<void> {
    this.stop();
    const operation = this.inFlight;
    this.inFlightAbort?.abort();
    if (!operation) return;
    try {
      await operation;
    } catch (error) {
      if (
        !(error instanceof DatabaseCompactionCancelledError)
        && !(error instanceof DatabaseCompactionError)
      ) throw error;
    }
  }

  private blockedReason(mode: DatabaseCompactionTriggerMode): string | null {
    return this.options.blockedReason?.(mode) ?? null;
  }

  private setState(next: DatabaseCompactionState): void {
    this.state = next;
    if (this.cachedStatus) {
      this.cachedStatus = {
        ...this.cachedStatus,
        compactionState: next,
        busy: next !== "idle",
        blockedReason: this.blockedReason("manual"),
      };
      this.options.onStateChange?.(this.cachedStatus);
    }
  }

  private async assertSufficientDiskSpace(requiredBytes: number): Promise<void> {
    const probe = this.options.availableDiskBytes ?? defaultAvailableDiskBytes;
    const directory = dirname(resolve(this.databasePath));
    let available: number;
    try {
      available = await probe(directory);
    } catch {
      throw new DatabaseCompactionError(
        "Free disk space on the database volume could not be verified.",
      );
    }
    if (!Number.isFinite(available) || available < 0) {
      throw new DatabaseCompactionError(
        "Free disk space on the database volume could not be verified.",
      );
    }
    if (available < requiredBytes) {
      throw new DatabaseCompactionError(
        `Not enough free disk space to compact the database safely. At least ${formatRequiredBytes(requiredBytes)} free is required, but only ${formatRequiredBytes(available)} is available.`,
      );
    }
  }

  private async executeCompaction(
    mode: DatabaseCompactionTriggerMode,
    signal: AbortSignal,
  ): Promise<DatabaseCompactionSummary> {
    const before = measureDatabaseStorage(
      this.database,
      this.databasePath,
      "idle",
      this.blockedReason("manual"),
    );
    this.cachedStatus = before;
    if (before.autoVacuum !== "incremental") {
      return await this.runFullVacuumConversion(before, mode, signal);
    }
    return await this.runIncrementalReclaim(before, mode, signal);
  }

  private async runFullVacuumConversion(
    before: DatabaseStorageStatus,
    mode: DatabaseCompactionTriggerMode,
    signal: AbortSignal,
  ): Promise<DatabaseCompactionSummary> {
    const marginBytes = Math.max(
      0,
      Math.trunc(this.options.diskMarginBytes ?? FULL_VACUUM_DISK_MARGIN_BYTES),
    );
    await this.assertSufficientDiskSpace(before.databaseBytes + before.walBytes + marginBytes);
    if (signal.aborted) throw new DatabaseCompactionCancelledError();
    let mmapDisabled = false;
    try {
      this.setState("backing-up");
      if (!this.backup.hasFreshBackup()) {
        await waitForOperationOrAbort(
          this.backup.createBackup(),
          signal,
          () => new DatabaseCompactionCancelledError(),
        );
      }
      if (signal.aborted) throw new DatabaseCompactionCancelledError();
      const blockedAfterBackup = this.blockedReason(mode);
      if (blockedAfterBackup !== null) {
        throw new DatabaseCompactionError(blockedAfterBackup);
      }
      const preVacuum = measureDatabaseStorage(
        this.database,
        this.databasePath,
        "backing-up",
        this.blockedReason("manual"),
      );
      this.cachedStatus = preVacuum;
      await this.assertSufficientDiskSpace(preVacuum.databaseBytes + preVacuum.walBytes + marginBytes);
      if (signal.aborted) throw new DatabaseCompactionCancelledError();
      this.setState("checkpointing");
      this.database.pragma("mmap_size = 0");
      mmapDisabled = true;
      this.database.pragma("wal_checkpoint(TRUNCATE)");
      if (signal.aborted) throw new DatabaseCompactionCancelledError();
      const blockedBeforeVacuum = this.blockedReason(mode);
      if (blockedBeforeVacuum !== null) {
        throw new DatabaseCompactionError(blockedBeforeVacuum);
      }
      this.setState("vacuuming");
      const vacuumRunner = this.options.runFullVacuum
        ?? ((path: string, abortSignal: AbortSignal) => runFullVacuumOffThread(
          path,
          abortSignal,
          this.options.vacuumTimeoutMs ?? DATABASE_COMPACTION_VACUUM_TIMEOUT_MS,
        ));
      await vacuumRunner(this.databasePath, signal);
      if (!signal.aborted && this.database.open && walFileBytes(this.databasePath) > 0) {
        this.database.pragma("wal_checkpoint(TRUNCATE)");
      }
    } finally {
      if (mmapDisabled && this.database.open) {
        try {
          this.database.pragma(`mmap_size = ${RUNTIME_MMAP_SIZE_BYTES}`);
        } catch {
          void 0;
        }
      }
      this.setState("idle");
    }
    const after = this.status();
    const totalBefore = before.databaseBytes + before.walBytes;
    const totalAfter = after.databaseBytes + after.walBytes;
    return {
      mode: "full-vacuum",
      bytesBefore: before.databaseBytes,
      bytesAfter: after.databaseBytes,
      reclaimedBytes: Math.max(0, totalBefore - totalAfter),
      walBytesBefore: before.walBytes,
      walBytesAfter: after.walBytes,
      autoVacuumBefore: before.autoVacuum,
      autoVacuumAfter: after.autoVacuum,
    };
  }

  private async runIncrementalReclaim(
    before: DatabaseStorageStatus,
    mode: DatabaseCompactionTriggerMode,
    signal: AbortSignal,
  ): Promise<DatabaseCompactionSummary> {
    if (before.freelistCount === 0 && before.walBytes === 0) {
      return {
        mode: "noop",
        bytesBefore: before.databaseBytes,
        bytesAfter: before.databaseBytes,
        reclaimedBytes: 0,
        walBytesBefore: before.walBytes,
        walBytesAfter: before.walBytes,
        autoVacuumBefore: before.autoVacuum,
        autoVacuumAfter: before.autoVacuum,
      };
    }
    const pagesPerStep = Math.max(
      1,
      Math.trunc(this.options.incrementalPagesPerStep ?? INCREMENTAL_VACUUM_PAGES_PER_STEP),
    );
    const yieldMs = Math.max(
      0,
      Math.trunc(this.options.incrementalStepYieldMs ?? DATABASE_COMPACTION_STEP_YIELD_MS),
    );
    const maxSteps = mode === "idle"
      ? Math.max(1, Math.trunc(this.options.maxIdleIncrementalSteps ?? DATABASE_COMPACTION_MAX_IDLE_STEPS))
      : Math.max(1, Math.ceil(before.freelistCount / pagesPerStep) + 8);
    let mmapDisabled = false;
    let didWork = false;
    try {
      this.database.pragma("mmap_size = 0");
      mmapDisabled = true;
      if (before.freelistCount > 0) {
        this.setState("reclaiming");
        for (let step = 0; step < maxSteps; step += 1) {
          if (signal.aborted) throw new DatabaseCompactionCancelledError();
          const blocked = this.blockedReason(mode);
          if (blocked !== null) {
            if (mode === "idle") break;
            throw new DatabaseCompactionError(blocked);
          }
          const freelistBefore = readPragmaNonNegativeInteger(this.database, "freelist_count");
          if (freelistBefore <= 0) break;
          this.database.pragma(`incremental_vacuum(${pagesPerStep})`);
          didWork = true;
          const freelistAfter = readPragmaNonNegativeInteger(this.database, "freelist_count");
          if (freelistAfter <= 0 || freelistAfter >= freelistBefore) break;
          if (step + 1 < maxSteps) {
            await yieldStep(yieldMs, signal);
          }
        }
      }
      if (!signal.aborted && this.database.open) {
        this.setState("checkpointing");
        const checkpointMode = this.blockedReason(mode) === null ? "TRUNCATE" : "PASSIVE";
        this.database.pragma(`wal_checkpoint(${checkpointMode})`);
      }
    } finally {
      if (mmapDisabled && this.database.open) {
        try {
          this.database.pragma(`mmap_size = ${RUNTIME_MMAP_SIZE_BYTES}`);
        } catch {
          void 0;
        }
      }
      this.setState("idle");
    }
    const after = this.status();
    const totalBefore = before.databaseBytes + before.walBytes;
    const totalAfter = after.databaseBytes + after.walBytes;
    const reclaimedBytes = Math.max(0, totalBefore - totalAfter);
    return {
      mode: didWork || reclaimedBytes > 0 ? "incremental" : "noop",
      bytesBefore: before.databaseBytes,
      bytesAfter: after.databaseBytes,
      reclaimedBytes,
      walBytesBefore: before.walBytes,
      walBytesAfter: after.walBytes,
      autoVacuumBefore: before.autoVacuum,
      autoVacuumAfter: after.autoVacuum,
    };
  }
}
