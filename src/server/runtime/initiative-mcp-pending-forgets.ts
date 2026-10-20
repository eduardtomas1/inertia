import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";

/*
 * Vault references of initiative MCP secrets that could not be removed when
 * their server or initiative went away (secure storage was unavailable, for
 * example). They are kept in a small preferences file in the data folder and
 * removed again the next time the runtime starts. A reference is a one-way
 * hash, not credential material, so it may be stored in the clear.
 */

const FILE_NAME = "initiative-mcp-pending-forgets.json";
/** Oldest references are dropped beyond this; the file stays a few kilobytes. */
export const MAX_PENDING_INITIATIVE_MCP_FORGETS = 256;
const MAX_BYTES = 64 * 1024;
const REFERENCE = /^secret:mcp:[0-9a-f]{64}$/u;

function parse(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 1 || !Array.isArray(row.references)) return null;
  if (row.references.length > MAX_PENDING_INITIATIVE_MCP_FORGETS) return null;
  return row.references.every((reference) => typeof reference === "string" && REFERENCE.test(reference))
    ? [...new Set(row.references as string[])]
    : null;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The pending references, or an empty list when the file is missing or unreadable. */
export function readPendingInitiativeMcpForgets(dataDirectory: string): string[] {
  let descriptor: number;
  try {
    descriptor = openSync(join(realpathSync(dataDirectory), FILE_NAME), constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
  } catch {
    return [];
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_BYTES) return [];
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const read = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (read > MAX_BYTES) return [];
    return parse(JSON.parse(bytes.subarray(0, read).toString("utf8"))) ?? [];
  } catch {
    return [];
  } finally {
    closeSync(descriptor);
  }
}

/** Replaces the pending list; an empty list removes the file. */
export function writePendingInitiativeMcpForgets(dataDirectory: string, references: readonly string[]): void {
  const list = [...new Set(references.filter((reference) => REFERENCE.test(reference)))]
    .slice(-MAX_PENDING_INITIATIVE_MCP_FORGETS);
  const root = realpathSync(dataDirectory);
  const path = join(root, FILE_NAME);
  if (exists(path)) {
    const prior = lstatSync(path);
    if (!prior.isFile() || prior.isSymbolicLink()) throw new Error("The pending secret list is not a regular file.");
    if (list.length === 0) {
      unlinkSync(path);
      return;
    }
  }
  if (list.length === 0) return;
  const temporary = join(root, `.initiative-mcp-pending-forgets-${randomUUID()}.json`);
  try {
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | FILE_OPEN_NO_FOLLOW,
      0o600,
    );
    try {
      const bytes = Buffer.from(JSON.stringify({ references: list }), "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error("The pending secret list could not be written.");
        offset += written;
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } finally {
    if (exists(temporary)) unlinkSync(temporary);
  }
}

export interface InitiativeMcpPendingForgets {
  /** Adds references whose removal failed; never throws. */
  add(references: readonly string[]): void;
  /** Removes references from the list (they are in use again, or now forgotten). */
  remove(references: readonly string[]): void;
  list(): string[];
}

/** The pending list in a data folder. Failures to save it are logged, never thrown. */
export function initiativeMcpPendingForgets(dataDirectory: string): InitiativeMcpPendingForgets {
  const update = (change: (current: string[]) => string[]): void => {
    try {
      const current = readPendingInitiativeMcpForgets(dataDirectory);
      const next = change(current);
      if (next.length === current.length && next.every((reference, index) => reference === current[index])) return;
      writePendingInitiativeMcpForgets(dataDirectory, next);
    } catch {
      console.warn("The list of initiative MCP secrets still to remove could not be saved.");
    }
  };
  return {
    add: (references) => {
      if (references.length === 0) return;
      update((current) => [...current.filter((reference) => !references.includes(reference)), ...references]);
    },
    remove: (references) => {
      if (references.length === 0) return;
      update((current) => current.filter((reference) => !references.includes(reference)));
    },
    list: () => readPendingInitiativeMcpForgets(dataDirectory),
  };
}
