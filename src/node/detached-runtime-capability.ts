import {
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const DETACHED_RUNTIME_CAPABILITY_VERSION = 1 as const;
export const DETACHED_RUNTIME_WEBSOCKET_PATH = "/runtime-detached";
export const DEFAULT_DETACHED_RUNTIME_CAPABILITY_TTL_MS = 15_000;
export const MAX_DETACHED_RUNTIME_CAPABILITY_TTL_MS = 60_000;
export const DEFAULT_DETACHED_RUNTIME_NONCE_CAPACITY = 1_024;

const CAPABILITY_VERSION = String(DETACHED_RUNTIME_CAPABILITY_VERSION);
const MAX_REQUEST_URL_CHARACTERS = 8_192;
const MAX_CLIENT_ID_CHARACTERS = 128;
const NONCE_BYTES = 24;
const NONCE_CHARACTERS = 32;
const HMAC_BYTES = 32;
const HMAC_CHARACTERS = 43;
const MAX_QUERY_ENTRIES = 16;
const MAX_NONCE_CAPACITY = 65_536;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]+$/u;

const QUERY = Object.freeze({
  version: "dc_version",
  conversationId: "dc_conversation",
  clientId: "dc_client",
  expiresAt: "dc_expires",
  nonce: "dc_nonce",
  signature: "dc_signature",
});

const CAPABILITY_QUERY_KEYS = new Set<string>(Object.values(QUERY));
const RUNTIME_RESUME_QUERY_KEYS = new Set([
  "runtimeGeneration",
  "afterSequence",
  "conversationId",
]);

export interface DetachedRuntimeAuthority {
  role: "detached-chat";
  version: typeof DETACHED_RUNTIME_CAPABILITY_VERSION;
  conversationId: string;
  clientId: string;
  expiresAt: number;
  nonce: string;
}

export interface MintDetachedRuntimeWebSocketUrlInput {
  /** The unmodified bearer URL returned by the current runtime generation. */
  websocketUrl: string;
  conversationId: string;
  clientId: string;
}

export interface MintDetachedRuntimeWebSocketUrlOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  ttlMs?: number;
}

export type DetachedRuntimeCapabilityVerification =
  | {
      kind: "accepted";
      authority: DetachedRuntimeAuthority;
      /**
       * Capability fields are removed while the original runtime resume fields
       * remain available to the existing runtime resume parser.
       */
      runtimeRequestUrl: string;
    }
  | { kind: "absent" }
  | {
      kind: "rejected";
      reason: "invalid" | "expired" | "replayed" | "capacity";
    };

export interface DetachedRuntimeCapabilityRegistryOptions {
  /** Exact pathname of the base runtime bearer URL. */
  websocketPath: string;
  /** The unmodified base runtime bearer URL used by the minting caller. */
  secret: string;
  now?: () => number;
  maxCapabilityTtlMs?: number;
  maxConsumedNonces?: number;
}

interface UnsignedDetachedRuntimeClaims {
  conversationId: string;
  clientId: string;
  expiresAt: number;
  nonce: string;
}

/**
 * Mint one short-lived upgrade URL. The base runtime URL is intentionally the
 * HMAC secret, so a runtime restart (and its new bearer URL) invalidates every
 * capability from the previous generation without another key lifecycle.
 */
export function mintDetachedRuntimeWebSocketUrl(
  input: MintDetachedRuntimeWebSocketUrlInput,
  options: MintDetachedRuntimeWebSocketUrlOptions = {},
): string {
  const base = parseBaseWebSocketUrl(input.websocketUrl);
  const conversationId = validConversationId(input.conversationId);
  if (!conversationId) {
    throw new Error("A valid detached conversation identity is required.");
  }
  if (!validClientId(input.clientId)) {
    throw new Error("A valid detached client identity is required.");
  }

  const now = readNow(options.now ?? Date.now);
  const ttlMs = options.ttlMs ?? DEFAULT_DETACHED_RUNTIME_CAPABILITY_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs)
    || ttlMs < 1
    || ttlMs > MAX_DETACHED_RUNTIME_CAPABILITY_TTL_MS
  ) {
    throw new Error("Detached runtime capability lifetime is invalid.");
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("Detached runtime capability lifetime is invalid.");
  }

  const random = options.randomBytes ?? nodeRandomBytes;
  const generated = random(NONCE_BYTES);
  if (!(generated instanceof Uint8Array) || generated.byteLength !== NONCE_BYTES) {
    throw new Error("Detached runtime capability entropy is unavailable.");
  }
  const nonce = Buffer.from(generated).toString("base64url");
  const claims: UnsignedDetachedRuntimeClaims = {
    conversationId,
    clientId: input.clientId,
    expiresAt,
    nonce,
  };
  const secret = Buffer.from(input.websocketUrl, "utf8");
  const signature = signCapability(secret, base.pathname, claims)
    .toString("base64url");

  base.pathname = DETACHED_RUNTIME_WEBSOCKET_PATH;
  base.searchParams.set(QUERY.version, CAPABILITY_VERSION);
  base.searchParams.set(QUERY.conversationId, claims.conversationId);
  base.searchParams.set(QUERY.clientId, claims.clientId);
  base.searchParams.set(QUERY.expiresAt, String(claims.expiresAt));
  base.searchParams.set(QUERY.nonce, claims.nonce);
  base.searchParams.set(QUERY.signature, signature);
  return base.toString();
}

