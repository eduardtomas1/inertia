import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SafeStorage } from "electron";
import { backendSecretReferenceForProfile } from "../node/backend-secret-reference.js";

import {
  BACKEND_CREDENTIAL_MASK,
  type BackendCredentialStatus,
  type BackendCredentialState,
  type BackendCredentialStorageProvider,
  type BackendCredentialStorageState,
  isBackendCredentialProfileId,
  isBackendCredentialGeneration,
  isBackendCredentialSecret,
  isBackendSecretReference,
} from "../shared/backend-credentials.js";

const VAULT_SCHEMA_VERSION = 2;
export const MAX_CREDENTIAL_VAULT_BYTES = 1_048_576;
const MAX_VAULT_ENTRIES = 256;
const MAX_CIPHERTEXT_BASE64_LENGTH = 65_536;

export type CredentialVaultErrorCode =
  | "invalid-input"
  | "storage-unavailable"
  | "storage-corrupt"
  | "encryption-failed"
  | "decryption-failed"
  | "persistence-failed";

export class CredentialVaultError extends Error {
  readonly code: CredentialVaultErrorCode;

  constructor(code: CredentialVaultErrorCode, message: string) {
    super(message);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

export interface CredentialEncryptionBackend {
  availability(): Promise<BackendCredentialStorageState>;
  encrypt(plainText: string): Promise<Buffer>;
  decrypt(encrypted: Buffer): Promise<{
    plainText: string;
    shouldReEncrypt: boolean;
  }>;
}

export interface CredentialVaultPersistence {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface FileCredentialVaultPersistenceOptions {
  platform?: NodeJS.Platform;
  temporaryPrefix?: `.${string}-`;
}

interface PersistedCredentialEntry {
  ciphertext: string | null;
  credentialGeneration: string;
  updatedAt: string;
}

interface PersistedCredentialVault {
  schemaVersion: typeof VAULT_SCHEMA_VERSION;
  entries: Record<string, PersistedCredentialEntry>;
}

function publicStorageState(
  available: boolean,
  provider: BackendCredentialStorageProvider,
): BackendCredentialStorageState {
  return {
    available,
    provider,
    message: available
      ? null
      : "Secure credential storage is unavailable on this system.",
  };
}

function matchesOpenedFileIdentity(candidate: Stats, expected: Stats): boolean {
  return candidate.isFile()
    && candidate.dev === expected.dev
    && candidate.ino === expected.ino
    && candidate.size === expected.size
    && candidate.mtimeMs === expected.mtimeMs
    && candidate.ctimeMs === expected.ctimeMs;
}

async function readOpenedFile(file: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesRead === 0) {
      throw new CredentialVaultError(
        "storage-corrupt",
        "The secure credential vault is invalid.",
      );
    }
    offset += bytesRead;
  }
  return bytes;
}

export class ElectronSafeStorageBackend implements CredentialEncryptionBackend {
  constructor(
    private readonly storage: Pick<
      SafeStorage,
      | "decryptStringAsync"
      | "encryptStringAsync"
      | "getSelectedStorageBackend"
      | "isAsyncEncryptionAvailable"
    >,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async availability(): Promise<BackendCredentialStorageState> {
    try {
      if (this.platform === "linux") {
        const selected = this.storage.getSelectedStorageBackend();
        if (selected === "basic_text" || selected === "unknown") {
          return publicStorageState(false, "unavailable");
        }
      }
      if (!await this.storage.isAsyncEncryptionAvailable()) {
        return publicStorageState(false, "unavailable");
      }
      return publicStorageState(
        true,
        this.platform === "darwin"
          ? "keychain"
          : this.platform === "win32"
            ? "dpapi"
            : "secret-service",
      );
    } catch {
      return publicStorageState(false, "unavailable");
    }
  }

  async encrypt(plainText: string): Promise<Buffer> {
    return await this.storage.encryptStringAsync(plainText);
  }

  async decrypt(encrypted: Buffer): Promise<{
    plainText: string;
    shouldReEncrypt: boolean;
  }> {
    const decrypted = await this.storage.decryptStringAsync(encrypted);
    return {
      plainText: decrypted.result,
      shouldReEncrypt: decrypted.shouldReEncrypt,
    };
  }
}

export class FileCredentialVaultPersistence implements CredentialVaultPersistence {
  private readonly platform: NodeJS.Platform;
  private readonly temporaryPrefix: string;

