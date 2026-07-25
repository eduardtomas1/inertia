const REGISTRY_FORMAT_VERSION = 1 as const;
const OPERATION_FORMAT_VERSION = 1 as const;
const REGISTRY_REF = "refs/inertia/registries/selective-reversals";
const BACKUP_REF_PREFIX = "refs/inertia/reversal-backups";
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_REGISTRY_OPERATIONS = 64;

export const REVERSAL_BACKUP_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const REVERSAL_PREPARED_RETENTION_MS = 15 * 60 * 1_000;
export const REVERSAL_MAX_ACTIVE_BACKUPS = 8;
export const REVERSAL_REGISTRY_REF = REGISTRY_REF;

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export type ReversalLayer = "index" | "worktree";
export type ReversalOperationStatus =
  | "prepared"
  | "applying"
  | "applied"
  | "undoing"
  | "failed"
  | "recovery-required"
  | "undone"
  | "expired";
export type ReversalBackupRole = "pre-worktree" | "pre-index" | "post-worktree" | "post-index";

export interface ReversalRepositoryIdentity {
  commonDirectory: string;
  fingerprint: string;
}

export interface ReversalCheckoutIdentity {
  rootDirectory: string;
  gitDirectory: string;
  fingerprint: string;
}

export interface ReversalBackupReference {
  role: ReversalBackupRole;
  ref: string;
  oid: string;
}

export interface ReversalOperationRecord {
  formatVersion: typeof OPERATION_FORMAT_VERSION;
  operationId: string;
  repository: ReversalRepositoryIdentity;
  checkout: ReversalCheckoutIdentity;
  filePath: string;
  affectedLayers: ReversalLayer[];
  backupReferences: ReversalBackupReference[];
  createdAt: string;
  appliedAt: string | null;
  undoneAt: string | null;
  failedAt: string | null;
  expiredAt: string | null;
  status: ReversalOperationStatus;
  expiresAt: string;
  selectedLineCount: number;
  preWorktreeOid: string;
  preWorktreeMode: number;
  preIndexOid: string;
  preIndexMode: string;
  postWorktreeOid: string;
  postWorktreeMode: number;
  postIndexOid: string;
  postIndexMode: string;
}

interface ReversalRegistry {
  formatVersion: typeof REGISTRY_FORMAT_VERSION;
  repositoryIdentity: string;
  operations: ReversalOperationRecord[];
}

export interface ReversalRegistryStorage {
  readRef(ref: string): Promise<{ oid: string; content: Buffer } | null>;
  writeBlob(content: Buffer): Promise<string>;
  compareAndSwapRef(ref: string, nextOid: string, expectedOid: string | null): Promise<boolean>;
  createRef(ref: string, oid: string): Promise<boolean>;
  deleteRef(ref: string, expectedOid: string): Promise<boolean>;
}

export interface PrepareReversalOperation {
  operationId: string;
  filePath: string;
  affectedLayers: ReversalLayer[];
  selectedLineCount: number;
  preWorktreeOid: string;
  preWorktreeMode: number;
  preIndexOid: string;
  preIndexMode: string;
  postWorktreeOid: string;
  postWorktreeMode: number;
  postIndexOid: string;
  postIndexMode: string;
}

export class ReversalRegistryError extends Error {
  readonly kind: "incompatible" | "conflict" | "not-found" | "invalid";

  constructor(kind: ReversalRegistryError["kind"], message: string) {
    super(message);
    this.name = "ReversalRegistryError";
    this.kind = kind;
  }
}

type RegistryRead =
  | { kind: "missing" }
  | { kind: "known"; oid: string; registry: ReversalRegistry }
  | { kind: "incompatible" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown, nullable = false): value is string | null {
  if (nullable && value === null) return true;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isIdentity(value: unknown, kind: "repository" | "checkout"): boolean {
  if (!isRecord(value) || typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(value.fingerprint)) return false;
  return kind === "repository"
    ? typeof value.commonDirectory === "string" && value.commonDirectory.length > 0
    : typeof value.rootDirectory === "string"
      && value.rootDirectory.length > 0
      && typeof value.gitDirectory === "string"
      && value.gitDirectory.length > 0;
}

function expectedBackupRefs(operationId: string): Map<ReversalBackupRole, string> {
  const prefix = `${BACKUP_REF_PREFIX}/${operationId}`;
  return new Map<ReversalBackupRole, string>([
    ["pre-worktree", `${prefix}/pre-worktree`],
    ["pre-index", `${prefix}/pre-index`],
    ["post-worktree", `${prefix}/post-worktree`],
    ["post-index", `${prefix}/post-index`],
  ]);
}

function validBackupReferences(value: unknown, operationId: string): value is ReversalBackupReference[] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const expected = expectedBackupRefs(operationId);
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !["pre-worktree", "pre-index", "post-worktree", "post-index"].includes(String(entry.role))
      || typeof entry.ref !== "string"
      || typeof entry.oid !== "string"
      || !OBJECT_ID.test(entry.oid)
    ) return false;
    const role = entry.role as ReversalBackupRole;
    if (entry.ref !== expected.get(role) || seen.has(role)) return false;
    seen.add(role);
  }
  return true;
}

