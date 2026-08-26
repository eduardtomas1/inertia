import { createHash, randomUUID } from "node:crypto";

import {
  discardDirectRuntimeJournalLeaf,
  directRuntimeJournalRootIsPinned,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  renameDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
  type DirectRuntimeJournalLeaf,
  type DirectRuntimeJournalTestHooks,
} from "../node/direct-runtime-journal.js";
import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "../node/runtime-process-protocol.js";

const MAX_AUTHORITIES = 32;
const MAX_AUTHORITY_BYTES = 8 * 1_024;
const AUTHORITY_PREFIX = ".runtime-legacy-recovery-authority-";
const AUTHORITY_SCHEMA_VERSION = 2;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type LegacyRuntimeRecoveryPlatform = "darwin" | "linux" | "win32";

export interface LegacyRuntimeRecoveryAuthority {
  readonly runtimeGenerationId: string;
  readonly runtimeGenerationIds: readonly string[];
  readonly platform: LegacyRuntimeRecoveryPlatform;
  readonly systemBootId: string;
  readonly operationId: string;
  readonly snapshotDigest: string;
}

interface StoredLegacyRuntimeRecoveryAuthority
  extends LegacyRuntimeRecoveryAuthority {
  readonly version: typeof AUTHORITY_SCHEMA_VERSION;
}

function generationHash(runtimeGenerationId: string): string {
  return createHash("sha256").update(runtimeGenerationId).digest("hex");
}

function canonicalName(hash: string): string {
  return `${AUTHORITY_PREFIX}${hash}.json`;
}

function transientName(hash: string, operation: "publish" | "consume"): string {
  return `${AUTHORITY_PREFIX}${hash}.${operation}.tmp`;
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function snapshotDigest(
  operationId: string,
  platform: LegacyRuntimeRecoveryPlatform,
  systemBootId: string,
  runtimeGenerationIds: readonly string[],
): string {
  return createHash("sha256").update(JSON.stringify({
    operationId,
    platform,
    systemBootId,
    runtimeGenerationIds,
  })).digest("hex");
}

function parseAuthority(
  bytes: Buffer,
  expectedHash: string,
): LegacyRuntimeRecoveryAuthority | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    if (!exactObjectKeys(value, [
      "operationId",
      "platform",
      "runtimeGenerationId",
      "runtimeGenerationIds",
      "snapshotDigest",
      "systemBootId",
      "version",
    ])) return null;
    const authority = value as Partial<StoredLegacyRuntimeRecoveryAuthority>;
    if (
      authority.version !== AUTHORITY_SCHEMA_VERSION
      || !validRuntimeGenerationId(authority.runtimeGenerationId)
      || !Array.isArray(authority.runtimeGenerationIds)
      || authority.runtimeGenerationIds.length < 1
      || authority.runtimeGenerationIds.length > MAX_AUTHORITIES
      || new Set(authority.runtimeGenerationIds).size
        !== authority.runtimeGenerationIds.length
      || authority.runtimeGenerationIds.some((runtimeGenerationId) =>
        !validRuntimeGenerationId(runtimeGenerationId))
      || !authority.runtimeGenerationIds.includes(
        authority.runtimeGenerationId,
      )
      || [...authority.runtimeGenerationIds]
        .sort((left, right) => left.localeCompare(right)).some(
        (runtimeGenerationId, index) => (
          runtimeGenerationId !== authority.runtimeGenerationIds?.[index]
        ),
      )
      || (
        authority.platform !== "darwin"
        && authority.platform !== "linux"
        && authority.platform !== "win32"
      )
      || !validSystemBootId(authority.systemBootId)
      || typeof authority.operationId !== "string"
      || !UUID_PATTERN.test(authority.operationId)
      || typeof authority.snapshotDigest !== "string"
      || !/^[0-9a-f]{64}$/u.test(authority.snapshotDigest)
      || authority.snapshotDigest !== snapshotDigest(
        authority.operationId,
        authority.platform,
        authority.systemBootId,
        authority.runtimeGenerationIds,
      )
      || generationHash(authority.runtimeGenerationId) !== expectedHash
    ) return null;
    return {
      runtimeGenerationId: authority.runtimeGenerationId,
      runtimeGenerationIds: [...authority.runtimeGenerationIds],
      platform: authority.platform,
      systemBootId: authority.systemBootId,
      operationId: authority.operationId,
      snapshotDigest: authority.snapshotDigest,
    };
  } catch {
    return null;
  }
}

