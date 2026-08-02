import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type Database from "better-sqlite3";

import { DATABASE_RECOVERY_EXPORT_MAX_PROJECTS } from "./database-export";

const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIRECTORY_BATCH = 16;

interface RecoveryImportJournalRow {
  operation_id: string;
  digest: string;
  authorized_root: string;
  projects: number;
}

export interface PrepareRecoveryImportOptions {
  database: Database.Database;
  digest: string;
  authorizedRoot: string;
  projectCount: number;
  operationId?: string;
  signal?: AbortSignal;
  operations?: {
    mkdir?: typeof mkdir;
    afterStagingPublish?: () => void;
  };
}

function roots(authorizedRoot: string, operationId: string): {
  staging: string;
  final: string;
} {
  return {
    staging: join(authorizedRoot, `.inertia-recovery-${operationId}.partial`),
    final: join(authorizedRoot, `recovered-${operationId}`),
  };
}

function projectPath(root: string, index: number): string {
  return join(root, `project-${String(index + 1).padStart(5, "0")}`);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function assertActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("The database recovery import was cancelled.");
}

function removeIncompleteRoot(
  path: string,
  authorizedRoot: string,
  projectCount: number,
): void {
  let rootMetadata: ReturnType<typeof lstatSync> | undefined;
  try {
    rootMetadata = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return;
  const canonical = resolve(realpathSync(path));
  const relativeRoot = relative(authorizedRoot, canonical);
  if (
    canonical !== resolve(path)
    || !relativeRoot
    || relativeRoot.includes(sep)
    || isAbsolute(relativeRoot)
  ) return;

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const match = /^project-([0-9]{5})$/u.exec(entry.name);
    const ordinal = match ? Number.parseInt(match[1]!, 10) : 0;
    if (
      ordinal < 1
      || ordinal > projectCount
      || !entry.isDirectory()
      || entry.isSymbolicLink()
    ) continue;
    try {
      rmdirSync(join(path, entry.name));
    } catch (error) {
      if (![
        "ENOENT",
        "ENOTDIR",
        "ENOTEMPTY",
      ].includes(errorCode(error) ?? "")) throw error;
    }
  }
  try {
    rmdirSync(path);
    return;
  } catch (error) {
    if (![
      "ENOENT",
      "ENOTDIR",
      "ENOTEMPTY",
    ].includes(errorCode(error) ?? "")) throw error;
    if (errorCode(error) === "ENOENT") return;
  }

  // Preserve directories that gained external contents. Retain the journal
  // only when an app-created empty directory failed transiently to disappear.
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const match = /^project-([0-9]{5})$/u.exec(entry.name);
    const ordinal = match ? Number.parseInt(match[1]!, 10) : 0;
    if (
      ordinal >= 1
      && ordinal <= projectCount
      && entry.isDirectory()
      && !entry.isSymbolicLink()
      && readdirSync(join(path, entry.name)).length === 0
    ) {
      throw new Error("The interrupted recovery import directory could not be removed.");
    }
  }
  if (readdirSync(path).length === 0) {
    throw new Error("The interrupted recovery import root could not be removed.");
  }
}

