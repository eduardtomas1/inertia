import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { FILE_OPEN_NO_FOLLOW } from "../node/platform-file-open-flags.js";
import type { DiagnosticCaptureState } from "./runtime-diagnostics.js";

const FILE_NAME = "diagnostics-preferences.json";
const MAX_BYTES = 512;
const TEMPORARY_PATTERN = /^\.diagnostics-preferences-[0-9a-f-]{36}\.json$/u;

function parse(value: unknown): DiagnosticCaptureState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || typeof row.enabled !== "boolean") return null;
  if (row.since === null) return { enabled: row.enabled, since: null };
  return typeof row.since === "string"
    && row.since.length <= 40
    && Number.isFinite(Date.parse(row.since))
    && new Date(row.since).toISOString() === row.since
    ? { enabled: row.enabled, since: row.since }
    : null;
}

export function readDiagnosticsPreferences(directory: string): DiagnosticCaptureState | null {
  try {
    const descriptor = openSync(join(realpathSync(directory), FILE_NAME), constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_BYTES) return null;
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const read = readSync(descriptor, bytes, 0, bytes.length, 0);
      return read <= MAX_BYTES ? parse(JSON.parse(bytes.subarray(0, read).toString("utf8"))) : null;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return null;
  }
}

export function writeDiagnosticsPreferences(directory: string, input: DiagnosticCaptureState): void {
  const preferences = parse(input);
  if (!preferences) throw new Error("Invalid diagnostics settings.");
  const root = realpathSync(directory);
  const path = join(root, FILE_NAME);
  if (lstatExists(path)) {
    const prior = lstatSync(path);
    if (!prior.isFile() || prior.isSymbolicLink()) throw new Error("Diagnostics settings are unavailable.");
  }
  const temporary = join(root, `.diagnostics-preferences-${randomUUID()}.json`);
  try {
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | FILE_OPEN_NO_FOLLOW,
      0o600,
    );
    try {
      const bytes = Buffer.from(JSON.stringify(preferences), "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error("Diagnostics settings could not be written.");
        offset += written;
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } finally {
    if (lstatExists(temporary)) unlinkSync(temporary);
  }
}

export function removeStaleDiagnosticsPreferenceFiles(directory: string): void {
  try {
    const root = realpathSync(directory);
    for (const name of readdirSync(root)) {
      if (!TEMPORARY_PATTERN.test(name)) continue;
      const path = join(root, name);
      const metadata = lstatSync(path);
      if (metadata.isFile() || metadata.isSymbolicLink()) unlinkSync(path);
    }
  } catch {
    return;
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