function storedAuthority(authority: LegacyRuntimeRecoveryAuthority): Buffer {
  return Buffer.from(JSON.stringify({
    version: AUTHORITY_SCHEMA_VERSION,
    runtimeGenerationId: authority.runtimeGenerationId,
    runtimeGenerationIds: authority.runtimeGenerationIds,
    platform: authority.platform,
    systemBootId: authority.systemBootId,
    operationId: authority.operationId,
    snapshotDigest: authority.snapshotDigest,
  }), "utf8");
}

function readAuthorities(
  root: DirectRuntimeJournalRoot,
): LegacyRuntimeRecoveryAuthority[] {
  const initialNames = listDirectRuntimeJournalLeaves(
    root,
    AUTHORITY_PREFIX,
    MAX_AUTHORITIES * 3,
  );
  for (const name of initialNames) {
    const match = name.match(
      /^\.runtime-legacy-recovery-authority-([0-9a-f]{64})\.(?:(json)|(publish|consume)\.tmp)$/u,
    );
    if (!match) {
      throw new Error("Legacy runtime recovery authority storage contains a foreign entry.");
    }
    if (match[3] !== "publish") continue;
    let leaf: DirectRuntimeJournalLeaf | null;
    try {
      leaf = readDirectRuntimeJournalLeaf(
        root,
        name,
        MAX_AUTHORITY_BYTES,
      );
    } catch (error) {
      if (
        match[3] === "publish"
        && discardDirectRuntimeJournalLeaf(root, name)
      ) continue;
      throw error;
    }
    if (!leaf) {
      throw new Error("A legacy runtime recovery authority disappeared.");
    }
    const authority = parseAuthority(leaf.bytes, match[1]!);
    if (!authority) {
      if (
        match[3] === "publish"
        && discardDirectRuntimeJournalLeaf(root, name)
      ) continue;
      throw new Error("A legacy runtime recovery authority is invalid.");
    }
    const targetName = canonicalName(match[1]!);
    const target = readDirectRuntimeJournalLeaf(
      root,
      targetName,
      MAX_AUTHORITY_BYTES,
    );
    if (target) {
      const published = parseAuthority(target.bytes, match[1]!);
      if (!published) {
        throw new Error("A legacy runtime recovery authority transient conflicts.");
      }
      if (
        published.platform === authority.platform
        && published.systemBootId === authority.systemBootId
        && published.operationId === authority.operationId
        && published.snapshotDigest === authority.snapshotDigest
      ) {
        if (!unlinkDirectRuntimeJournalLeaf(root, name, leaf.identity)) {
          throw new Error("A legacy runtime recovery authority transient could not be retired.");
        }
      } else if (!renameDirectRuntimeJournalLeaf(
        root,
        name,
        targetName,
        leaf.identity,
      )) {
        throw new Error("A legacy runtime recovery authority could not be rebound.");
      }
    } else if (!renameDirectRuntimeJournalLeaf(
      root,
      name,
      targetName,
      leaf.identity,
    )) {
      throw new Error("A legacy runtime recovery authority transient could not be published.");
    }
  }

  const names = listDirectRuntimeJournalLeaves(
    root,
    AUTHORITY_PREFIX,
    MAX_AUTHORITIES * 3,
  );
  const authorities: LegacyRuntimeRecoveryAuthority[] = [];
  for (const name of names) {
    const match = name.match(
      /^\.runtime-legacy-recovery-authority-([0-9a-f]{64})\.(?:(json)|(publish|consume)\.tmp)$/u,
    );
    if (!match || match[3] === "publish") {
      throw new Error("Legacy runtime recovery authority storage contains an incomplete entry.");
    }
    const leaf = readDirectRuntimeJournalLeaf(
      root,
      name,
      MAX_AUTHORITY_BYTES,
    );
    if (!leaf) {
      throw new Error("A legacy runtime recovery authority disappeared.");
    }
    const authority = parseAuthority(leaf.bytes, match[1]!);
    if (!authority) {
      throw new Error("A legacy runtime recovery authority is invalid.");
    }
    if (match[3] === "consume") {
      if (!unlinkDirectRuntimeJournalLeaf(root, name, leaf.identity)) {
        throw new Error("A legacy runtime recovery authority transient could not be retired.");
      }
      continue;
    }
    authorities.push(authority);
    if (authorities.length > MAX_AUTHORITIES) {
      throw new Error("The legacy runtime recovery authority bound was exceeded.");
    }
  }
  const unique = new Map(authorities.map((authority) => [
    authority.runtimeGenerationId,
    authority,
  ]));
  if (unique.size !== authorities.length) {
    throw new Error("A legacy runtime recovery authority identity is duplicated.");
  }
  return [...unique.values()].sort((left, right) =>
    left.runtimeGenerationId.localeCompare(right.runtimeGenerationId));
}