export function reconcileRecoveryImportJournal(
  database: Database.Database,
): void {
  const journal = database.prepare(`
    SELECT operation_id, digest, authorized_root, projects
    FROM recovery_import_journals WHERE singleton = 1
  `).get() as RecoveryImportJournalRow | undefined;
  if (!journal) return;
  if (
    !OPERATION_ID.test(journal.operation_id)
    || !/^[0-9a-f]{64}$/u.test(journal.digest)
    || !isAbsolute(journal.authorized_root)
    || journal.authorized_root.includes("\0")
    || !Number.isSafeInteger(journal.projects)
    || journal.projects < 0
    || journal.projects > DATABASE_RECOVERY_EXPORT_MAX_PROJECTS
  ) {
    throw new Error("The interrupted recovery import journal is invalid.");
  }
  if (database.prepare(
    "SELECT 1 FROM recovery_import_receipts WHERE digest = ?",
  ).get(journal.digest)) {
    throw new Error("The recovery import journal conflicts with a completed import.");
  }
  let rootMetadata: ReturnType<typeof lstatSync> | undefined;
  try {
    rootMetadata = lstatSync(journal.authorized_root);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (
    rootMetadata?.isDirectory()
    && !rootMetadata.isSymbolicLink()
    && resolve(realpathSync(journal.authorized_root)) === journal.authorized_root
  ) {
    const journalRoots = roots(journal.authorized_root, journal.operation_id);
    removeIncompleteRoot(
      journalRoots.staging,
      journal.authorized_root,
      journal.projects,
    );
    removeIncompleteRoot(
      journalRoots.final,
      journal.authorized_root,
      journal.projects,
    );
  }
  database.prepare(
    "DELETE FROM recovery_import_journals WHERE singleton = 1",
  ).run();
}

export class PreparedRecoveryImport {
  readonly #database: Database.Database;
  readonly #projectCount: number;
  readonly #roots: { staging: string; final: string };
  readonly #afterStagingPublish?: () => void;

  constructor(options: {
    database: Database.Database;
    authorizedRoot: string;
    operationId: string;
    projectCount: number;
    afterStagingPublish?: () => void;
  }) {
    this.#database = options.database;
    this.#projectCount = options.projectCount;
    this.#roots = roots(options.authorizedRoot, options.operationId);
    this.#afterStagingPublish = options.afterStagingPublish;
  }

  projectPath(index: number): string {
    return projectPath(this.#roots.final, index);
  }

  publish(): void {
    if (this.#projectCount === 0) return;
    renameSync(this.#roots.staging, this.#roots.final);
    this.#afterStagingPublish?.();
  }

  complete(): void {
    this.#database.prepare(
      "DELETE FROM recovery_import_journals WHERE singleton = 1",
    ).run();
  }

  abort(): void {
    reconcileRecoveryImportJournal(this.#database);
  }
}

export async function prepareRecoveryImport(
  options: PrepareRecoveryImportOptions,
): Promise<PreparedRecoveryImport> {
  assertActive(options.signal);
  const operationId = options.operationId ?? randomUUID();
  if (!OPERATION_ID.test(operationId)) {
    throw new Error("The recovery import operation identity is invalid.");
  }
  const importRoots = roots(options.authorizedRoot, operationId);
  const lastProjectPath = options.projectCount > 0
    ? projectPath(importRoots.final, options.projectCount - 1)
    : importRoots.final;
  if (
    importRoots.staging.length > 4_096
    || importRoots.final.length > 4_096
    || lastProjectPath.length > 4_096
  ) throw new Error("The recovery import destination path is too long.");
  for (const candidate of [importRoots.staging, importRoots.final]) {
    try {
      lstatSync(candidate);
      throw new Error("The recovery import destination is already in use.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  options.database.prepare(`
    INSERT INTO recovery_import_journals (
      singleton, operation_id, digest, authorized_root, projects, created_at
    ) VALUES (1, ?, ?, ?, ?, ?)
  `).run(
    operationId,
    options.digest,
    options.authorizedRoot,
    options.projectCount,
    new Date().toISOString(),
  );
  const prepared = new PreparedRecoveryImport({
    database: options.database,
    authorizedRoot: options.authorizedRoot,
    operationId,
    projectCount: options.projectCount,
    afterStagingPublish: options.operations?.afterStagingPublish,
  });
  try {
    if (options.projectCount === 0) return prepared;
    const mkdirDirectory = options.operations?.mkdir ?? mkdir;
    await mkdirDirectory(importRoots.staging, { mode: 0o700 });
    for (let start = 0; start < options.projectCount; start += DIRECTORY_BATCH) {
      assertActive(options.signal);
      const end = Math.min(options.projectCount, start + DIRECTORY_BATCH);
      const outcomes = await Promise.allSettled(Array.from(
        { length: end - start },
        (_unused, offset) => mkdirDirectory(
          projectPath(importRoots.staging, start + offset),
          { mode: 0o700 },
        ),
      ));
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (failure) throw failure.reason;
    }
    assertActive(options.signal);
    return prepared;
  } catch (error) {
    try {
      prepared.abort();
    } catch (cleanupError) {
      const detail = error instanceof Error ? error.message : "Recovery import failed.";
      throw new AggregateError(
        [error, cleanupError],
        `${detail} The incomplete import still requires startup reconciliation.`,
        { cause: error },
      );
    }
    throw error;
  }
}
