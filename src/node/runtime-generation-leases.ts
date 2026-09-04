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
} from "./direct-runtime-journal.js";
import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "./runtime-identity-protocol.js";

const MAX_REGULAR_GENERATION_LEASES = 32;
const MAX_GENERATION_LEASES_WITH_RECOVERY_RESERVE = 33;
const MAX_LEASE_BYTES = 768;
const LEASE_PREFIX = ".runtime-generation-lease-";
const LEASE_SCHEMA_VERSION = 1;
const LEGACY_LEASE_DIRECTORY = ".runtime-generation-leases";

export interface RuntimeGenerationLease {
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
  readonly createdAt: string;
}

interface StoredRuntimeGenerationLease extends RuntimeGenerationLease {
  readonly version: typeof LEASE_SCHEMA_VERSION;
}

function generationHash(runtimeGenerationId: string): string {
  return createHash("sha256").update(runtimeGenerationId).digest("hex");
}

function canonicalName(hash: string): string {
  return `${LEASE_PREFIX}${hash}.json`;
}

function transientName(hash: string, operation: "publish" | "consume"): string {
  return `${LEASE_PREFIX}${hash}.${operation}.tmp`;
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function parseLease(
  bytes: Buffer,
  expectedHash: string,
): RuntimeGenerationLease | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    if (!exactObjectKeys(value, [
      "createdAt",
      "runtimeGenerationId",
      "systemBootId",
      "version",
    ])) return null;
    const lease = value as Partial<StoredRuntimeGenerationLease>;
    if (
      lease.version !== LEASE_SCHEMA_VERSION
      || !validRuntimeGenerationId(lease.runtimeGenerationId)
      || !validSystemBootId(lease.systemBootId)
      || typeof lease.createdAt !== "string"
      || !Number.isFinite(Date.parse(lease.createdAt))
      || generationHash(lease.runtimeGenerationId) !== expectedHash
    ) return null;
    return {
      runtimeGenerationId: lease.runtimeGenerationId,
      systemBootId: lease.systemBootId,
      createdAt: lease.createdAt,
    };
  } catch {
    return null;
  }
}

export function parseRuntimeGenerationLeaseLeaf(
  bytes: Buffer,
  expectedHash: string,
): RuntimeGenerationLease | null {
  return /^[0-9a-f]{64}$/u.test(expectedHash)
    ? parseLease(bytes, expectedHash)
    : null;
}

function storedLease(lease: RuntimeGenerationLease): Buffer {
  return Buffer.from(JSON.stringify({
    version: LEASE_SCHEMA_VERSION,
    runtimeGenerationId: lease.runtimeGenerationId,
    systemBootId: lease.systemBootId,
    createdAt: lease.createdAt,
  }), "utf8");
}

function readGenerationLeases(
  root: DirectRuntimeJournalRoot,
): RuntimeGenerationLease[] {
  if (directRuntimeJournalLeafExists(root, LEGACY_LEASE_DIRECTORY)) {
    throw new Error("The legacy runtime generation lease storage is unsafe.");
  }
  const names = listDirectRuntimeJournalLeaves(
    root,
    LEASE_PREFIX,
    MAX_GENERATION_LEASES_WITH_RECOVERY_RESERVE * 3,
  );
  const leases: RuntimeGenerationLease[] = [];
  for (const name of names) {
    const match = name.match(
      /^\.runtime-generation-lease-([0-9a-f]{64})\.(?:(json)|(publish|consume)\.tmp)$/u,
    );
    if (!match) {
      throw new Error("Runtime generation lease storage contains a foreign entry.");
    }
    if (match[3] === "publish") {
      // A publisher temp exists before the utility process is admitted. Even a
      // zero-byte or torn regular temp is therefore safe to discard, while the
      // fd-safe helper still rejects redirects and identity replacement.
      if (!discardDirectRuntimeJournalLeaf(root, name)) {
        throw new Error("A runtime generation lease transient could not be retired.");
      }
      continue;
    }
    const leaf = readDirectRuntimeJournalLeaf(root, name, MAX_LEASE_BYTES);
    if (!leaf) throw new Error("A runtime generation lease disappeared.");
    const lease = parseLease(leaf.bytes, match[1]!);
    if (!lease) throw new Error("A runtime generation lease is invalid.");
    if (!match[2]) {
      // Consume follows affirmative cleanup and is safe to finish.
      if (!unlinkDirectRuntimeJournalLeaf(root, name, leaf.identity)) {
        throw new Error("A runtime generation lease transient could not be retired.");
      }
      continue;
    }
    leases.push(lease);
    if (leases.length > MAX_GENERATION_LEASES_WITH_RECOVERY_RESERVE) {
      throw new Error("The runtime generation lease bound was exceeded.");
    }
  }
  return leases.sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.runtimeGenerationId.localeCompare(right.runtimeGenerationId)
  ));
}

