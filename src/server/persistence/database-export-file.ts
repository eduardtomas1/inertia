import { randomUUID } from "node:crypto";
import {
  chmod,
  type FileHandle,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../../node/platform-file-open-flags";
import { DATABASE_RECOVERY_EXPORT_MAX_BYTES } from "./database-export";

const FILE_MODE = 0o600;

interface RecoveryExportFileOperations {
  open: typeof open;
  rename: typeof rename;
  chmod: typeof chmod;
}

interface WriteDatabaseRecoveryExportFileOptions {
  signal?: AbortSignal;
  operations?: Partial<RecoveryExportFileOperations>;
}

interface ReadDatabaseRecoveryExportFileOptions {
  signal?: AbortSignal;
  operations?: { readFile?: typeof readFile };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The database recovery export was cancelled.");
  }
}

async function removeRegularFile(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isFile() && !metadata.isSymbolicLink()) await unlink(path);
  } catch {
    // A missing temporary file needs no cleanup.
  }
}

export async function writeDatabaseRecoveryExportFile(
  path: string,
  content: string,
  options: WriteDatabaseRecoveryExportFileOptions = {},
): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > DATABASE_RECOVERY_EXPORT_MAX_BYTES) {
    throw new Error("The recovery export exceeds its safe size limit.");
  }
  try {
    const target = await lstat(path);
    if (!target.isFile() || target.isSymbolicLink()) {
      throw new Error("The recovery export target is not a local file.");
    }
  } catch (error) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) throw error;
  }
  const partialPath = join(
    dirname(path),
    `.inertia-recovery-${randomUUID()}.partial`,
  );
  const openFile = options.operations?.open ?? open;
  const renameFile = options.operations?.rename ?? rename;
  const chmodFile = options.operations?.chmod ?? chmod;
  let file: FileHandle | null = null;
  let published = false;
  let primaryError: unknown;
  try {
    throwIfAborted(options.signal);
    file = await openFile(
      partialPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      FILE_MODE,
    );
    await file.writeFile(content, {
      encoding: "utf8",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await file.sync();
    await file.close();
    file = null;
    throwIfAborted(options.signal);
    await renameFile(partialPath, path);
    published = true;
    await chmodFile(path, FILE_MODE);
  } catch (error) {
    primaryError = error;
  } finally {
    if (file) {
      try {
        await file.close();
      } catch (closeError) {
        primaryError ??= closeError;
      }
    }
    if (!published) await removeRegularFile(partialPath);
  }
  if (primaryError !== undefined) throw primaryError;
}

export async function readDatabaseRecoveryExportFile(
  path: string,
  options: ReadDatabaseRecoveryExportFileOptions = {},
): Promise<string> {
  throwIfAborted(options.signal);
  const metadata = await lstat(path);
  throwIfAborted(options.signal);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < 1
    || metadata.size > DATABASE_RECOVERY_EXPORT_MAX_BYTES
  ) {
    throw new Error("The recovery export file is unavailable or too large.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== metadata.size) {
      throw new Error("The recovery export file changed while opening.");
    }
    const content = await (options.operations?.readFile ?? readFile)(file, {
      encoding: "utf8",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    throwIfAborted(options.signal);
    const after = await file.stat();
    if (
      after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("The recovery export file changed while reading.");
    }
    return content;
  } finally {
    await file.close();
  }
}