function validOperation(value: unknown): value is ReversalOperationRecord {
  if (!isRecord(value) || value.formatVersion !== OPERATION_FORMAT_VERSION) return false;
  const id = value.operationId;
  if (typeof id !== "string" || !OPERATION_ID.test(id)) return false;
  if (
    !isIdentity(value.repository, "repository")
    || !isIdentity(value.checkout, "checkout")
    || typeof value.filePath !== "string"
    || value.filePath.length === 0
    || value.filePath.length > 4_096
    || value.filePath.startsWith(":")
    || /[\0\r\n]/u.test(value.filePath)
    || !Array.isArray(value.affectedLayers)
    || value.affectedLayers.length === 0
    || value.affectedLayers.some((layer) => layer !== "index" && layer !== "worktree")
    || new Set(value.affectedLayers).size !== value.affectedLayers.length
    || !validBackupReferences(value.backupReferences, id)
    || !isIsoTimestamp(value.createdAt)
    || !isIsoTimestamp(value.appliedAt, true)
    || !isIsoTimestamp(value.undoneAt, true)
    || !isIsoTimestamp(value.failedAt, true)
    || !isIsoTimestamp(value.expiredAt, true)
    || !["prepared", "applying", "applied", "undoing", "failed", "recovery-required", "undone", "expired"].includes(String(value.status))
    || !isIsoTimestamp(value.expiresAt)
    || !Number.isSafeInteger(value.selectedLineCount)
    || Number(value.selectedLineCount) < 1
    || typeof value.preWorktreeOid !== "string"
    || !OBJECT_ID.test(value.preWorktreeOid)
    || typeof value.preIndexOid !== "string"
    || !OBJECT_ID.test(value.preIndexOid)
    || typeof value.postWorktreeOid !== "string"
    || !OBJECT_ID.test(value.postWorktreeOid)
    || typeof value.postIndexOid !== "string"
    || !OBJECT_ID.test(value.postIndexOid)
    || !Number.isSafeInteger(value.preWorktreeMode)
    || Number(value.preWorktreeMode) < 0
    || !Number.isSafeInteger(value.postWorktreeMode)
    || Number(value.postWorktreeMode) < 0
    || typeof value.preIndexMode !== "string"
    || !/^[0-7]{6}$/u.test(value.preIndexMode)
    || typeof value.postIndexMode !== "string"
    || !/^[0-7]{6}$/u.test(value.postIndexMode)
  ) return false;
  const references = new Map((value.backupReferences as ReversalBackupReference[]).map(({ role, oid }) => [role, oid]));
  return references.get("pre-worktree") === value.preWorktreeOid
    && references.get("pre-index") === value.preIndexOid
    && references.get("post-worktree") === value.postWorktreeOid
    && references.get("post-index") === value.postIndexOid;
}

function decodeRegistry(content: Buffer): ReversalRegistry | null {
  if (content.length === 0 || content.length > MAX_REGISTRY_BYTES) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(content.toString("utf8")); }
  catch { return null; }
  if (
    !isRecord(decoded)
    || decoded.formatVersion !== REGISTRY_FORMAT_VERSION
    || typeof decoded.repositoryIdentity !== "string"
    || !/^[0-9a-f]{64}$/u.test(decoded.repositoryIdentity)
    || !Array.isArray(decoded.operations)
    || decoded.operations.length > MAX_REGISTRY_OPERATIONS
    || !decoded.operations.every(validOperation)
    || new Set(decoded.operations.map((operation) => operation.operationId)).size !== decoded.operations.length
  ) return null;
  return decoded as unknown as ReversalRegistry;
}