export class RuntimeGenerationLeaseJournal {
  private invalid = false;
  private leases = new Map<string, RuntimeGenerationLease>();
  private root: DirectRuntimeJournalRoot | null = null;

  constructor(
    private readonly dataDirectory: string,
    private readonly testHooks?: DirectRuntimeJournalTestHooks,
  ) {
    this.refresh();
  }

  refresh(): void {
    try {
      this.root ??= pinDirectRuntimeJournalRoot(this.dataDirectory);
      const leases = readGenerationLeases(this.root);
      this.leases = new Map(leases.map((lease) => [lease.runtimeGenerationId, lease]));
      if (this.leases.size !== leases.length) {
        throw new Error("A runtime generation lease identity is duplicated.");
      }
      this.invalid = false;
    } catch {
      this.invalid = true;
    }
  }

  isValid(): boolean { return !this.invalid; }
  all(): RuntimeGenerationLease[] { return [...this.leases.values()]; }
  safetyLocked(): boolean { return this.invalid || this.leases.size > 0; }

  private failedMutation(): false {
    this.refresh();
    return false;
  }

  private publishWithinLimit(
    runtimeGenerationId: string,
    systemBootId: string,
    limit: number,
  ): boolean {
    if (
      this.invalid
      || !validRuntimeGenerationId(runtimeGenerationId)
      || !validSystemBootId(systemBootId)
    ) return false;
    this.refresh();
    if (this.invalid || !this.root) return false;
    const current = this.leases.get(runtimeGenerationId);
    if (current) return current.systemBootId === systemBootId;
    if (this.leases.size >= limit) return false;
    const lease: RuntimeGenerationLease = {
      runtimeGenerationId,
      systemBootId,
      createdAt: new Date().toISOString(),
    };
    const hash = generationHash(runtimeGenerationId);
    if (!writeDirectRuntimeJournalLeaf(
      this.root,
      transientName(hash, "publish"),
      canonicalName(hash),
      storedLease(lease),
      this.testHooks,
    )) {
      this.refresh();
      if (!directRuntimeJournalRootIsPinned(this.root)) this.invalid = true;
      return false;
    }
    this.leases.set(runtimeGenerationId, lease);
    return true;
  }

  publish(runtimeGenerationId: string, systemBootId: string): boolean {
    return this.publishWithinLimit(
      runtimeGenerationId,
      systemBootId,
      MAX_REGULAR_GENERATION_LEASES,
    );
  }

  publishWithLegacyRecoveryReserve(
    runtimeGenerationId: string,
    systemBootId: string,
    authorizedLegacyRuntimeGenerationIds: readonly string[],
  ): boolean {
    this.refresh();
    if (
      this.invalid
      || this.leases.size !== MAX_REGULAR_GENERATION_LEASES
      || authorizedLegacyRuntimeGenerationIds.length
        !== MAX_REGULAR_GENERATION_LEASES
      || new Set(authorizedLegacyRuntimeGenerationIds).size
        !== authorizedLegacyRuntimeGenerationIds.length
    ) return false;
    const authorized = new Set(authorizedLegacyRuntimeGenerationIds);
    if (this.all().some((lease) => (
      lease.systemBootId !== "unavailable"
      || !authorized.has(lease.runtimeGenerationId)
    ))) return false;
    return this.publishWithinLimit(
      runtimeGenerationId,
      systemBootId,
      MAX_GENERATION_LEASES_WITH_RECOVERY_RESERVE,
    );
  }

  publishWithModernRecoveryReserve(
    runtimeGenerationId: string,
    systemBootId: string,
    authorizedRuntimeGenerationIds: readonly string[],
  ): boolean {
    this.refresh();
    if (
      this.invalid
      || this.leases.size !== MAX_REGULAR_GENERATION_LEASES
      || authorizedRuntimeGenerationIds.length
        !== MAX_REGULAR_GENERATION_LEASES
      || new Set(authorizedRuntimeGenerationIds).size
        !== authorizedRuntimeGenerationIds.length
    ) return false;
    const authorized = new Set(authorizedRuntimeGenerationIds);
    if (this.all().some((lease) => (
      !authorized.has(lease.runtimeGenerationId)
    ))) return false;
    return this.publishWithinLimit(
      runtimeGenerationId,
      systemBootId,
      MAX_GENERATION_LEASES_WITH_RECOVERY_RESERVE,
    );
  }

