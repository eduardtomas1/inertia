import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { FILE_OPEN_NO_FOLLOW } from "../node/platform-file-open-flags.js";
import type { SnapshotState } from "../shared/snapshots.js";

export type SnapshotPreferences = Pick<SnapshotState, "enabled" | "shortcut">;
const fileName = "snapshot-preferences.json";
function parse(value: unknown): SnapshotPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && typeof row.enabled === "boolean" && (row.shortcut === "both-shift" || row.shortcut === "accelerator")
    ? { enabled: row.enabled, shortcut: row.shortcut } : null;
}

export async function readSnapshotPreferences(directory: string): Promise<SnapshotPreferences | null> {
  try {
    const file = await open(join(await realpath(directory), fileName), constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 512) return null;
      const bytes = await file.readFile();
      return bytes.length <= 512 ? parse(JSON.parse(bytes.toString("utf8"))) : null;
    } finally { await file.close(); }
  } catch { return null; }
}

export async function writeSnapshotPreferences(directory: string, input: SnapshotPreferences): Promise<void> {
  const preferences = parse(input);
  if (!preferences) throw new Error("Invalid snapshot settings.");
  const root = await realpath(directory);
  const path = join(root, fileName);
  const prior = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (prior && (!prior.isFile() || prior.isSymbolicLink())) throw new Error("Snapshot settings are unavailable.");
  const temporary = join(root, `.snapshot-${randomUUID()}.json`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(preferences)); await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** Forget saved preferences so the next launch starts with Snapshots off. */
export async function clearSnapshotPreferences(directory: string): Promise<void> {
  await unlink(join(await realpath(directory), fileName)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}
