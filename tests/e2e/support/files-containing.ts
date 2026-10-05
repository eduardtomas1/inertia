import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCKED_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const LOCKED_RETRIES = 3;
const LOCKED_BACKOFF_MS = 100;
const CHROMIUM_DATABASE_DIRECTORY = /(?:Storage|Cache)$|^IndexedDB$/u;

export interface FileScan {
  matches: string[];
  unreadable: string[];
}

interface FileScanOptions {
  read?: (path: string) => Promise<Buffer>;
  wait?: (milliseconds: number) => Promise<unknown>;
}

export function isChromiumLockFile(path: string): boolean {
  const name = basename(path);
  if (name === "LOCK" || name === "lockfile") return true;
  if (!name.endsWith(".ldb") && !name.endsWith(".log")) return false;
  return dirname(path).split(/[\\/]/u).some((segment) => CHROMIUM_DATABASE_DIRECTORY.test(segment));
}

async function readWithRetry(
  path: string,
  read: NonNullable<FileScanOptions["read"]>,
  wait: NonNullable<FileScanOptions["wait"]>,
): Promise<Buffer | "missing" | "locked"> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return "missing";
      if (!LOCKED_CODES.has(code)) throw error;
      if (attempt === LOCKED_RETRIES) return "locked";
      await wait(LOCKED_BACKOFF_MS * (attempt + 1));
    }
  }
}

export async function filesContaining(
  directory: string,
  needle: string,
  { read = readFile, wait = delay }: FileScanOptions = {},
): Promise<FileScan> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const scan: FileScan = { matches: [], unreadable: [] };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const contents = await readWithRetry(path, read, wait);
    if (contents === "locked") scan.unreadable.push(path);
    else if (contents !== "missing" && contents.includes(needle)) scan.matches.push(path);
  }
  return scan;
}