  constructor(
    private readonly path: string,
    options: FileCredentialVaultPersistenceOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.temporaryPrefix = options.temporaryPrefix ?? ".credential-vault-";
    const name = basename(this.path);
    if (
      !/^\.[a-z0-9-]{1,48}-$/u.test(this.temporaryPrefix)
      || !name
      || name === "."
      || name === ".."
    ) {
      throw new CredentialVaultError(
        "persistence-failed",
        "The secure credential vault path is invalid.",
      );
    }
  }

  async read(): Promise<string | null> {
    const paths = await this.paths(false);
    if (!paths) return null;
    await this.recover(paths.directory, paths.target);
    let file: Awaited<ReturnType<typeof open>> | null = null;
    let observedTarget = false;
    try {
      const before = await lstat(paths.target);
      observedTarget = true;
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new CredentialVaultError(
          "storage-corrupt",
          "The secure credential vault is invalid.",
        );
      }
      file = await open(
        paths.target,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const metadata = await file.stat();
      if (
        !matchesOpenedFileIdentity(metadata, before)
        || metadata.size > MAX_CREDENTIAL_VAULT_BYTES
      ) {
        throw new CredentialVaultError(
          "storage-corrupt",
          "The secure credential vault is invalid.",
        );
      }
      const bytes = await readOpenedFile(file, metadata.size);
      const after = await file.stat();
      if (!matchesOpenedFileIdentity(after, metadata)) {
        throw new CredentialVaultError(
          "storage-corrupt",
          "The secure credential vault is invalid.",
        );
      }
      const verification = await readOpenedFile(file, metadata.size);
      const verified = await file.stat();
      if (
        !matchesOpenedFileIdentity(verified, metadata)
        || !verification.equals(bytes)
      ) {
        throw new CredentialVaultError(
          "storage-corrupt",
          "The secure credential vault is invalid.",
        );
      }
      return bytes.toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!observedTarget) return null;
        throw new CredentialVaultError(
          "storage-corrupt",
          "The secure credential vault changed while it was being read.",
        );
      }
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError(
        "persistence-failed",
        "The secure credential vault could not be read.",
      );
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async write(value: string): Promise<void> {
    if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_VAULT_BYTES) {
      throw new CredentialVaultError(
        "persistence-failed",
        "The secure credential vault is too large.",
      );
    }
    const paths = await this.paths(true);
    if (!paths) throw new Error("unreachable");
    await this.recover(paths.directory, paths.target);
    await this.assertSafeTarget(paths.target);
    const token = randomUUID();
    const temporaryPath = join(
      paths.directory,
      `${this.temporaryPrefix}${token}.stage`,
    );
    const backupPath = join(
      paths.directory,
      `${this.temporaryPrefix}${token}.backup`,
    );
    let temporary: Awaited<ReturnType<typeof open>> | null = null;
    try {
      temporary = await open(temporaryPath, "wx", 0o600);
      await temporary.writeFile(value, {
        encoding: "utf8",
      });
      await temporary.sync();
      await temporary.close();
      temporary = null;
      if (this.platform === "win32" && await exists(paths.target)) {
        await rename(paths.target, backupPath);
        try {
          await rename(temporaryPath, paths.target);
        } catch (error) {
          await rename(backupPath, paths.target).catch(() => undefined);
          throw error;
        }
        await unlink(backupPath).catch(() => undefined);
      } else {
        await rename(temporaryPath, paths.target);
      }
      await chmod(paths.target, 0o600).catch(() => undefined);
      await syncDirectory(paths.directory);
    } catch (error) {
      await temporary?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (!await exists(paths.target)) {
        await rename(backupPath, paths.target).catch(() => undefined);
      }
      await unlink(backupPath).catch(() => undefined);
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError(
        "persistence-failed",
        "The secure credential vault could not be saved.",
      );
    }
  }

