import { lstatSync, unlinkSync } from "node:fs";

const TRANSIENT_DATABASE_REMOVAL_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
  "ETXTBSY",
]);

export function regularOwnedFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export function removeIfRegularFile(path: string): void {
  if (regularOwnedFile(path)) unlinkSync(path);
}

export function removeDatabaseFileFamily(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    removeIfRegularFile(`${path}${suffix}`);
  }
}

export function removeInterruptedDatabaseFileFamily(path: string): void {
  try {
    removeDatabaseFileFamily(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !TRANSIENT_DATABASE_REMOVAL_CODES.has(code)) throw error;
    // A cancelled native SQLite operation may retain its destination handle
    // briefly on Windows. The file is still named as an unpublished partial,
    // and startup recovery removes interrupted partials after the old process
    // (and therefore every native handle it owned) has exited.
  }
}

export function waitForOperationOrAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  cancellationError: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellationError());
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      callback();
    };
    const cancel = (): void => settle(() => {
      rejectOperation(cancellationError());
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void operation.then(
      (result) => settle(() => resolveOperation(result)),
      (error: unknown) => settle(() => rejectOperation(error)),
    );
  });
}
