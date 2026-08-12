import { createHash } from "node:crypto";

import {
  discardDirectRuntimeJournalLeaf,
  directRuntimeJournalRootIsPinned,
  directRuntimeJournalLeafExists,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  renameDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
  type DirectRuntimeJournalTestHooks,
} from "../node/direct-runtime-journal.js";

const MAX_RECEIPTS = 32;
const MAX_RECEIPT_BYTES = 768;
const RECEIPT_PREFIX = ".runtime-cleanup-receipt-";
const RECEIPT_SCHEMA_VERSION = 1;
const LEGACY_RECEIPT_DIRECTORY = ".runtime-cleanup-receipts";
const GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]{0,9}$/iu;

interface RuntimeCleanupReceipt {
  runtimeGenerationId: string;
  confirmedAt: string;
}

interface StoredRuntimeCleanupReceipt extends RuntimeCleanupReceipt {
  readonly version: typeof RECEIPT_SCHEMA_VERSION;
}

function generationHash(runtimeGenerationId: string): string {
  return createHash("sha256").update(runtimeGenerationId).digest("hex");
}

function canonicalName(hash: string): string {
  return `${RECEIPT_PREFIX}${hash}.json`;
}

function transientName(hash: string, operation: "publish" | "consume"): string {
  return `${RECEIPT_PREFIX}${hash}.${operation}.tmp`;
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function parseReceipt(
  bytes: Buffer,
  expectedHash: string,
): RuntimeCleanupReceipt | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    if (!exactObjectKeys(value, [
      "confirmedAt",
      "runtimeGenerationId",
      "version",
    ])) return null;
    const receipt = value as Partial<StoredRuntimeCleanupReceipt>;
    if (
      receipt.version !== RECEIPT_SCHEMA_VERSION
      || typeof receipt.runtimeGenerationId !== "string"
      || !GENERATION_PATTERN.test(receipt.runtimeGenerationId)
      || typeof receipt.confirmedAt !== "string"
      || !Number.isFinite(Date.parse(receipt.confirmedAt))
      || generationHash(receipt.runtimeGenerationId) !== expectedHash
    ) return null;
    return {
      runtimeGenerationId: receipt.runtimeGenerationId,
      confirmedAt: receipt.confirmedAt,
    };
  } catch {
    return null;
  }
}

function storedReceipt(receipt: RuntimeCleanupReceipt): Buffer {
  return Buffer.from(JSON.stringify({
    version: RECEIPT_SCHEMA_VERSION,
    runtimeGenerationId: receipt.runtimeGenerationId,
    confirmedAt: receipt.confirmedAt,
  }), "utf8");
}

function readRuntimeCleanupReceipts(
  root: DirectRuntimeJournalRoot,
): RuntimeCleanupReceipt[] {
  if (directRuntimeJournalLeafExists(root, LEGACY_RECEIPT_DIRECTORY)) {
    throw new Error("The legacy runtime cleanup receipt storage is unsafe.");
  }
  const names = listDirectRuntimeJournalLeaves(
    root,
    RECEIPT_PREFIX,
    MAX_RECEIPTS * 3,
  );
  const receipts: RuntimeCleanupReceipt[] = [];
  for (const name of names) {
    const match = name.match(
      /^\.runtime-cleanup-receipt-([0-9a-f]{64})\.(?:(json)|(publish|consume)\.tmp)$/u,
    );
    if (!match) {
      throw new Error("Runtime cleanup receipt storage contains a foreign entry.");
    }
    let leaf;
    try {
      leaf = readDirectRuntimeJournalLeaf(root, name, MAX_RECEIPT_BYTES);
    } catch (error) {
      if (
        match[3] === "publish"
        && discardDirectRuntimeJournalLeaf(root, name)
      ) continue;
      throw error;
    }
    if (!leaf) throw new Error("A runtime cleanup receipt disappeared.");
    const receipt = parseReceipt(leaf.bytes, match[1]!);
    if (!receipt) {
      if (
        match[3] === "publish"
        && unlinkDirectRuntimeJournalLeaf(root, name, leaf.identity)
      ) continue;
      throw new Error("A runtime cleanup receipt is invalid.");
    }
    if (match[2]) {
      receipts.push(receipt);
      if (receipts.length > MAX_RECEIPTS) {
        throw new Error("The runtime cleanup receipt bound was exceeded.");
      }
      continue;
    }
    if (match[3] === "publish") {
      const targetName = canonicalName(match[1]!);
      const target = readDirectRuntimeJournalLeaf(
        root,
        targetName,
        MAX_RECEIPT_BYTES,
      );
      if (target) {
        const published = parseReceipt(target.bytes, match[1]!);
        if (
          !published
          || published.runtimeGenerationId !== receipt.runtimeGenerationId
        ) throw new Error("A runtime cleanup receipt transient conflicts.");
        if (!unlinkDirectRuntimeJournalLeaf(root, name, leaf.identity)) {
          throw new Error("A runtime cleanup receipt transient could not be retired.");
        }
      } else if (!renameDirectRuntimeJournalLeaf(
        root,
        name,
        targetName,
        leaf.identity,
      )) {
        throw new Error("A runtime cleanup receipt transient could not be published.");
      } else {
        receipts.push(receipt);
        if (receipts.length > MAX_RECEIPTS) {
          throw new Error("The runtime cleanup receipt bound was exceeded.");
        }
      }
      continue;
    }
    if (!unlinkDirectRuntimeJournalLeaf(root, name, leaf.identity)) {
      throw new Error("A runtime cleanup receipt transient could not be retired.");
    }
  }
  const unique = new Map(receipts.map((receipt) => [
    receipt.runtimeGenerationId,
    receipt,
  ]));
  if (unique.size !== receipts.length) {
    throw new Error("A runtime cleanup receipt identity is duplicated.");
  }
  return [...unique.values()].sort((left, right) => (
    left.confirmedAt.localeCompare(right.confirmedAt)
    || left.runtimeGenerationId.localeCompare(right.runtimeGenerationId)
  ));
}

