import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  journalDirectoryIsPinned,
  pinJournalDirectory,
  type PinnedJournalDirectory,
} from "../node/pinned-journal-directory.js";

const MAX_RECEIPTS = 32;
const RECEIPT_DIRECTORY = ".runtime-cleanup-receipts";
const GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]{0,9}$/iu;

interface RuntimeCleanupReceipt {
  runtimeGenerationId: string;
  confirmedAt: string;
}

function receiptName(runtimeGenerationId: string): string {
  return `${createHash("sha256").update(runtimeGenerationId).digest("hex")}.json`;
}

function fsyncDirectory(directory: string): void {
  try {
    const directoryHandle = openSync(directory, "r");
    try { fsyncSync(directoryHandle); } finally { closeSync(directoryHandle); }
  } catch { /* Windows does not expose directory fsync. */ }
}

function parseReceipt(path: string, expectedName: string): RuntimeCleanupReceipt | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > 512) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const receipt = value as Partial<RuntimeCleanupReceipt>;
    if (
      typeof receipt.runtimeGenerationId !== "string"
      || !GENERATION_PATTERN.test(receipt.runtimeGenerationId)
      || receiptName(receipt.runtimeGenerationId) !== expectedName
      || typeof receipt.confirmedAt !== "string"
      || !Number.isFinite(Date.parse(receipt.confirmedAt))
    ) return null;
    return receipt as RuntimeCleanupReceipt;
  } catch {
    return null;
  }
}

function parseStoredReceipt(path: string): RuntimeCleanupReceipt | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 512) {
      return null;
    }
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const receipt = value as Partial<RuntimeCleanupReceipt>;
    if (typeof receipt.runtimeGenerationId !== "string") return null;
    return parseReceipt(path, receiptName(receipt.runtimeGenerationId));
  } catch {
    return null;
  }
}

function readRuntimeCleanupReceiptIds(
  directory: PinnedJournalDirectory | null,
): string[] {
  if (!directory) return [];
  if (!journalDirectoryIsPinned(directory)) {
    throw new Error("The runtime cleanup receipt directory identity changed.");
  }
  const receipts: RuntimeCleanupReceipt[] = [];
  const names = readdirSync(directory.path);
  if (names.length > MAX_RECEIPTS * 3) {
    throw new Error("The runtime cleanup receipt storage bound was exceeded.");
  }
  for (const name of names) {
    const transient = name.match(
      /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(tmp|consume)$/iu,
    );
    if (transient) {
      if (!journalDirectoryIsPinned(directory)) {
        throw new Error("The runtime cleanup receipt directory identity changed.");
      }
      const path = join(directory.path, name);
      const receipt = parseStoredReceipt(path);
      if (!receipt) throw new Error("A runtime cleanup receipt transient is invalid.");
      if (transient[1] === "tmp") {
        const expectedName = receiptName(receipt.runtimeGenerationId);
        const target = join(directory.path, expectedName);
        if (existsSync(target)) {
          const published = parseReceipt(target, expectedName);
          if (
            !published
            || published.runtimeGenerationId !== receipt.runtimeGenerationId
          ) throw new Error("A runtime cleanup receipt transient conflicts.");
        } else {
          try {
            if (!journalDirectoryIsPinned(directory)) {
              throw new Error("The runtime cleanup receipt directory identity changed.");
            }
            linkSync(path, target);
            receipts.push(receipt);
          } catch {
            throw new Error("A runtime cleanup receipt transient could not be published.");
          }
        }
      }
      try {
        if (!journalDirectoryIsPinned(directory)) {
          throw new Error("The runtime cleanup receipt directory identity changed.");
        }
        unlinkSync(path);
        fsyncDirectory(directory.path);
      } catch {
        throw new Error("A runtime cleanup receipt transient could not be retired.");
      }
      continue;
    }
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) {
      throw new Error("Runtime cleanup receipt storage contains a foreign entry.");
    }
    if (!journalDirectoryIsPinned(directory)) {
      throw new Error("The runtime cleanup receipt directory identity changed.");
    }
    const receipt = parseReceipt(join(directory.path, name), name);
    if (!receipt) throw new Error("A runtime cleanup receipt is invalid.");
    receipts.push(receipt);
    if (receipts.length > MAX_RECEIPTS) {
      throw new Error("The runtime cleanup receipt bound was exceeded.");
    }
  }
  return receipts.sort((left, right) => (
    left.confirmedAt.localeCompare(right.confirmedAt)
    || left.runtimeGenerationId.localeCompare(right.runtimeGenerationId)
  )).map(({ runtimeGenerationId }) =>
    runtimeGenerationId);
}

export function runtimeCleanupReceiptIds(dataDirectory: string): string[] {
  return readRuntimeCleanupReceiptIds(pinJournalDirectory(
    dataDirectory,
    RECEIPT_DIRECTORY,
    false,
  ));
}