  publishWithManualRecoveryReserve(
    runtimeGenerationId: string,
    systemBootId: string,
    authorizedLegacyRuntimeGenerationIds: readonly string[],
    authorizedModernRuntimeGenerationIds: readonly string[],
  ): boolean {
    this.refresh();
    const authorizedLegacy = new Set(authorizedLegacyRuntimeGenerationIds);
    const authorizedModern = new Set(authorizedModernRuntimeGenerationIds);
    if (
      this.invalid
      || this.leases.size !== MAX_REGULAR_GENERATION_LEASES
      || authorizedLegacy.size !== authorizedLegacyRuntimeGenerationIds.length
      || authorizedModern.size !== authorizedModernRuntimeGenerationIds.length
      || authorizedLegacy.size + authorizedModern.size
        !== MAX_REGULAR_GENERATION_LEASES
      || [...authorizedLegacy].some((generationId) =>
        authorizedModern.has(generationId))
      || this.all().some((lease) => (
        authorizedLegacy.has(lease.runtimeGenerationId)
          ? lease.systemBootId !== "unavailable"
          : !authorizedModern.has(lease.runtimeGenerationId)
      ))
    ) return false;
    return this.publishWithinLimit(
      runtimeGenerationId,
      systemBootId,
      MAX_GENERATION_LEASES_WITH_RECOVERY_RESERVE,
    );
  }

  consume(runtimeGenerationId: string): boolean {
    if (this.invalid || !this.root) return false;
    this.refresh();
    if (this.invalid || !this.root) return false;
    const current = this.leases.get(runtimeGenerationId);
    if (!current) return false;
    const hash = generationHash(runtimeGenerationId);
    const canonical = canonicalName(hash);
    const source = readDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      MAX_LEASE_BYTES,
    );
    if (!source || !parseLease(source.bytes, hash)) return this.failedMutation();
    const consuming = transientName(hash, "consume");
    if (!renameDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      consuming,
      source.identity,
      this.testHooks,
    )) return this.failedMutation();
    const moved = readDirectRuntimeJournalLeaf(
      this.root,
      consuming,
      MAX_LEASE_BYTES,
    );
    if (!moved || !parseLease(moved.bytes, hash)) return this.failedMutation();
    if (!unlinkDirectRuntimeJournalLeaf(
      this.root,
      consuming,
      moved.identity,
      this.testHooks,
    )) {
      return this.failedMutation();
    }
    this.leases.delete(runtimeGenerationId);
    return true;
  }

  consumeExact(expected: RuntimeGenerationLease): boolean {
    if (this.invalid || !this.root) return false;
    this.refresh();
    if (this.invalid || !this.root) return false;
    const current = this.leases.get(expected.runtimeGenerationId);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
      return false;
    }
    const hash = generationHash(expected.runtimeGenerationId);
    const canonical = canonicalName(hash);
    const source = readDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      MAX_LEASE_BYTES,
    );
    const parsed = source && parseLease(source.bytes, hash);
    if (
      !source
      || !parsed
      || JSON.stringify(parsed) !== JSON.stringify(expected)
    ) return this.failedMutation();
    const consuming = transientName(hash, "consume");
    if (!renameDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      consuming,
      source.identity,
      this.testHooks,
    )) return this.failedMutation();
    if (!unlinkDirectRuntimeJournalLeaf(
      this.root,
      consuming,
      source.identity,
      this.testHooks,
    )) return this.failedMutation();
    this.leases.delete(expected.runtimeGenerationId);
    return true;
  }

  clearRuntimeGeneration(runtimeGenerationId: string): boolean {
    this.refresh();
    if (this.invalid) return false;
    return !this.leases.has(runtimeGenerationId)
      || this.consume(runtimeGenerationId);
  }

  clearUnavailableRuntimeGeneration(runtimeGenerationId: string): boolean {
    this.refresh();
    if (this.invalid) return false;
    const lease = this.leases.get(runtimeGenerationId);
    return !lease
      || (
        lease.systemBootId === "unavailable"
        && this.consume(runtimeGenerationId)
      );
  }

  clearPriorBootSessions(
    systemBootId: string,
    preservedRuntimeGenerationIds: ReadonlySet<string> = new Set(),
  ): boolean {
    if (!validSystemBootId(systemBootId)) return false;
    if ([...preservedRuntimeGenerationIds].some((runtimeGenerationId) => (
      !validRuntimeGenerationId(runtimeGenerationId)
    ))) return false;
    this.refresh();
    if (this.invalid) return false;
    if (systemBootId === "unavailable") return true;
    return this.all()
      .filter((lease) => (
        lease.systemBootId !== "unavailable"
        && lease.systemBootId !== systemBootId
        && !preservedRuntimeGenerationIds.has(lease.runtimeGenerationId)
      ))
      .every((lease) => this.consume(lease.runtimeGenerationId));
  }
}
