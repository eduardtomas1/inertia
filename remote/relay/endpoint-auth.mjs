import {
  constants,
  createHash,
  createPublicKey,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const ENDPOINT_AUTH_VERSION = 2;
export const ENDPOINT_CHALLENGE_TTL_MS = 5_000;
export const ENDPOINT_CHALLENGE_NONCE_BYTES = 32;

const ENDPOINT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256_NAME = /^[0-9a-f]{64}\.json$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const METADATA_FILE = "relay-metadata.json";
const ENDPOINT_DIRECTORY = "endpoints";
const METADATA_VERSION = 1;
const RECORD_VERSION = 1;
const MAX_METADATA_BYTES = 1_000_000;
const MAX_RECORD_BYTES = 4_096;
const MAX_PUBLIC_KEY_BYTES = 256;
const MAX_SIGNATURE_BYTES = 128;
const MAX_SOURCE_LENGTH = 200;
const MAX_RATE_KEYS = 4_096;
const MINUTE_MS = 60_000;
const IP_BLOCK_MS = 60_000;
const PROOF_CONTEXT = "inertia-relay/2/endpoint-proof";
const textEncoder = new TextEncoder();

export class EndpointBindingConflictError extends Error {
  constructor(message = "The relay endpoint is already bound.") {
    super(message);
    this.name = "EndpointBindingConflictError";
  }
}

export class EndpointEpochConflictError extends Error {
  constructor(message = "The relay endpoint epoch changed.") {
    super(message);
    this.name = "EndpointEpochConflictError";
  }
}

export class EndpointBindingStoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "EndpointBindingStoreError";
  }
}

export function endpointProofTranscript(value) {
  const challenge = validateChallenge(value);
  const fields = [
    PROOF_CONTEXT,
    challenge.purpose,
    challenge.relayIdentity,
    challenge.endpointId,
    challenge.endpointPublicKey,
    challenge.nonce,
  ].map(lengthPrefixedString);
  return Buffer.concat([
    ...fields,
    unsigned64(challenge.epoch),
    unsigned64(challenge.expiresAt),
  ]);
}

export function verifyEndpointProof(value, signature) {
  try {
    if (!boundedBase64Url(signature, MAX_SIGNATURE_BYTES)) return false;
    const signatureBytes = Buffer.from(signature, "base64url");
    if (signatureBytes.byteLength !== 64) return false;
    const publicKey = endpointPublicKey(value.endpointPublicKey);
    return verify(
      "sha256",
      endpointProofTranscript(value),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signatureBytes,
    );
  } catch {
    return false;
  }
}