  async remove(): Promise<void> {
    const paths = await this.paths(false);
    if (!paths) return;
    await this.recover(paths.directory, paths.target);
    const metadata = await lstat(paths.target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return;
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CredentialVaultError(
        "persistence-failed",
        "The secure credential vault could not be removed.",
      );
    }
    try {
      await unlink(paths.target);
      await syncDirectory(paths.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CredentialVaultError(
        "persistence-failed",
        "The secure credential vault could not be removed.",
      );
    }
  }

  private async paths(
    create: boolean,
  ): Promise<{ directory: string; target: string } | null> {
    const requestedDirectory = dirname(this.path);
    if (create) {
      await mkdir(requestedDirectory, {
        recursive: true,
        mode: 0o700,
      });
    }
    let directory: string;
    try {
      directory = await realpath(requestedDirectory);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return {
      directory,
      target: join(directory, basename(this.path)),
    };
  }

  private async assertSafeTarget(target: string): Promise<void> {
    const metadata = await lstat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
      throw new CredentialVaultError(
        "persistence-failed",
        "The secure credential vault could not be saved.",
      );
    }
  }

  private async recover(directory: string, target: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    const escapedPrefix = this.temporaryPrefix.replace(
      /[.*+?^${}()|[\]\\]/gu,
      "\\$&",
    );
    const pattern = new RegExp(
      `^${escapedPrefix}([0-9a-f-]{36})\\.(stage|backup)$`,
      "u",
    );
    const transactions = new Map<string, {
      stage?: string;
      backup?: string;
    }>();
    for (const name of names.slice(0, 1_024)) {
      if (
        name.startsWith(this.temporaryPrefix)
        && name.endsWith(".tmp")
      ) {
        await unlink(join(directory, name)).catch(() => undefined);
        continue;
      }
      const match = pattern.exec(name);
      if (!match) continue;
      const token = match[1]!;
      const transaction = transactions.get(token) ?? {};
      transaction[match[2] as "stage" | "backup"] = join(directory, name);
      transactions.set(token, transaction);
      if (transactions.size >= 256) break;
    }
    for (const transaction of transactions.values()) {
      await this.recoverTransaction(target, transaction);
    }
  }

  private async recoverTransaction(
    target: string,
    transaction: { stage?: string; backup?: string },
  ): Promise<void> {
    const targetExists = await exists(target);
    if (targetExists) {
      await unlinkSafeTemporary(transaction.stage);
      await unlinkSafeTemporary(transaction.backup);
      return;
    }
    if (transaction.stage && await regularFile(transaction.stage)) {
      await rename(transaction.stage, target);
      await unlinkSafeTemporary(transaction.backup);
      return;
    }
    if (transaction.backup && await regularFile(transaction.backup)) {
      await rename(transaction.backup, target);
      await unlinkSafeTemporary(transaction.stage);
      return;
    }
    await unlinkSafeTemporary(transaction.stage);
    await unlinkSafeTemporary(transaction.backup);
  }
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
}

async function regularFile(path: string): Promise<boolean> {
  return await lstat(path).then(
    (metadata) => metadata.isFile() && !metadata.isSymbolicLink(),
    () => false,
  );
}

async function unlinkSafeTemporary(path: string | undefined): Promise<void> {
  if (!path) return;
  await unlink(path).catch(() => undefined);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r").catch(() => null);
  try {
    await handle?.sync().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export { backendSecretReferenceForProfile };

function emptyVault(): PersistedCredentialVault {
  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    entries: {},
  };
}

function validCiphertext(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_CIPHERTEXT_BASE64_LENGTH
    && /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

function parseVault(value: string | null): PersistedCredentialVault {
  if (value === null) return emptyVault();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CredentialVaultError(
      "storage-corrupt",
      "The secure credential vault is invalid.",
    );
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) {
    throw new CredentialVaultError(
      "storage-corrupt",
      "The secure credential vault is invalid.",
    );
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2
    || (candidate.schemaVersion !== 1 && candidate.schemaVersion !== VAULT_SCHEMA_VERSION)
    || typeof candidate.entries !== "object"
    || candidate.entries === null
    || Array.isArray(candidate.entries)
  ) {
    throw new CredentialVaultError(
      "storage-corrupt",
      "The secure credential vault is invalid.",
    );
  }
  const rawEntries = candidate.entries as Record<string, unknown>;
  const pairs = Object.entries(rawEntries);
  if (pairs.length > MAX_VAULT_ENTRIES) {
    throw new CredentialVaultError(
      "storage-corrupt",
      "The secure credential vault is invalid.",
    );
  }
  const entries: Record<string, PersistedCredentialEntry> = {};
  for (const [reference, raw] of pairs) {
    if (
      !isBackendSecretReference(reference)
      || typeof raw !== "object"
      || raw === null
      || Array.isArray(raw)
    ) {
      throw new CredentialVaultError(
        "storage-corrupt",
        "The secure credential vault is invalid.",
      );
    }
    const entry = raw as Record<string, unknown>;
    const updatedAt = entry.updatedAt;
    if (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) {
      throw new CredentialVaultError(
        "storage-corrupt",
        "The secure credential vault is invalid.",
      );
    }
    if (candidate.schemaVersion === 1) {
      if (Object.keys(entry).length !== 2 || !validCiphertext(entry.ciphertext)) {
        throw new CredentialVaultError(
          "storage-corrupt",
          "The secure credential vault is invalid.",
        );
      }
      entries[reference] = {
        ciphertext: entry.ciphertext,
        credentialGeneration: `legacy:${createHash("sha256")
          .update(`${reference}\0${entry.ciphertext}\0${updatedAt}`)
          .digest("hex")}`,
        updatedAt,
      };
      continue;
    }
    if (
      Object.keys(entry).length !== 3
      || (entry.ciphertext !== null && !validCiphertext(entry.ciphertext))
      || !isBackendCredentialGeneration(entry.credentialGeneration)
    ) {
      throw new CredentialVaultError(
        "storage-corrupt",
        "The secure credential vault is invalid.",
      );
    }
    entries[reference] = {
      ciphertext: entry.ciphertext,
      credentialGeneration: entry.credentialGeneration,
      updatedAt,
    };
  }
  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    entries,
  };
}

export class CredentialVault {
  private loaded: PersistedCredentialVault | null = null;
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly encryption: CredentialEncryptionBackend,
    private readonly persistence: CredentialVaultPersistence,
  ) {}