function encodeRegistry(registry: ReversalRegistry): Buffer {
  const content = Buffer.from(JSON.stringify(registry), "utf8");
  if (content.length > MAX_REGISTRY_BYTES) {
    throw new ReversalRegistryError("invalid", "The selective-reversal registry is too large.");
  }
  return content;
}

function pruneHistoricalOperations(operations: ReversalOperationRecord[]): ReversalOperationRecord[] {
  if (operations.length < MAX_REGISTRY_OPERATIONS) return operations;
  const terminal = operations
    .filter(({ status }) => status === "failed" || status === "undone" || status === "expired")
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const remove = new Set(terminal.slice(0, Math.max(0, operations.length - MAX_REGISTRY_OPERATIONS + 1)).map(({ operationId }) => operationId));
  const retained = operations.filter(({ operationId }) => !remove.has(operationId));
  if (retained.length >= MAX_REGISTRY_OPERATIONS) {
    throw new ReversalRegistryError("conflict", "Too many selective reversals still require recovery or Undo.");
  }
  return retained;
}

function cloneOperation(operation: ReversalOperationRecord): ReversalOperationRecord {
  return {
    ...operation,
    repository: { ...operation.repository },
    checkout: { ...operation.checkout },
    affectedLayers: [...operation.affectedLayers],
    backupReferences: operation.backupReferences.map((reference) => ({ ...reference })),
  };
}

export class ReversalRegistryController {
  readonly #storage: ReversalRegistryStorage;
  readonly #repository: ReversalRepositoryIdentity;
  readonly #checkout: ReversalCheckoutIdentity;
  readonly #now: () => number;

  constructor(
    storage: ReversalRegistryStorage,
    repository: ReversalRepositoryIdentity,
    checkout: ReversalCheckoutIdentity,
    now: () => number = Date.now,
  ) {
    this.#storage = storage;
    this.#repository = repository;
    this.#checkout = checkout;
    this.#now = now;
  }