export class EndpointBindingStore {
  static async open(options) {
    const stateDirectory = resolveRequiredDirectory(options?.stateDirectory);
    const initialize = options?.initialize === true;
    const maxEndpoints = boundedInteger(
      options?.maxEndpoints,
      1,
      100_000,
      10_000,
    );
    const now = options?.now ?? Date.now;
    if (initialize) {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    }
    await requirePrivateDirectory(stateDirectory);
    const endpointDirectory = join(stateDirectory, ENDPOINT_DIRECTORY);
    if (initialize) {
      await mkdir(endpointDirectory, { mode: 0o700 }).catch((error) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
    }
    await requirePrivateDirectory(endpointDirectory);

    let metadata = await loadMetadata(stateDirectory, maxEndpoints);
    if (metadata === null) {
      if (!initialize) {
        throw new EndpointBindingStoreError(
          "The relay endpoint binding metadata is missing.",
        );
      }
      metadata = {
        version: METADATA_VERSION,
        relayIdentity: randomUUID(),
        createdAt: isoTimestamp(now()),
        endpointDigests: [],
      };
      await exclusiveWriteJson(
        join(stateDirectory, METADATA_FILE),
        metadata,
        MAX_METADATA_BYTES,
      );
      await syncDirectory(stateDirectory);
    }

    const store = new EndpointBindingStore({
      stateDirectory,
      endpointDirectory,
      metadata,
      maxEndpoints,
      now,
    });
    await store.reconcile();
    return store;
  }

  constructor(options) {
    this.stateDirectory = options.stateDirectory;
    this.endpointDirectory = options.endpointDirectory;
    this.metadata = options.metadata;
    this.maxEndpoints = options.maxEndpoints;
    this.now = options.now;
    this.mutationTail = Promise.resolve();
  }

  get relayIdentity() {
    return this.metadata.relayIdentity;
  }

  get size() {
    return this.metadata.endpointDigests.length;
  }

  async get(endpointId) {
    requireEndpointId(endpointId);
    const digest = endpointDigest(endpointId);
    const path = this.recordPath(digest);
    const record = await loadRecord(path);
    if (record === null) {
      if (this.metadata.endpointDigests.includes(digest)) {
        throw new EndpointBindingStoreError(
          "A known relay endpoint binding record is missing.",
        );
      }
      return null;
    }
    if (record.endpointId !== endpointId || endpointDigest(record.endpointId) !== digest) {
      throw new EndpointBindingStoreError(
        "The relay endpoint binding record does not match its storage key.",
      );
    }
    return record;
  }

  async claim({ endpointId, endpointPublicKey, connectedAt }) {
    requireEndpointId(endpointId);
    endpointPublicKeyObject(endpointPublicKey);
    const timestamp = connectedAt ?? isoTimestamp(this.now());
    requireTimestamp(timestamp);
    return await this.mutate(async () => {
      if (this.metadata.endpointDigests.length >= this.maxEndpoints) {
        throw new EndpointBindingStoreError(
          "The relay endpoint binding capacity is exhausted.",
        );
      }
      const digest = endpointDigest(endpointId);
      const existing = await loadRecord(this.recordPath(digest));
      if (existing !== null || this.metadata.endpointDigests.includes(digest)) {
        throw new EndpointBindingConflictError();
      }
      const record = {
        version: RECORD_VERSION,
        endpointId,
        endpointPublicKey,
        epoch: 1,
        claimedAt: timestamp,
        lastConnectedAt: timestamp,
      };
      await exclusiveWriteJson(this.recordPath(digest), record, MAX_RECORD_BYTES);
      await syncDirectory(this.endpointDirectory);
      const endpointDigests = [...this.metadata.endpointDigests, digest].sort();
      await this.saveMetadata({ ...this.metadata, endpointDigests });
      return record;
    });
  }

  async advance({
    endpointId,
    endpointPublicKey,
    expectedEpoch,
    nextEpoch,
    connectedAt,
  }) {
    requireEndpointId(endpointId);
    endpointPublicKeyObject(endpointPublicKey);
    requirePositiveInteger(expectedEpoch, "expected endpoint epoch");
    requirePositiveInteger(nextEpoch, "next endpoint epoch");
    if (nextEpoch !== expectedEpoch + 1) {
      throw new EndpointEpochConflictError();
    }
    const timestamp = connectedAt ?? isoTimestamp(this.now());
    requireTimestamp(timestamp);
    return await this.mutate(async () => {
      const current = await this.get(endpointId);
      if (
        current === null
        || current.epoch !== expectedEpoch
        || !safeEqual(current.endpointPublicKey, endpointPublicKey)
      ) {
        throw new EndpointEpochConflictError();
      }
      const record = {
        ...current,
        epoch: nextEpoch,
        lastConnectedAt: timestamp,
      };
      await atomicWriteJson(
        this.recordPath(endpointDigest(endpointId)),
        record,
        MAX_RECORD_BYTES,
      );
      await syncDirectory(this.endpointDirectory);
      return record;
    });
  }

  async reconcile() {
    const entries = await readdir(this.endpointDirectory, { withFileTypes: true });
    const discovered = [];
    for (const entry of entries) {
      if (!entry.isFile() || !SHA256_NAME.test(entry.name)) {
        throw new EndpointBindingStoreError(
          "The relay endpoint binding directory contains an unexpected entry.",
        );
      }
      const digest = entry.name.slice(0, -5);
      const record = await loadRecord(join(this.endpointDirectory, entry.name));
      if (record === null || endpointDigest(record.endpointId) !== digest) {
        throw new EndpointBindingStoreError(
          "A relay endpoint binding record is invalid.",
        );
      }
      discovered.push(digest);
    }
    discovered.sort();
    if (discovered.length > this.maxEndpoints) {
      throw new EndpointBindingStoreError(
        "The relay endpoint binding capacity is exceeded.",
      );
    }
    for (const digest of this.metadata.endpointDigests) {
      if (!discovered.includes(digest)) {
        throw new EndpointBindingStoreError(
          "A known relay endpoint binding record is missing.",
        );
      }
    }
    if (!sameStrings(discovered, this.metadata.endpointDigests)) {
      await this.saveMetadata({ ...this.metadata, endpointDigests: discovered });
    }
  }

  async saveMetadata(metadata) {
    validateMetadata(metadata, this.maxEndpoints);
    await atomicWriteJson(
      join(this.stateDirectory, METADATA_FILE),
      metadata,
      MAX_METADATA_BYTES,
    );
    await syncDirectory(this.stateDirectory);
    this.metadata = metadata;
  }

  recordPath(digest) {
    return join(this.endpointDirectory, `${digest}.json`);
  }

  async mutate(work) {
    const operation = this.mutationTail.then(work);
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }
}

export class EndpointAuthenticator {
  constructor(options) {
    if (!(options?.store instanceof EndpointBindingStore)) {
      throw new TypeError("EndpointAuthenticator requires an endpoint binding store.");
    }
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.verifyProof = options.verifyProof ?? verifyEndpointProof;
    this.challengeTtlMs = boundedInteger(
      options.challengeTtlMs,
      1,
      ENDPOINT_CHALLENGE_TTL_MS,
      ENDPOINT_CHALLENGE_TTL_MS,
    );
    this.maxChallenges = boundedInteger(options.maxChallenges, 1, 16_384, 1_024);
    this.challenges = new Map();
    this.ipFailures = new FailureBudget({
      maximum: boundedInteger(options.maxIpFailures, 1, 100, 5),
      blockMs: IP_BLOCK_MS,
      maxKeys: boundedInteger(options.maxRateKeys, 1, 100_000, MAX_RATE_KEYS),
    });
    this.endpointFailures = new FailureBudget({
      maximum: boundedInteger(options.maxEndpointFailures, 1, 100, 10),
      blockMs: 0,
      maxKeys: boundedInteger(options.maxRateKeys, 1, 100_000, MAX_RATE_KEYS),
    });
  }