/**
 * Synchronously verifies and consumes detached upgrade nonces. Node's
 * single-threaded execution makes the replay check and insertion atomic with
 * respect to every upgrade handled by this registry instance.
 */
export class DetachedRuntimeCapabilityRegistry {
  readonly #websocketPath: string;
  readonly #secret: Buffer;
  readonly #baseUrl: URL;
  readonly #now: () => number;
  readonly #maxCapabilityTtlMs: number;
  readonly #maxConsumedNonces: number;
  readonly #consumedNonces = new Map<string, number>();

  constructor(options: DetachedRuntimeCapabilityRegistryOptions) {
    if (!validWebSocketPath(options.websocketPath)) {
      throw new Error("Detached runtime capability path is invalid.");
    }
    if (options.websocketPath === DETACHED_RUNTIME_WEBSOCKET_PATH) {
      throw new Error("Detached runtime capability configuration is invalid.");
    }
    const baseUrl = parseBaseWebSocketUrl(options.secret);
    if (baseUrl.pathname !== options.websocketPath) {
      throw new Error("Detached runtime capability configuration is invalid.");
    }
    const maxCapabilityTtlMs = options.maxCapabilityTtlMs
      ?? MAX_DETACHED_RUNTIME_CAPABILITY_TTL_MS;
    if (
      !Number.isSafeInteger(maxCapabilityTtlMs)
      || maxCapabilityTtlMs < 1
      || maxCapabilityTtlMs > MAX_DETACHED_RUNTIME_CAPABILITY_TTL_MS
    ) {
      throw new Error("Detached runtime capability lifetime is invalid.");
    }
    const maxConsumedNonces = options.maxConsumedNonces
      ?? DEFAULT_DETACHED_RUNTIME_NONCE_CAPACITY;
    if (
      !Number.isSafeInteger(maxConsumedNonces)
      || maxConsumedNonces < 1
      || maxConsumedNonces > MAX_NONCE_CAPACITY
    ) {
      throw new Error("Detached runtime replay capacity is invalid.");
    }

    this.#websocketPath = options.websocketPath;
    this.#baseUrl = baseUrl;
    this.#secret = Buffer.from(options.secret, "utf8");
    this.#now = options.now ?? Date.now;
    this.#maxCapabilityTtlMs = maxCapabilityTtlMs;
    this.#maxConsumedNonces = maxConsumedNonces;
  }