  async #read(): Promise<RegistryRead> {
    const stored = await this.#storage.readRef(REGISTRY_REF);
    if (!stored) return { kind: "missing" };
    const registry = decodeRegistry(stored.content);
    return registry ? { kind: "known", oid: stored.oid, registry } : { kind: "incompatible" };
  }

  #assertRepository(registry: ReversalRegistry): void {
    if (registry.repositoryIdentity !== this.#repository.fingerprint) {
      throw new ReversalRegistryError("conflict", "The selective-reversal registry belongs to a different repository identity.");
    }
  }

  async #mutate(
    transform: (registry: ReversalRegistry) => ReversalRegistry,
  ): Promise<ReversalRegistry> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await this.#read();
      if (current.kind === "incompatible") {
        throw new ReversalRegistryError(
          "incompatible",
          "A newer or unreadable selective-reversal registry was preserved. This reversal cannot be registered safely.",
        );
      }
      const registry: ReversalRegistry = current.kind === "missing"
        ? { formatVersion: REGISTRY_FORMAT_VERSION, repositoryIdentity: this.#repository.fingerprint, operations: [] }
        : current.registry;
      this.#assertRepository(registry);
      const next = transform(registry);
      const oid = await this.#storage.writeBlob(encodeRegistry(next));
      if (await this.#storage.compareAndSwapRef(REGISTRY_REF, oid, current.kind === "known" ? current.oid : null)) return next;
    }
    throw new ReversalRegistryError("conflict", "The selective-reversal registry changed repeatedly. Try again.");
  }

  async cleanup(maxActiveBackups = REVERSAL_MAX_ACTIVE_BACKUPS): Promise<void> {
    const current = await this.#read();
    if (current.kind !== "known") return;
    if (current.registry.repositoryIdentity !== this.#repository.fingerprint) return;
    const now = this.#now();
    const active = current.registry.operations
      .map((operation, order) => ({ operation, order }))
      .filter(({ operation }) => operation.status === "prepared" || operation.status === "applied")
      .sort((left, right) => (
        Date.parse(right.operation.createdAt) - Date.parse(left.operation.createdAt)
        || right.order - left.order
      ));
    const overLimit = new Set(active.slice(Math.max(0, maxActiveBackups)).map(({ operation }) => operation.operationId));
    const shouldExpire = (operation: ReversalOperationRecord): boolean => (
      (operation.status === "prepared" || operation.status === "applied")
      && (Date.parse(operation.expiresAt) <= now || overLimit.has(operation.operationId))
    );
    if (current.registry.operations.some(shouldExpire)) {
      await this.#mutate((registry) => ({
        ...registry,
        operations: registry.operations.map((operation) => shouldExpire(operation)
          ? {
            ...operation,
            status: "expired",
            expiredAt: new Date(now).toISOString(),
          }
          : operation),
      }));
    }
    const latest = await this.#read();
    if (latest.kind !== "known" || latest.registry.repositoryIdentity !== this.#repository.fingerprint) return;
    await Promise.all(latest.registry.operations
      .filter(({ status }) => status === "failed" || status === "undone" || status === "expired")
      .flatMap(({ backupReferences }) => backupReferences)
      .map(({ ref, oid }) => this.#storage.deleteRef(ref, oid)));
  }

  async prepare(input: PrepareReversalOperation): Promise<ReversalOperationRecord> {
    if (!OPERATION_ID.test(input.operationId)) throw new ReversalRegistryError("invalid", "The reversal operation ID is invalid.");
    await this.cleanup(REVERSAL_MAX_ACTIVE_BACKUPS - 1);
    const createdAtMs = this.#now();
    const oids = new Map<ReversalBackupRole, string>([
      ["pre-worktree", input.preWorktreeOid],
      ["pre-index", input.preIndexOid],
      ["post-worktree", input.postWorktreeOid],
      ["post-index", input.postIndexOid],
    ]);
    const backupReferences = [...expectedBackupRefs(input.operationId)].map(([role, ref]) => ({
      role,
      ref,
      oid: oids.get(role)!,
    }));
    const operation: ReversalOperationRecord = {
      formatVersion: OPERATION_FORMAT_VERSION,
      operationId: input.operationId,
      repository: { ...this.#repository },
      checkout: { ...this.#checkout },
      filePath: input.filePath,
      affectedLayers: [...input.affectedLayers],
      backupReferences,
      createdAt: new Date(createdAtMs).toISOString(),
      appliedAt: null,
      undoneAt: null,
      failedAt: null,
      expiredAt: null,
      status: "prepared",
      expiresAt: new Date(createdAtMs + REVERSAL_PREPARED_RETENTION_MS).toISOString(),
      selectedLineCount: input.selectedLineCount,
      preWorktreeOid: input.preWorktreeOid,
      preWorktreeMode: input.preWorktreeMode,
      preIndexOid: input.preIndexOid,
      preIndexMode: input.preIndexMode,
      postWorktreeOid: input.postWorktreeOid,
      postWorktreeMode: input.postWorktreeMode,
      postIndexOid: input.postIndexOid,
      postIndexMode: input.postIndexMode,
    };
    await this.#mutate((registry) => {
      if (registry.operations.some(({ operationId }) => operationId === operation.operationId)) {
        throw new ReversalRegistryError("conflict", "This selective-reversal operation ID already exists.");
      }
      return {
        ...registry,
        operations: [...pruneHistoricalOperations(registry.operations), operation],
      };
    });
    const created: ReversalBackupReference[] = [];
    try {
      for (const reference of backupReferences) {
        if (!(await this.#storage.createRef(reference.ref, reference.oid))) {
          throw new ReversalRegistryError("conflict", "A selective-reversal backup ref already exists.");
        }
        created.push(reference);
      }
      return cloneOperation(operation);
    } catch (error) {
      await Promise.all(created.map(({ ref, oid }) => this.#storage.deleteRef(ref, oid)));
      await this.markFailed(operation.operationId).catch(() => undefined);
      throw error;
    }
  }

  async get(operationId: string): Promise<ReversalOperationRecord> {
    if (!OPERATION_ID.test(operationId)) throw new ReversalRegistryError("invalid", "The reversal operation ID is invalid.");
    const current = await this.#read();
    if (current.kind === "incompatible") {
      throw new ReversalRegistryError("incompatible", "This selective-reversal registry is newer or unreadable.");
    }
    if (current.kind === "missing") throw new ReversalRegistryError("not-found", "This reversal backup is unavailable.");
    this.#assertRepository(current.registry);
    const operation = current.registry.operations.find((candidate) => candidate.operationId === operationId);
    if (!operation) throw new ReversalRegistryError("not-found", "This reversal backup is unavailable.");
    return cloneOperation(operation);
  }

  async operations(): Promise<ReversalOperationRecord[]> {
    const current = await this.#read();
    if (current.kind !== "known" || current.registry.repositoryIdentity !== this.#repository.fingerprint) return [];
    return current.registry.operations.map(cloneOperation);
  }

  assertCurrentIdentity(operation: ReversalOperationRecord): void {
    if (
      operation.repository.fingerprint !== this.#repository.fingerprint
      || operation.repository.commonDirectory !== this.#repository.commonDirectory
      || operation.checkout.fingerprint !== this.#checkout.fingerprint
      || operation.checkout.rootDirectory !== this.#checkout.rootDirectory
      || operation.checkout.gitDirectory !== this.#checkout.gitDirectory
    ) {
      throw new ReversalRegistryError("conflict", "This reversal backup belongs to a different repository or checkout identity.");
    }
  }

  async #setStatus(
    operationId: string,
    status: ReversalOperationStatus,
  ): Promise<ReversalOperationRecord> {
    const now = this.#now();
    const next = await this.#mutate((registry) => {
      let found = false;
      const operations = registry.operations.map((operation) => {
        if (operation.operationId !== operationId) return operation;
        found = true;
        const allowedFrom: Partial<Record<ReversalOperationStatus, ReversalOperationStatus[]>> = {
          applying: ["prepared"],
          applied: ["applying", "undoing"],
          undoing: ["applied"],
          failed: ["prepared", "applying"],
          "recovery-required": ["applying", "undoing"],
          undone: ["undoing"],
        };
        if (!(allowedFrom[status] ?? []).includes(operation.status)) {
          throw new ReversalRegistryError("conflict", `The reversal operation cannot change from ${operation.status} to ${status}.`);
        }
        return {
          ...operation,
          status,
          appliedAt: status === "applied" ? new Date(now).toISOString() : operation.appliedAt,
          undoneAt: status === "undone" ? new Date(now).toISOString() : operation.undoneAt,
          failedAt: status === "failed" || status === "recovery-required" ? new Date(now).toISOString() : operation.failedAt,
          expiredAt: status === "expired" ? new Date(now).toISOString() : operation.expiredAt,
          expiresAt: status === "applied"
            ? new Date(now + REVERSAL_BACKUP_RETENTION_MS).toISOString()
            : operation.expiresAt,
        } satisfies ReversalOperationRecord;
      });
      if (!found) throw new ReversalRegistryError("not-found", "This reversal backup is unavailable.");
      return { ...registry, operations };
    });
    const updated = next.operations.find((operation) => operation.operationId === operationId);
    if (!updated) throw new ReversalRegistryError("not-found", "This reversal backup is unavailable.");
    return cloneOperation(updated);
  }

  markApplied(operationId: string): Promise<ReversalOperationRecord> {
    return this.#setStatus(operationId, "applied");
  }

  markApplying(operationId: string): Promise<ReversalOperationRecord> {
    return this.#setStatus(operationId, "applying");
  }

  markFailed(operationId: string): Promise<ReversalOperationRecord> {
    return this.#setStatus(operationId, "failed");
  }

  markRecoveryRequired(operationId: string): Promise<ReversalOperationRecord> {
    return this.#setStatus(operationId, "recovery-required");
  }

  markUndone(operationId: string): Promise<ReversalOperationRecord> {
    return this.#setStatus(operationId, "undone");
  }

  markUndoing(operationId: string): Promise<ReversalOperationRecord> {
    return this.#setStatus(operationId, "undoing");
  }

  async deleteBackups(operation: ReversalOperationRecord): Promise<void> {
    await Promise.all(operation.backupReferences.map(({ ref, oid }) => this.#storage.deleteRef(ref, oid)));
  }

  async readBackup(operation: ReversalOperationRecord, role: ReversalBackupRole): Promise<Buffer> {
    const reference = operation.backupReferences.find((candidate) => candidate.role === role);
    if (!reference) throw new ReversalRegistryError("not-found", "This reversal backup is incomplete.");
    const stored = await this.#storage.readRef(reference.ref);
    if (!stored || stored.oid !== reference.oid) {
      throw new ReversalRegistryError("not-found", "This reversal backup is incomplete or no longer has its expected target.");
    }
    return stored.content;
  }
}