  async beginClaim(input) {
    return await this.begin({ ...input, purpose: "claim" });
  }

  async beginRegistration(input) {
    return await this.begin({ ...input, purpose: "register" });
  }

  forgetSocket(socketId) {
    this.challenges.delete(socketId);
  }

  async prove(socketId, source, proof) {
    const challenge = this.challenges.get(socketId);
    this.challenges.delete(socketId);
    const now = this.now();
    if (!challenge) return failure("invalid-message");
    if (challenge.source !== source) {
      this.recordFailure(source, challenge.endpointId, now);
      return failure("invalid-message");
    }
    if (now > challenge.expiresAt) {
      this.recordFailure(source, challenge.endpointId, now);
      return failure("challenge-expired");
    }
    if (!this.allowed(source, challenge.endpointId, now)) {
      return failure("rate-limited");
    }
    if (!proofMatchesChallenge(proof, challenge)) {
      this.recordFailure(source, challenge.endpointId, now);
      return failure("invalid-message");
    }
    if (!this.verifyProof(challenge, proof.signature)) {
      this.recordFailure(source, challenge.endpointId, now);
      return failure("proof-invalid");
    }
    try {
      const connectedAt = isoTimestamp(now);
      const binding = challenge.purpose === "claim"
        ? await this.store.claim({
            endpointId: challenge.endpointId,
            endpointPublicKey: challenge.endpointPublicKey,
            connectedAt,
          })
        : await this.store.advance({
            endpointId: challenge.endpointId,
            endpointPublicKey: challenge.endpointPublicKey,
            expectedEpoch: challenge.epoch - 1,
            nextEpoch: challenge.epoch,
            connectedAt,
          });
      return {
        ok: true,
        ownership: challenge.purpose === "claim" ? "claimed" : "verified",
        binding,
      };
    } catch (error) {
      if (
        error instanceof EndpointBindingConflictError
        || error instanceof EndpointEpochConflictError
      ) return failure("endpoint-owned");
      return failure("storage-unavailable");
    }
  }

