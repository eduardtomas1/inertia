import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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

function receiptDirectory(dataDirectory: string): string {
  return join(dataDirectory, RECEIPT_DIRECTORY);
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

export function runtimeCleanupReceiptIds(dataDirectory: string): string[] {
  const directory = receiptDirectory(dataDirectory);
  if (!existsSync(directory)) return [];
  const receipts: RuntimeCleanupReceipt[] = [];
  const names = readdirSync(directory);
  if (names.length > MAX_RECEIPTS * 3) {
    throw new Error("The runtime cleanup receipt storage bound was exceeded.");
  }
  for (const name of names) {
    const transient = name.match(
      /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(tmp|consume)$/iu,
    );
    if (transient) {
      const path = join(directory, name);
      const receipt = parseStoredReceipt(path);
      if (!receipt) throw new Error("A runtime cleanup receipt transient is invalid.");
      if (transient[1] === "tmp") {
        const expectedName = receiptName(receipt.runtimeGenerationId);
        const target = join(directory, expectedName);
        if (existsSync(target)) {
          const published = parseReceipt(target, expectedName);
          if (
            !published
            || published.runtimeGenerationId !== receipt.runtimeGenerationId
          ) throw new Error("A runtime cleanup receipt transient conflicts.");
        } else {
          try {
            linkSync(path, target);
            receipts.push(receipt);
          } catch {
            throw new Error("A runtime cleanup receipt transient could not be published.");
          }
        }
      }
      try {
        unlinkSync(path);
        fsyncDirectory(directory);
      } catch {
        throw new Error("A runtime cleanup receipt transient could not be retired.");
      }
      continue;
    }
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) {
      throw new Error("Runtime cleanup receipt storage contains a foreign entry.");
    }
    const receipt = parseReceipt(join(directory, name), name);
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

export function publishRuntimeCleanupReceipt(
  dataDirectory: string,
  runtimeGenerationId: string,
): boolean {
  if (!GENERATION_PATTERN.test(runtimeGenerationId)) return false;
  let temporary: string | null = null;
  try {
    const directory = receiptDirectory(dataDirectory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const expectedName = receiptName(runtimeGenerationId);
    const target = join(directory, expectedName);
    if (existsSync(target)) return parseReceipt(target, expectedName) !== null;
    if (runtimeCleanupReceiptIds(dataDirectory).length >= MAX_RECEIPTS) return false;
    temporary = join(directory, `.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify({
      runtimeGenerationId,
      confirmedAt: new Date().toISOString(),
    }), { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
    chmodSync(temporary, 0o600);
    linkSync(temporary, target);
    unlinkSync(temporary);
    temporary = null;
    fsyncDirectory(directory);
    return true;
  } catch {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* Nothing was published. */ }
    }
    return false;
  }
}

export function consumeRuntimeCleanupReceipt(
  dataDirectory: string,
  runtimeGenerationId: string,
): boolean {
  if (!GENERATION_PATTERN.test(runtimeGenerationId)) return false;
  const directory = receiptDirectory(dataDirectory);
  const expectedName = receiptName(runtimeGenerationId);
  const target = join(directory, expectedName);
  const quarantine = join(directory, `.${randomUUID()}.consume`);
  try {
    renameSync(target, quarantine);
  } catch {
    return false;
  }
  if (!parseReceipt(quarantine, expectedName)) {
    try { linkSync(quarantine, target); } catch { /* Preserve both identities for inspection. */ }
    return false;
  }
  try {
    unlinkSync(quarantine);
  } catch {
    try { linkSync(quarantine, target); } catch { /* The exact ACK already cleared the database lease. */ }
  }
  return true;
}

export class RuntimeCleanupReceiptJournal {
  private readonly ids: Set<string>;

  constructor(private readonly dataDirectory: string) {
    this.ids = new Set(runtimeCleanupReceiptIds(dataDirectory));
  }

  pending(): string[] {
    return [...this.ids];
  }

  has(runtimeGenerationId: string): boolean {
    return this.ids.has(runtimeGenerationId);
  }

  publish(runtimeGenerationId: string): boolean {
    if (!publishRuntimeCleanupReceipt(this.dataDirectory, runtimeGenerationId)) {
      return false;
    }
    this.ids.add(runtimeGenerationId);
    return true;
  }

  consume(runtimeGenerationId: string): boolean {
    if (!this.ids.has(runtimeGenerationId)) return false;
    // The exact current-worker ACK proves its database generation lease was
    // cleared. Disk retirement is retryable housekeeping: a canonical file
    // left behind is safely replayed on a later app start, while a quarantined
    // foreign replacement remains available for inspection.
    consumeRuntimeCleanupReceipt(this.dataDirectory, runtimeGenerationId);
    this.ids.delete(runtimeGenerationId);
    return true;
  }
}