  async storageState(): Promise<BackendCredentialStorageState> {
    return await this.encryption.availability();
  }

  async stateForProfile(profileId: string): Promise<BackendCredentialState> {
    const secretReference = backendSecretReferenceForProfile(profileId);
    return await this.state(profileId, secretReference);
  }

  async state(
    profileId: string,
    secretReference: string,
  ): Promise<BackendCredentialState> {
    if (
      !isBackendCredentialProfileId(profileId)
      || !isBackendSecretReference(secretReference)
    ) {
      throw new CredentialVaultError(
        "invalid-input",
        "The backend credential request is invalid.",
      );
    }
    const [vault, storage] = await Promise.all([
      this.load(),
      this.storageState(),
    ]);
    const entry = vault.entries[secretReference];
    const hasSecret = entry?.ciphertext !== null && entry !== undefined;
    return {
      profileId,
      hasSecret,
      maskedValue: hasSecret ? BACKEND_CREDENTIAL_MASK : null,
      credentialGeneration: entry?.credentialGeneration ?? null,
      storage,
    };
  }

  async setForProfile(profileId: string, secret: string): Promise<BackendCredentialState> {
    const secretReference = backendSecretReferenceForProfile(profileId);
    if (!isBackendCredentialSecret(secret)) {
      throw new CredentialVaultError(
        "invalid-input",
        secret === BACKEND_CREDENTIAL_MASK
          ? "The masked credential placeholder cannot replace a saved credential."
          : "The backend credential is invalid.",
      );
    }
    await this.enqueueMutation(async () => {
      const storage = await this.storageState();
      if (!storage.available) {
        throw new CredentialVaultError(
          "storage-unavailable",
          "Secure credential storage is unavailable on this system.",
        );
      }
      let encrypted: Buffer;
      try {
        encrypted = await this.encryption.encrypt(secret);
      } catch {
        throw new CredentialVaultError(
          "encryption-failed",
          "The backend credential could not be protected.",
        );
      }
      if (
        encrypted.length === 0
        || encrypted.toString("base64").length > MAX_CIPHERTEXT_BASE64_LENGTH
      ) {
        throw new CredentialVaultError(
          "encryption-failed",
          "The backend credential could not be protected.",
        );
      }
      const current = await this.load();
      if (
        !Object.prototype.hasOwnProperty.call(current.entries, secretReference)
        && Object.keys(current.entries).length >= MAX_VAULT_ENTRIES
      ) {
        throw new CredentialVaultError(
          "persistence-failed",
          "The secure credential vault is full.",
        );
      }
      const vault: PersistedCredentialVault = {
        ...current,
        entries: { ...current.entries },
      };
      vault.entries[secretReference] = {
        ciphertext: encrypted.toString("base64"),
        credentialGeneration: randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      await this.persist(vault);
    });
    return await this.state(profileId, secretReference);
  }

  async resolve(secretReference: string): Promise<string | null> {
    if (!isBackendSecretReference(secretReference)) {
      throw new CredentialVaultError(
        "invalid-input",
        "The backend credential reference is invalid.",
      );
    }
    const storage = await this.storageState();
    if (!storage.available) {
      throw new CredentialVaultError(
        "storage-unavailable",
        "Secure credential storage is unavailable on this system.",
      );
    }
    const vault = await this.load();
    const entry = vault.entries[secretReference];
    if (!entry?.ciphertext) return null;
    let decrypted: { plainText: string; shouldReEncrypt: boolean };
    try {
      decrypted = await this.encryption.decrypt(
        Buffer.from(entry.ciphertext, "base64"),
      );
    } catch {
      throw new CredentialVaultError(
        "decryption-failed",
        "The backend credential could not be unlocked.",
      );
    }
    if (!isBackendCredentialSecret(decrypted.plainText)) {
      throw new CredentialVaultError(
        "decryption-failed",
        "The backend credential could not be unlocked.",
      );
    }
    if (decrypted.shouldReEncrypt) {
      await this.setByReference(
        secretReference,
        decrypted.plainText,
        entry.ciphertext,
      );
    }
    return decrypted.plainText;
  }

  async clearForProfile(profileId: string): Promise<BackendCredentialState> {
    const secretReference = backendSecretReferenceForProfile(profileId);
    await this.clear(secretReference);
    return await this.state(profileId, secretReference);
  }

  /**
   * Removes a tombstone after the owning backend profile has been durably
   * deleted. Callers must not use this as ordinary credential clearing.
   */
  async forgetForProfile(profileId: string): Promise<boolean> {
    return await this.forget(backendSecretReferenceForProfile(profileId));
  }

  async clear(secretReference: string): Promise<boolean> {
    if (!isBackendSecretReference(secretReference)) {
      throw new CredentialVaultError(
        "invalid-input",
        "The backend credential reference is invalid.",
      );
    }
    let removed = false;
    await this.enqueueMutation(async () => {
      const current = await this.load();
      const existing = current.entries[secretReference];
      if (
        existing === undefined
        && Object.keys(current.entries).length >= MAX_VAULT_ENTRIES
      ) {
        throw new CredentialVaultError(
          "persistence-failed",
          "The secure credential vault is full.",
        );
      }
      const vault: PersistedCredentialVault = {
        ...current,
        entries: { ...current.entries },
      };
      vault.entries[secretReference] = {
        ciphertext: null,
        credentialGeneration: randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      await this.persist(vault);
      removed = existing?.ciphertext !== null && existing !== undefined;
    });
    return removed;
  }

  async has(secretReference: string): Promise<boolean> {
    if (!isBackendSecretReference(secretReference)) return false;
    const vault = await this.load();
    return vault.entries[secretReference]?.ciphertext !== null
      && vault.entries[secretReference] !== undefined;
  }

  async status(secretReference: string): Promise<BackendCredentialStatus> {
    if (!isBackendSecretReference(secretReference)) {
      throw new CredentialVaultError(
        "invalid-input",
        "The backend credential reference is invalid.",
      );
    }
    const entry = (await this.load()).entries[secretReference];
    return {
      hasSecret: entry?.ciphertext !== null && entry !== undefined,
      credentialGeneration: entry?.credentialGeneration ?? null,
    };
  }

  async forget(secretReference: string): Promise<boolean> {
    if (!isBackendSecretReference(secretReference)) {
      throw new CredentialVaultError(
        "invalid-input",
        "The backend credential reference is invalid.",
      );
    }
    let removed = false;
    await this.enqueueMutation(async () => {
      const current = await this.load();
      if (!current.entries[secretReference]) return;
      const vault: PersistedCredentialVault = {
        ...current,
        entries: { ...current.entries },
      };
      delete vault.entries[secretReference];
      await this.persist(vault);
      removed = true;
    });
    return removed;
  }

  private async setByReference(
    secretReference: string,
    secret: string,
    expectedCiphertext: string,
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      let encrypted: Buffer;
      try {
        encrypted = await this.encryption.encrypt(secret);
      } catch {
        throw new CredentialVaultError(
          "encryption-failed",
          "The backend credential could not be protected.",
        );
      }
      const current = await this.load();
      if (current.entries[secretReference]?.ciphertext !== expectedCiphertext) return;
      const vault: PersistedCredentialVault = {
        ...current,
        entries: { ...current.entries },
      };
      vault.entries[secretReference] = {
        ciphertext: encrypted.toString("base64"),
        credentialGeneration: current.entries[secretReference]!.credentialGeneration,
        updatedAt: new Date().toISOString(),
      };
      await this.persist(vault);
    });
  }

  private async load(): Promise<PersistedCredentialVault> {
    if (this.loaded) return this.loaded;
    this.loaded = parseVault(await this.persistence.read());
    return this.loaded;
  }

  private async persist(vault: PersistedCredentialVault): Promise<void> {
    try {
      await this.persistence.write(JSON.stringify(vault));
      this.loaded = vault;
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError(
        "persistence-failed",
        "The secure credential vault could not be saved.",
      );
    }
  }

  private async enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const queued = this.mutation.then(operation, operation);
    this.mutation = queued.catch(() => undefined);
    await queued;
  }
}