  async begin(input) {
    const now = this.now();
    this.sweepChallenges(now);
    if (!validSocketId(input.socketId) || !validSource(input.source)) {
      return failure("invalid-message");
    }
    if (this.challenges.has(input.socketId)) {
      this.challenges.delete(input.socketId);
      return failure("invalid-message");
    }
    if (this.challenges.size >= this.maxChallenges) return failure("capacity");
    if (!ENDPOINT_ID.test(input.endpointId ?? "")) {
      return failure("invalid-message");
    }
    if (!this.allowed(input.source, input.endpointId, now)) {
      return failure("rate-limited");
    }

    let endpointPublicKey;
    let epoch;
    try {
      const existing = await this.store.get(input.endpointId);
      if (input.purpose === "claim") {
        if (existing !== null) return failure("endpoint-owned");
        endpointPublicKeyObject(input.endpointPublicKey);
        endpointPublicKey = input.endpointPublicKey;
        epoch = 1;
      } else {
        if (existing === null) return failure("endpoint-missing");
        endpointPublicKey = existing.endpointPublicKey;
        epoch = existing.epoch + 1;
      }
    } catch (error) {
      if (error instanceof TypeError) return failure("invalid-message");
      return failure("storage-unavailable");
    }

    const nonceBytes = this.randomBytes(ENDPOINT_CHALLENGE_NONCE_BYTES);
    if (!(nonceBytes instanceof Uint8Array) || nonceBytes.byteLength !== 32) {
      return failure("storage-unavailable");
    }
    const challenge = {
      purpose: input.purpose,
      relayIdentity: this.store.relayIdentity,
      endpointId: input.endpointId,
      endpointPublicKey,
      nonce: Buffer.from(nonceBytes).toString("base64url"),
      epoch,
      expiresAt: now + this.challengeTtlMs,
      source: input.source,
    };
    this.challenges.set(input.socketId, challenge);
    return {
      ok: true,
      challenge: publicChallenge(challenge),
    };
  }

  allowed(source, endpointId, now) {
    return this.ipFailures.allowed(source, now)
      && this.endpointFailures.allowed(endpointId, now);
  }

  recordFailure(source, endpointId, now) {
    this.ipFailures.fail(source, now);
    this.endpointFailures.fail(endpointId, now);
  }

  sweepChallenges(now) {
    for (const [socketId, challenge] of this.challenges) {
      if (challenge.expiresAt < now) this.challenges.delete(socketId);
    }
  }
}

class FailureBudget {
  constructor({ maximum, blockMs, maxKeys }) {
    this.maximum = maximum;
    this.blockMs = blockMs;
    this.maxKeys = maxKeys;
    this.entries = new Map();
    this.lastSweep = 0;
  }

  allowed(key, now) {
    if (
      this.entries.size >= this.maxKeys
      || now - this.lastSweep >= MINUTE_MS
    ) this.sweep(now);
    const entry = this.entries.get(key);
    if (!entry) return this.entries.size < this.maxKeys;
    pruneFailures(entry.failures, now);
    if (entry.blockedUntil > now) return false;
    if (entry.failures.length === 0) {
      this.entries.delete(key);
      return true;
    }
    return entry.failures.length < this.maximum;
  }