  verifyAndConsume(
    requestUrl: string | undefined,
  ): DetachedRuntimeCapabilityVerification {
    const parsed = this.#parseRequestUrl(requestUrl);
    if (!parsed) return { kind: "rejected", reason: "invalid" };

    const capabilityEntryCount = [...parsed.searchParams.keys()].filter((key) =>
      CAPABILITY_QUERY_KEYS.has(key)).length;
    if (parsed.pathname === this.#websocketPath) {
      return capabilityEntryCount === 0
        ? { kind: "absent" }
        : { kind: "rejected", reason: "invalid" };
    }
    if (
      parsed.pathname !== DETACHED_RUNTIME_WEBSOCKET_PATH
      || capabilityEntryCount === 0
    ) return { kind: "rejected", reason: "invalid" };
    if (
      [...parsed.searchParams].length > MAX_QUERY_ENTRIES
      || [...parsed.searchParams.keys()].some((key) =>
        !CAPABILITY_QUERY_KEYS.has(key)
        && !RUNTIME_RESUME_QUERY_KEYS.has(key))
      || Object.values(QUERY).some((key) =>
        parsed.searchParams.getAll(key).length !== 1)
    ) {
      return { kind: "rejected", reason: "invalid" };
    }

    const version = parsed.searchParams.get(QUERY.version)!;
    const conversationId = validConversationId(
      parsed.searchParams.get(QUERY.conversationId)!,
    );
    const clientId = parsed.searchParams.get(QUERY.clientId)!;
    const expiresAt = parseSafeInteger(
      parsed.searchParams.get(QUERY.expiresAt)!,
    );
    const nonce = parsed.searchParams.get(QUERY.nonce)!;
    const suppliedSignature = parsed.searchParams.get(QUERY.signature)!;
    if (
      version !== CAPABILITY_VERSION
      || !conversationId
      || !validClientId(clientId)
      || expiresAt === null
      || !validNonce(nonce)
    ) {
      return { kind: "rejected", reason: "invalid" };
    }

    const claims: UnsignedDetachedRuntimeClaims = {
      conversationId,
      clientId,
      expiresAt,
      nonce,
    };
    const expectedSignature = signCapability(
      this.#secret,
      this.#websocketPath,
      claims,
    );
    if (!constantTimeSignatureMatch(expectedSignature, suppliedSignature)) {
      return { kind: "rejected", reason: "invalid" };
    }

    let now: number;
    try {
      now = readNow(this.#now);
    } catch {
      return { kind: "rejected", reason: "invalid" };
    }
    if (expiresAt <= now) {
      this.#pruneExpired(now);
      return { kind: "rejected", reason: "expired" };
    }
    if (expiresAt - now > this.#maxCapabilityTtlMs) {
      return { kind: "rejected", reason: "invalid" };
    }

    this.#pruneExpired(now);
    if (this.#consumedNonces.has(nonce)) {
      return { kind: "rejected", reason: "replayed" };
    }
    if (this.#consumedNonces.size >= this.#maxConsumedNonces) {
      return { kind: "rejected", reason: "capacity" };
    }
    this.#consumedNonces.set(nonce, expiresAt);

    return {
      kind: "accepted",
      authority: {
        role: "detached-chat",
        version: DETACHED_RUNTIME_CAPABILITY_VERSION,
        conversationId,
        clientId,
        expiresAt,
        nonce,
      },
      runtimeRequestUrl: runtimeRequestUrl(parsed, this.#websocketPath),
    };
  }

  #parseRequestUrl(requestUrl: string | undefined): URL | null {
    if (
      typeof requestUrl !== "string"
      || requestUrl.length < 1
      || requestUrl.length > MAX_REQUEST_URL_CHARACTERS
      || /[\u0000-\u001f\u007f]/u.test(requestUrl)
    ) return null;

    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(requestUrl);
    if (!absolute && (
      !requestUrl.startsWith("/")
      || requestUrl.startsWith("//")
    )) return null;

    let parsed: URL;
    try {
      parsed = new URL(requestUrl, "http://detached-runtime.invalid");
    } catch {
      return null;
    }
    if (
      parsed.hash
      || (
        parsed.pathname !== this.#websocketPath
        && parsed.pathname !== DETACHED_RUNTIME_WEBSOCKET_PATH
      )
    ) return null;

    if (absolute && (
      parsed.protocol !== this.#baseUrl.protocol
      || parsed.host !== this.#baseUrl.host
      || parsed.username
      || parsed.password
    )) return null;
    return parsed;
  }

  #pruneExpired(now: number): void {
    for (const [nonce, expiresAt] of this.#consumedNonces) {
      if (expiresAt <= now) this.#consumedNonces.delete(nonce);
    }
  }
}

function parseBaseWebSocketUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Detached runtime base URL is invalid.");
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
    || !validWebSocketPath(parsed.pathname)
  ) {
    throw new Error("Detached runtime base URL is invalid.");
  }
  return parsed;
}

function validWebSocketPath(value: string): boolean {
  return value.startsWith("/")
    && value.length > 1
    && value.length <= 2_048
    && !/[\0\r\n?#]/u.test(value);
}

function validConversationId(value: string): string | null {
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function validClientId(value: string): boolean {
  return value.length >= 1
    && value.length <= MAX_CLIENT_ID_CHARACTERS
    && CLIENT_ID_PATTERN.test(value);
}

function validNonce(value: string): boolean {
  return value.length === NONCE_CHARACTERS && NONCE_PATTERN.test(value);
}

function parseSafeInteger(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Detached runtime capability clock is invalid.");
  }
  return value;
}

function signCapability(
  secret: Buffer,
  websocketPath: string,
  claims: UnsignedDetachedRuntimeClaims,
): Buffer {
  const payload = JSON.stringify([
    "inertia-detached-runtime-capability",
    CAPABILITY_VERSION,
    websocketPath,
    claims.conversationId,
    claims.clientId,
    claims.expiresAt,
    claims.nonce,
  ]);
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

function constantTimeSignatureMatch(
  expected: Buffer,
  suppliedValue: string,
): boolean {
  let validEncoding = suppliedValue.length === HMAC_CHARACTERS
    && SIGNATURE_PATTERN.test(suppliedValue);
  let supplied = Buffer.alloc(HMAC_BYTES);
  if (validEncoding) {
    try {
      const decoded = Buffer.from(suppliedValue, "base64url");
      validEncoding = decoded.byteLength === HMAC_BYTES
        && decoded.toString("base64url") === suppliedValue;
      if (validEncoding) supplied = decoded;
    } catch {
      validEncoding = false;
    }
  }
  const equal = timingSafeEqual(expected, supplied);
  return validEncoding && equal;
}

function runtimeRequestUrl(parsed: URL, websocketPath: string): string {
  const resume = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    if (RUNTIME_RESUME_QUERY_KEYS.has(key)) resume.append(key, value);
  }
  const query = resume.toString();
  return query ? `${websocketPath}?${query}` : websocketPath;
}