export class LegacyRuntimeRecoveryAuthorityJournal {
  private readonly root: DirectRuntimeJournalRoot;
  private authorities: Map<string, LegacyRuntimeRecoveryAuthority>;

  constructor(
    dataDirectory: string,
    private readonly testHooks?: DirectRuntimeJournalTestHooks,
  ) {
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
    this.authorities = new Map(readAuthorities(this.root).map((authority) => [
      authority.runtimeGenerationId,
      authority,
    ]));
  }

  private refresh(): void {
    this.authorities = new Map(readAuthorities(this.root).map((authority) => [
      authority.runtimeGenerationId,
      authority,
    ]));
  }

  pending(
    platform: LegacyRuntimeRecoveryPlatform,
    systemBootId: string,
  ): string[] {
    if (!validSystemBootId(systemBootId)) return [];
    return [...this.authorities.values()]
      .filter((authority) => (
        authority.platform === platform
        && authority.systemBootId === systemBootId
        && authority.runtimeGenerationIds.every((runtimeGenerationId) => {
          const member = this.authorities.get(runtimeGenerationId);
          return !!member
            && member.operationId === authority.operationId
            && member.snapshotDigest === authority.snapshotDigest;
        })
      ))
      .map(({ runtimeGenerationId }) => runtimeGenerationId);
  }

  has(
    runtimeGenerationId: string,
    platform: LegacyRuntimeRecoveryPlatform,
    systemBootId: string,
  ): boolean {
    if (!validSystemBootId(systemBootId)) return false;
    const authority = this.authorities.get(runtimeGenerationId);
    return !!authority
      && authority.platform === platform
      && authority.systemBootId === systemBootId;
  }

  publish(
    runtimeGenerationId: string,
    platform: LegacyRuntimeRecoveryPlatform,
    systemBootId: string,
    operationId: string = randomUUID(),
  ): boolean {
    return this.publishMember(
      runtimeGenerationId,
      [runtimeGenerationId],
      platform,
      systemBootId,
      operationId,
    );
  }

  private publishMember(
    runtimeGenerationId: string,
    runtimeGenerationIdsValue: readonly string[],
    platform: LegacyRuntimeRecoveryPlatform,
    systemBootId: string,
    operationId: string,
  ): boolean {
    const runtimeGenerationIds = [...runtimeGenerationIdsValue].sort();
    const digest = snapshotDigest(
      operationId,
      platform,
      systemBootId,
      runtimeGenerationIds,
    );
    if (
      !validRuntimeGenerationId(runtimeGenerationId)
      || !validSystemBootId(systemBootId)
      || !UUID_PATTERN.test(operationId)
      || runtimeGenerationIds.length < 1
      || runtimeGenerationIds.length > MAX_AUTHORITIES
      || new Set(runtimeGenerationIds).size !== runtimeGenerationIds.length
      || runtimeGenerationIds.some((generationId) =>
        !validRuntimeGenerationId(generationId))
      || !runtimeGenerationIds.includes(runtimeGenerationId)
      || !directRuntimeJournalRootIsPinned(this.root)
    ) return false;
    const existing = this.authorities.get(runtimeGenerationId);
    if (existing) {
      if (
        existing.platform === platform
        && existing.systemBootId === systemBootId
        && existing.operationId === operationId
        && existing.snapshotDigest === digest
      ) return true;
    }
    if (!existing && this.authorities.size >= MAX_AUTHORITIES) return false;
    const authority: LegacyRuntimeRecoveryAuthority = {
      runtimeGenerationId,
      runtimeGenerationIds,
      platform,
      systemBootId,
      operationId,
      snapshotDigest: digest,
    };
    const hash = generationHash(runtimeGenerationId);
    if (!writeDirectRuntimeJournalLeaf(
      this.root,
      transientName(hash, "publish"),
      canonicalName(hash),
      storedAuthority(authority),
      this.testHooks,
    )) return false;
    this.authorities.set(runtimeGenerationId, authority);
    return true;
  }