  fail(key, now) {
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) return;
      entry = { failures: [], blockedUntil: 0 };
      this.entries.set(key, entry);
    }
    pruneFailures(entry.failures, now);
    entry.failures.push(now);
    if (entry.failures.length >= this.maximum && this.blockMs > 0) {
      entry.blockedUntil = Math.max(entry.blockedUntil, now + this.blockMs);
    }
  }

  sweep(now) {
    for (const [key, entry] of this.entries) {
      pruneFailures(entry.failures, now);
      if (entry.failures.length === 0 && entry.blockedUntil <= now) {
        this.entries.delete(key);
      }
    }
    this.lastSweep = now;
  }
}

function publicChallenge(challenge) {
  const { source: _source, ...value } = challenge;
  return value;
}

function failure(code) {
  return { ok: false, code };
}

function proofMatchesChallenge(proof, challenge) {
  if (
    !plainObject(proof)
    || !exactKeys(proof, 9)
    || proof.type !== "relay.register.proof"
    || !boundedBase64Url(proof.signature, MAX_SIGNATURE_BYTES)
  ) return false;
  return safeEqual(proof.purpose, challenge.purpose)
    && safeEqual(proof.relayIdentity, challenge.relayIdentity)
    && safeEqual(proof.endpointId, challenge.endpointId)
    && safeEqual(proof.endpointPublicKey, challenge.endpointPublicKey)
    && safeEqual(proof.nonce, challenge.nonce)
    && proof.epoch === challenge.epoch
    && proof.expiresAt === challenge.expiresAt;
}

function validateChallenge(value) {
  if (
    !plainObject(value)
    || (value.purpose !== "claim" && value.purpose !== "register")
    || !UUID.test(value.relayIdentity ?? "")
    || !ENDPOINT_ID.test(value.endpointId ?? "")
    || !boundedBase64Url(value.endpointPublicKey, MAX_PUBLIC_KEY_BYTES)
    || !boundedBase64Url(value.nonce, 64)
    || Buffer.from(value.nonce, "base64url").byteLength !== ENDPOINT_CHALLENGE_NONCE_BYTES
  ) throw new TypeError("Invalid endpoint registration challenge.");
  requirePositiveInteger(value.epoch, "endpoint epoch");
  requirePositiveInteger(value.expiresAt, "challenge expiry");
  return value;
}

function endpointPublicKey(value) {
  const publicKey = endpointPublicKeyObject(value);
  if (
    publicKey.asymmetricKeyType !== "ec"
    || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) throw new TypeError("Endpoint keys must use ECDSA P-256.");
  return publicKey;
}

function endpointPublicKeyObject(value) {
  if (!boundedBase64Url(value, MAX_PUBLIC_KEY_BYTES)) {
    throw new TypeError("Invalid endpoint public key.");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength > MAX_PUBLIC_KEY_BYTES) {
    throw new TypeError("Invalid endpoint public key.");
  }
  try {
    const publicKey = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (
      publicKey.asymmetricKeyType !== "ec"
      || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) throw new TypeError("Endpoint keys must use ECDSA P-256.");
    return publicKey;
  } catch (error) {
    throw new TypeError("Invalid endpoint public key.", { cause: error });
  }
}

async function loadMetadata(stateDirectory, maxEndpoints) {
  const path = join(stateDirectory, METADATA_FILE);
  const value = await readJson(path, MAX_METADATA_BYTES);
  if (value === null) return null;
  validateMetadata(value, maxEndpoints);
  return value;
}

function validateMetadata(value, maxEndpoints) {
  if (
    !plainObject(value)
    || !exactKeys(value, 4)
    || value.version !== METADATA_VERSION
    || !UUID.test(value.relayIdentity ?? "")
    || !validTimestamp(value.createdAt)
    || !Array.isArray(value.endpointDigests)
    || value.endpointDigests.length > maxEndpoints
    || value.endpointDigests.some((digest) => !/^[0-9a-f]{64}$/u.test(digest))
    || !sameStrings(value.endpointDigests, [...new Set(value.endpointDigests)].sort())
  ) throw new EndpointBindingStoreError("The relay endpoint binding metadata is invalid.");
}