function publishReceipt(
  directory: PinnedJournalDirectory,
  runtimeGenerationId: string,
): boolean {
  let temporary: string | null = null;
  try {
    if (!journalDirectoryIsPinned(directory)) return false;
    const expectedName = receiptName(runtimeGenerationId);
    const target = join(directory.path, expectedName);
    if (existsSync(target)) return parseReceipt(target, expectedName) !== null;
    if (readRuntimeCleanupReceiptIds(directory).length >= MAX_RECEIPTS) return false;
    temporary = join(directory.path, `.${randomUUID()}.tmp`);
    if (!journalDirectoryIsPinned(directory)) return false;
    writeFileSync(temporary, JSON.stringify({
      runtimeGenerationId,
      confirmedAt: new Date().toISOString(),
    }), { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
    chmodSync(temporary, 0o600);
    if (!journalDirectoryIsPinned(directory)) return false;
    linkSync(temporary, target);
    if (!journalDirectoryIsPinned(directory)) return false;
    unlinkSync(temporary);
    temporary = null;
    fsyncDirectory(directory.path);
    return true;
  } catch {
    if (temporary && journalDirectoryIsPinned(directory)) {
      try { unlinkSync(temporary); } catch { /* Nothing was published. */ }
    }
    return false;
  }
}

export function publishRuntimeCleanupReceipt(
  dataDirectory: string,
  runtimeGenerationId: string,
): boolean {
  if (!GENERATION_PATTERN.test(runtimeGenerationId)) return false;
  try {
    const directory = pinJournalDirectory(dataDirectory, RECEIPT_DIRECTORY, true);
    return directory ? publishReceipt(directory, runtimeGenerationId) : false;
  } catch {
    return false;
  }
}

function consumeReceipt(
  directory: PinnedJournalDirectory,
  runtimeGenerationId: string,
): boolean {
  const expectedName = receiptName(runtimeGenerationId);
  const target = join(directory.path, expectedName);
  const quarantine = join(directory.path, `.${randomUUID()}.consume`);
  try {
    if (!journalDirectoryIsPinned(directory)) return false;
    renameSync(target, quarantine);
    if (!journalDirectoryIsPinned(directory)) return false;
  } catch {
    return false;
  }
  if (!parseReceipt(quarantine, expectedName)) {
    try {
      if (journalDirectoryIsPinned(directory)) linkSync(quarantine, target);
    } catch { /* Preserve both identities for inspection. */ }
    return false;
  }
  try {
    if (!journalDirectoryIsPinned(directory)) return false;
    unlinkSync(quarantine);
    fsyncDirectory(directory.path);
  } catch {
    try {
      if (journalDirectoryIsPinned(directory)) linkSync(quarantine, target);
    } catch { /* The exact ACK already cleared the database lease. */ }
  }
  return journalDirectoryIsPinned(directory);
}

export function consumeRuntimeCleanupReceipt(
  dataDirectory: string,
  runtimeGenerationId: string,
): boolean {
  if (!GENERATION_PATTERN.test(runtimeGenerationId)) return false;
  try {
    const directory = pinJournalDirectory(dataDirectory, RECEIPT_DIRECTORY, false);
    return directory ? consumeReceipt(directory, runtimeGenerationId) : false;
  } catch {
    return false;
  }
}

export class RuntimeCleanupReceiptJournal {
  private readonly ids: Set<string>;
  private directory: PinnedJournalDirectory | null;

  constructor(private readonly dataDirectory: string) {
    this.directory = pinJournalDirectory(dataDirectory, RECEIPT_DIRECTORY, false);
    this.ids = new Set(readRuntimeCleanupReceiptIds(this.directory));
  }

  pending(): string[] {
    return [...this.ids];
  }

  has(runtimeGenerationId: string): boolean {
    return this.ids.has(runtimeGenerationId);
  }

  publish(runtimeGenerationId: string): boolean {
    if (!GENERATION_PATTERN.test(runtimeGenerationId)) return false;
    try {
      this.directory ??= pinJournalDirectory(
        this.dataDirectory,
        RECEIPT_DIRECTORY,
        true,
      );
    } catch {
      return false;
    }
    if (!this.directory || !publishReceipt(this.directory, runtimeGenerationId)) return false;
    this.ids.add(runtimeGenerationId);
    return true;
  }

  consume(runtimeGenerationId: string): boolean {
    if (!this.ids.has(runtimeGenerationId)) return false;
    if (!this.directory || !journalDirectoryIsPinned(this.directory)) return false;
    // The exact current-worker ACK proves its database generation lease was
    // cleared. Disk retirement is retryable housekeeping: a canonical file
    // left behind is safely replayed on a later app start, while a quarantined
    // foreign replacement remains available for inspection.
    consumeReceipt(this.directory, runtimeGenerationId);
    if (!journalDirectoryIsPinned(this.directory)) return false;
    this.ids.delete(runtimeGenerationId);
    return true;
  }
}
