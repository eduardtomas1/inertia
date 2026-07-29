import { isAbsolute, posix, win32 } from "node:path";

export const MAX_SECURE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SECURE_FILE_PATH_BYTES = 4_096;

export interface SecureFileIdentity {
  dev: string;
  ino: string;
}

interface SecureFileRequestBase {
  root: string;
  rootIdentity: SecureFileIdentity;
  parentIdentities: readonly SecureFileIdentity[];
  targetIdentity: SecureFileIdentity;
  path: string;
  maxBytes: number;
}

export type SecureFileRequest =
  | SecureFileRequestBase & {
      operation: "read";
    }
  | SecureFileRequestBase & {
      operation: "replace";
      expectedDigest: string;
      contentBase64: string;
      expectedMode: number;
      mode: number;
    };

export interface SecureFileMetadata {
  digest: string;
  size: number;
  modifiedAt: string;
  mode: number;
}

export type SecureFileResult =
  | {
      ok: true;
      operation: "read";
      contentBase64: string;
      metadata: SecureFileMetadata;
    }
  | {
      ok: true;
      operation: "replace";
      metadata: SecureFileMetadata;
    }
  | {
      ok: false;
      code:
        | "conflict"
        | "invalid"
        | "not-found"
        | "too-large"
        | "unsafe"
        | "unavailable";
      message: string;
    };

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function safeIdentity(value: unknown): value is SecureFileIdentity {
  return plainObject(value)
    && Object.keys(value).length === 2
    && typeof value.dev === "string"
    && /^(?:0|[1-9][0-9]{0,39})$/u.test(value.dev)
    && typeof value.ino === "string"
    && /^[1-9][0-9]{0,39}$/u.test(value.ino);
}

export function secureFilePathSegments(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  const windows = platform === "win32";
  const pathApi = windows ? win32 : posix;
  if (!(typeof value === "string"
    && value.length > 0
    && value.length <= MAX_SECURE_FILE_PATH_BYTES
    && !/[\0\r\n]/u.test(value)
    && !pathApi.isAbsolute(value)
    && (!windows || !/^[A-Za-z]:/u.test(value)))) return null;
  const segments = value.split(windows ? /[\\/]/u : "/");
  if (segments.some(
    (segment) => segment.length === 0 || segment === "." || segment === "..",
  )) return null;
  if (!windows) return segments;
  return segments.every((segment) => {
    if (
      /[<>:"|?*\u0000-\u001f]/u.test(segment)
      || /[ .]$/u.test(segment)
    ) return false;
    const basename = segment.split(".")[0] ?? "";
    return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(basename);
  })
    ? segments
    : null;
}

function safeBase64(value: unknown, maxBytes: number): value is string {
  if (
    typeof value !== "string"
    || value.length > Math.ceil(maxBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
  ) return false;
  return Buffer.from(value, "base64").byteLength <= maxBytes;
}

function safeMetadata(value: unknown): value is SecureFileMetadata {
  if (!plainObject(value) || Object.keys(value).length !== 4) return false;
  return typeof value.digest === "string"
    && /^[a-f0-9]{64}$/u.test(value.digest)
    && safeInteger(value.size)
    && value.size <= MAX_SECURE_FILE_BYTES
    && typeof value.modifiedAt === "string"
    && value.modifiedAt.length > 0
    && value.modifiedAt.length <= 64
    && !Number.isNaN(Date.parse(value.modifiedAt))
    && safeInteger(value.mode)
    && value.mode <= 0o777;
}

export function parseSecureFileRequest(value: unknown): SecureFileRequest | null {
  if (!plainObject(value)) return null;
  if (
    (value.operation !== "read" && value.operation !== "replace")
    || typeof value.root !== "string"
    || value.root.length === 0
    || value.root.length > MAX_SECURE_FILE_PATH_BYTES
    || value.root.includes("\0")
    || !isAbsolute(value.root)
    || !safeIdentity(value.rootIdentity)
    || !Array.isArray(value.parentIdentities)
    || value.parentIdentities.length > 256
    || !value.parentIdentities.every(safeIdentity)
    || !safeIdentity(value.targetIdentity)
    || typeof value.path !== "string"
    || !secureFilePathSegments(value.path)
    || !safeInteger(value.maxBytes)
    || value.maxBytes < 1
    || value.maxBytes > MAX_SECURE_FILE_BYTES
  ) return null;
  const segmentCount = secureFilePathSegments(value.path)!.length;
  if (value.parentIdentities.length !== segmentCount - 1) return null;
  const base: SecureFileRequestBase = {
    root: value.root,
    rootIdentity: value.rootIdentity,
    parentIdentities: value.parentIdentities,
    targetIdentity: value.targetIdentity,
    path: value.path,
    maxBytes: value.maxBytes,
  };
  if (value.operation === "read") {
    return Object.keys(value).length === 7
      ? { ...base, operation: "read" }
      : null;
  }
  return Object.keys(value).length === 11
    && typeof value.expectedDigest === "string"
    && /^[a-f0-9]{64}$/u.test(value.expectedDigest)
    && safeBase64(value.contentBase64, value.maxBytes)
    && safeInteger(value.expectedMode)
    && value.expectedMode <= 0o777
    && safeInteger(value.mode)
    && value.mode <= 0o777
    ? {
        ...base,
        operation: "replace",
        expectedDigest: value.expectedDigest,
        contentBase64: value.contentBase64,
        expectedMode: value.expectedMode,
        mode: value.mode,
      }
    : null;
}

export function parseSecureFileResult(value: unknown): SecureFileResult | null {
  if (!plainObject(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) {
    if (
      Object.keys(value).length !== 3
      || (
        value.code !== "conflict"
        && value.code !== "invalid"
        && value.code !== "not-found"
        && value.code !== "too-large"
        && value.code !== "unsafe"
        && value.code !== "unavailable"
      )
      || typeof value.message !== "string"
    ) return null;
    const message = value.message.trim();
    return message.length > 0 && message.length <= 300
      ? { ok: false, code: value.code, message }
      : null;
  }
  if (
    (value.operation !== "read" && value.operation !== "replace")
    || !safeMetadata(value.metadata)
  ) return null;
  if (value.operation === "replace") {
    return Object.keys(value).length === 3
      ? { ok: true, operation: "replace", metadata: value.metadata }
      : null;
  }
  return Object.keys(value).length === 4
    && safeBase64(value.contentBase64, value.metadata.size)
    && Buffer.from(value.contentBase64, "base64").byteLength
      === value.metadata.size
    ? {
        ok: true,
        operation: "read",
        contentBase64: value.contentBase64,
        metadata: value.metadata,
      }
    : null;
}