async function loadRecord(path) {
  const value = await readJson(path, MAX_RECORD_BYTES);
  if (value === null) return null;
  if (
    !plainObject(value)
    || !exactKeys(value, 6)
    || value.version !== RECORD_VERSION
    || !ENDPOINT_ID.test(value.endpointId ?? "")
    || !boundedBase64Url(value.endpointPublicKey, MAX_PUBLIC_KEY_BYTES)
    || !Number.isSafeInteger(value.epoch)
    || value.epoch < 1
    || !validTimestamp(value.claimedAt)
    || !validTimestamp(value.lastConnectedAt)
  ) throw new EndpointBindingStoreError("The relay endpoint binding record is invalid.");
  try {
    endpointPublicKeyObject(value.endpointPublicKey);
  } catch (error) {
    throw new EndpointBindingStoreError(
      "The relay endpoint binding public key is invalid.",
      { cause: error },
    );
  }
  return value;
}

async function readJson(path, maximumBytes) {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new EndpointBindingStoreError("The relay state could not be inspected.", {
      cause: error,
    });
  }
  if (!status.isFile() || status.isSymbolicLink() || status.size > maximumBytes) {
    throw new EndpointBindingStoreError("The relay state file is unsafe or oversized.");
  }
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(path, flags);
    try {
      const contents = await handle.readFile({ encoding: "utf8" });
      return JSON.parse(contents);
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new EndpointBindingStoreError("The relay state file could not be read.", {
      cause: error,
    });
  }
}

async function exclusiveWriteJson(path, value, maximumBytes) {
  const serialized = serializeJson(value, maximumBytes);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new EndpointBindingConflictError();
    throw new EndpointBindingStoreError("The relay state file could not be created.", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

async function atomicWriteJson(path, value, maximumBytes) {
  const serialized = serializeJson(value, maximumBytes);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new EndpointBindingStoreError("The relay state file could not be replaced.", {
      cause: error,
    });
  }
}

function serializeJson(value, maximumBytes) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > maximumBytes) {
    throw new EndpointBindingStoreError("The relay state file exceeds its size limit.");
  }
  return serialized;
}

async function requirePrivateDirectory(path) {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    throw new EndpointBindingStoreError("The relay state directory is unavailable.", {
      cause: error,
    });
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new EndpointBindingStoreError("The relay state directory is unsafe.");
  }
  if (process.platform !== "win32" && (status.mode & 0o077) !== 0) {
    throw new EndpointBindingStoreError(
      "The relay state directory permissions must exclude group and other users.",
    );
  }
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    throw new EndpointBindingStoreError("The relay state directory could not be synced.", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

function endpointDigest(endpointId) {
  return createHash("sha256").update(endpointId, "utf8").digest("hex");
}

function lengthPrefixedString(value) {
  if (typeof value !== "string") throw new TypeError("Proof fields must be strings.");
  const bytes = Buffer.from(textEncoder.encode(value));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function unsigned64(value) {
  requirePositiveInteger(value, "proof integer");
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function sameStrings(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, count) {
  return Object.keys(value).length === count;
}

function boundedBase64Url(value, maximum) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && BASE64URL.test(value);
}

function validTimestamp(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function requireTimestamp(value) {
  if (!validTimestamp(value)) throw new TypeError("Invalid relay timestamp.");
}

function isoTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid relay clock value.");
  }
  return new Date(value).toISOString();
}

function requireEndpointId(value) {
  if (!ENDPOINT_ID.test(value ?? "")) throw new TypeError("Invalid relay endpoint ID.");
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Invalid ${label}.`);
  }
}

function resolveRequiredDirectory(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("A relay state directory is required.");
  }
  return resolve(value);
}

function boundedInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value)
    ? Math.max(minimum, Math.min(value, maximum))
    : fallback;
}

function validSocketId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function validSource(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_SOURCE_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function pruneFailures(failures, now) {
  while (failures.length > 0 && failures[0] <= now - MINUTE_MS) failures.shift();
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}