function readRuntimeCleanupReceiptIds(root: DirectRuntimeJournalRoot): string[] {
  return readRuntimeCleanupReceipts(root).map(({ runtimeGenerationId }) =>
    runtimeGenerationId);
}

export function runtimeCleanupReceiptIds(dataDirectory: string): string[] {
  return readRuntimeCleanupReceiptIds(pinDirectRuntimeJournalRoot(dataDirectory));
}

function publishReceipt(
  root: DirectRuntimeJournalRoot,
  runtimeGenerationId: string,
  hooks?: DirectRuntimeJournalTestHooks,
): boolean {
  try {
    const receipts = readRuntimeCleanupReceipts(root);
    if (receipts.some((receipt) => (
      receipt.runtimeGenerationId === runtimeGenerationId
    ))) return true;
    if (receipts.length >= MAX_RECEIPTS) return false;
    const hash = generationHash(runtimeGenerationId);
    return writeDirectRuntimeJournalLeaf(
      root,
      transientName(hash, "publish"),
      canonicalName(hash),
      storedReceipt({
        runtimeGenerationId,
        confirmedAt: new Date().toISOString(),
      }),
      hooks,
    );
  } catch {
    return false;
  }
}

export function publishRuntimeCleanupReceipt(
  dataDirectory: string,
  runtimeGenerationId: string,
): boolean {
  if (!GENERATION_PATTERN.test(runtimeGenerationId)) return false;
  try {
    return publishReceipt(
      pinDirectRuntimeJournalRoot(dataDirectory),
      runtimeGenerationId,
    );
  } catch {
    return false;
  }
}

function consumeReceipt(
  root: DirectRuntimeJournalRoot,
  runtimeGenerationId: string,
  hooks?: DirectRuntimeJournalTestHooks,
): boolean {
  const hash = generationHash(runtimeGenerationId);
  const canonical = canonicalName(hash);
  const consuming = transientName(hash, "consume");
  try {
    const source = readDirectRuntimeJournalLeaf(
      root,
      canonical,
      MAX_RECEIPT_BYTES,
    );
    if (!source) {
      const replay = readDirectRuntimeJournalLeaf(
        root,
        consuming,
        MAX_RECEIPT_BYTES,
      );
      return !!replay
        && !!parseReceipt(replay.bytes, hash)
        && unlinkDirectRuntimeJournalLeaf(root, consuming, replay.identity, hooks);
    }
    if (!parseReceipt(source.bytes, hash)) return false;
    if (!renameDirectRuntimeJournalLeaf(
      root,
      canonical,
      consuming,
      source.identity,
      hooks,
    )) return false;
    const moved = readDirectRuntimeJournalLeaf(
      root,
      consuming,
      MAX_RECEIPT_BYTES,
    );
    if (!moved || !parseReceipt(moved.bytes, hash)) return false;
    // An exact worker ACK already cleared the database lease. A valid consume
    // transient is therefore safe to replay and retire on app reconstruction.
    return unlinkDirectRuntimeJournalLeaf(
      root,
      consuming,
      moved.identity,
      hooks,
    );
  } catch {
    return false;
  }
}

export function consumeRuntimeCleanupReceipt(
  dataDirectory: string,
  runtimeGenerationId: string,
): boolean {
  if (!GENERATION_PATTERN.test(runtimeGenerationId)) return false;
  try {
    return consumeReceipt(
      pinDirectRuntimeJournalRoot(dataDirectory),
      runtimeGenerationId,
    );
  } catch {
    return false;
  }
}

export class RuntimeCleanupReceiptJournal {
  private readonly ids: Set<string>;
  private readonly root: DirectRuntimeJournalRoot;

  constructor(
    dataDirectory: string,
    private readonly testHooks?: DirectRuntimeJournalTestHooks,
  ) {
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
    this.ids = new Set(readRuntimeCleanupReceiptIds(this.root));
  }

  pending(): string[] {
    return [...this.ids];
  }

  has(runtimeGenerationId: string): boolean {
    return this.ids.has(runtimeGenerationId);
  }

  publish(runtimeGenerationId: string): boolean {
    if (
      !GENERATION_PATTERN.test(runtimeGenerationId)
      || !directRuntimeJournalRootIsPinned(this.root)
      || !publishReceipt(this.root, runtimeGenerationId, this.testHooks)
    ) return false;
    this.ids.add(runtimeGenerationId);
    return true;
  }

  consume(runtimeGenerationId: string): boolean {
    if (
      !this.ids.has(runtimeGenerationId)
      || !directRuntimeJournalRootIsPinned(this.root)
      || !consumeReceipt(this.root, runtimeGenerationId, this.testHooks)
    ) return false;
    this.ids.delete(runtimeGenerationId);
    return true;
  }
}