  publishBatch(
    runtimeGenerationIds: readonly string[],
    platform: LegacyRuntimeRecoveryPlatform,
    systemBootId: string,
  ): boolean {
    if (
      runtimeGenerationIds.length < 1
      || runtimeGenerationIds.length > MAX_AUTHORITIES
      || new Set(runtimeGenerationIds).size !== runtimeGenerationIds.length
      || runtimeGenerationIds.some((runtimeGenerationId) =>
        !validRuntimeGenerationId(runtimeGenerationId))
      || !validSystemBootId(systemBootId)
    ) return false;
    const sortedRuntimeGenerationIds = [...runtimeGenerationIds].sort();
    const existing = runtimeGenerationIds
      .map((runtimeGenerationId) => this.authorities.get(runtimeGenerationId))
      .filter((authority): authority is LegacyRuntimeRecoveryAuthority =>
        authority?.platform === platform
        && authority.systemBootId === systemBootId);
    const operationId = existing[0]?.operationId ?? randomUUID();
    const digest = snapshotDigest(
      operationId,
      platform,
      systemBootId,
      sortedRuntimeGenerationIds,
    );
    if (existing.some((authority) => (
      authority.operationId !== operationId
      || authority.snapshotDigest !== digest
      || JSON.stringify(authority.runtimeGenerationIds)
        !== JSON.stringify(sortedRuntimeGenerationIds)
    ))) {
      return false;
    }
    // A fully-written publish transient is itself durable authority. Refresh
    // completes it after a crash. A second bounded pass resumes only entries
    // whose first direct-journal publication never became durable.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const runtimeGenerationId of runtimeGenerationIds) {
        if (this.has(runtimeGenerationId, platform, systemBootId)) continue;
        this.publishMember(
          runtimeGenerationId,
          sortedRuntimeGenerationIds,
          platform,
          systemBootId,
          operationId,
        );
      }
      this.refresh();
      if (runtimeGenerationIds.every((runtimeGenerationId) =>
        this.has(runtimeGenerationId, platform, systemBootId))) return true;
    }
    return false;
  }

  retireExpired(
    platform: LegacyRuntimeRecoveryPlatform,
    systemBootId: string,
    protectedRuntimeGenerationIds: ReadonlySet<string> = new Set(),
  ): boolean {
    if (!validSystemBootId(systemBootId)) return false;
    try {
      this.refresh();
      const expired = [...this.authorities.values()].filter((authority) => (
        authority.platform !== platform
        || authority.systemBootId !== systemBootId
        || authority.runtimeGenerationIds.some((runtimeGenerationId) => {
          const member = this.authorities.get(runtimeGenerationId);
          return !protectedRuntimeGenerationIds.has(runtimeGenerationId)
            || !member
            || member.platform !== authority.platform
            || member.systemBootId !== authority.systemBootId
            || member.operationId !== authority.operationId
            || member.snapshotDigest !== authority.snapshotDigest;
        })
      ));
      for (const authority of expired) {
        if (!this.consume(
          authority.runtimeGenerationId,
          authority.platform,
          authority.systemBootId,
        )) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  consume(
    runtimeGenerationId: string,
    expectedPlatform: LegacyRuntimeRecoveryPlatform,
    expectedSystemBootId: string,
  ): boolean {
    const expected = this.authorities.get(runtimeGenerationId);
    if (
      !expected
      || expected.platform !== expectedPlatform
      || expected.systemBootId !== expectedSystemBootId
      || !directRuntimeJournalRootIsPinned(this.root)
    ) return false;
    const hash = generationHash(runtimeGenerationId);
    const canonical = canonicalName(hash);
    const source = readDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      MAX_AUTHORITY_BYTES,
    );
    const sourceAuthority = source
      ? parseAuthority(source.bytes, hash)
      : null;
    if (
      !source
      || !sourceAuthority
      || sourceAuthority.operationId !== expected.operationId
      || sourceAuthority.platform !== expected.platform
      || sourceAuthority.systemBootId !== expected.systemBootId
      || sourceAuthority.snapshotDigest !== expected.snapshotDigest
    ) return false;
    const consuming = transientName(hash, "consume");
    if (!renameDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      consuming,
      source.identity,
      this.testHooks,
    )) return false;
    const moved = readDirectRuntimeJournalLeaf(
      this.root,
      consuming,
      MAX_AUTHORITY_BYTES,
    );
    if (
      !moved
      || !parseAuthority(moved.bytes, hash)
      || !unlinkDirectRuntimeJournalLeaf(
        this.root,
        consuming,
        moved.identity,
        this.testHooks,
      )
    ) return false;
    this.authorities.delete(runtimeGenerationId);
    return true;
  }
}
