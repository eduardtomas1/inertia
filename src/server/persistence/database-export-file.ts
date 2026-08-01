import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import { DATABASE_RECOVERY_EXPORT_MAX_BYTES } from "./database-export";

const FILE_MODE = 0o600;

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
  const file = await open(
    partialPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    FILE_MODE,
  );
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(partialPath, path);
    await chmod(path, FILE_MODE);
  } catch (error) {
    await removeRegularFile(partialPath);
    throw error;
  }
}

export async function readDatabaseRecoveryExportFile(
  path: string,
): Promise<string> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < 1
    || metadata.size > DATABASE_RECOVERY_EXPORT_MAX_BYTES
  ) {
    throw new Error("The recovery export file is unavailable or too large.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== metadata.size) {
      throw new Error("The recovery export file changed while opening.");
    }
    const content = await readFile(file, { encoding: "utf8" });
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
