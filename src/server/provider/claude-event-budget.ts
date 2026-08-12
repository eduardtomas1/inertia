import { createHash } from "node:crypto";

import { ProviderRunEventBudget } from "./io";

export const MAX_CLAUDE_EVENT_MEDIA_BYTES = 20 * 1024 * 1024;
export const MAX_CLAUDE_RUN_MEDIA_BYTES = 48 * 1024 * 1024;
export const MAX_CLAUDE_RUN_MEDIA_ENCODED_BYTES = 128 * 1024 * 1024;
const MAX_CLAUDE_EVENT_MEDIA_ENCODED_CHARS =
  4 * Math.ceil(MAX_CLAUDE_EVENT_MEDIA_BYTES / 3);

type JsonObject = Record<string, unknown>;

interface ClaudeMediaCandidate {
  outerIndex: number;
  innerIndex: number;
  data: string;
  decodedBytes: number;
  digest: string;
  mediaType: string;
}

interface ClaudeMediaProjection {
  value: unknown;
  mediaBytes: number;
  mediaEncodedBytes: number;
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function hasExactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isBase64Character(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2f;
}

function base64Value(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  return code === 0x2b ? 62 : 63;
}

/**
 * Validates canonical RFC 4648 base64 without decoding a second in-memory copy
 * of SDK-owned media. The unused bits in padded quartets must be zero too.
 */
function canonicalBase64Bytes(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    if (!isBase64Character(value.charCodeAt(index))) return null;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return null;
  }
  if (
    (padding === 2 && (base64Value(value.charCodeAt(value.length - 3)) & 0x0f) !== 0)
    || (padding === 1 && (base64Value(value.charCodeAt(value.length - 2)) & 0x03) !== 0)
  ) {
    return null;
  }
  return (value.length / 4) * 3 - padding;
}

function mediaDigest(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("hex");
}

function mediaCandidate(
  block: JsonObject,
  outerIndex: number,
  innerIndex: number,
): ClaudeMediaCandidate | null {
  if (block.type !== "image" && block.type !== "document") return null;
  if (!hasExactKeys(block, ["type", "source"])) return null;
  const source = objectValue(block.source);
  if (!source || source.type !== "base64") return null;
  if (!hasExactKeys(source, ["type", "media_type", "data"])) {
    throw new Error("Claude sent malformed tool-result media.");
  }
  const mediaType = source.media_type;
  if (typeof mediaType !== "string") {
    throw new Error("Claude sent malformed tool-result media.");
  }
  const validMediaType = block.type === "image"
    ? mediaType === "image/jpeg"
      || mediaType === "image/png"
      || mediaType === "image/gif"
      || mediaType === "image/webp"
    : mediaType === "application/pdf";
  if (!validMediaType || typeof source.data !== "string") {
    throw new Error("Claude sent malformed tool-result media.");
  }
  if (source.data.length > MAX_CLAUDE_EVENT_MEDIA_ENCODED_CHARS) {
    throw new Error("Claude sent oversized tool-result media.");
  }
  const decodedBytes = canonicalBase64Bytes(source.data);
  if (decodedBytes === null) {
    throw new Error("Claude sent non-canonical base64 tool-result media.");
  }
  if (decodedBytes > MAX_CLAUDE_EVENT_MEDIA_BYTES) {
    throw new Error("Claude sent oversized tool-result media.");
  }
  return {
    outerIndex,
    innerIndex,
    data: source.data,
    decodedBytes,
    digest: mediaDigest(source.data),
    mediaType,
  };
}

function toolResultMedia(content: unknown[]): ClaudeMediaCandidate[] {
  const candidates: ClaudeMediaCandidate[] = [];
  for (let outerIndex = 0; outerIndex < content.length; outerIndex += 1) {
    const result = objectValue(content[outerIndex]);
    if (result?.type !== "tool_result" || !Array.isArray(result.content)) {
      continue;
    }
    for (let innerIndex = 0; innerIndex < result.content.length; innerIndex += 1) {
      const block = objectValue(result.content[innerIndex]);
      if (!block) continue;
      const candidate = mediaCandidate(block, outerIndex, innerIndex);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function validImageDimensions(value: unknown): boolean {
  if (value === undefined) return true;
  const dimensions = objectValue(value);
  if (!dimensions || !hasExactKeys(dimensions, [], [
    "originalWidth",
    "originalHeight",
    "displayWidth",
    "displayHeight",
  ])) {
    return false;
  }
  return Object.values(dimensions).every((entry) =>
    typeof entry === "number"
    && Number.isSafeInteger(entry)
    && entry > 0);
}

function structuredReadMedia(
  value: unknown,
): { data: string; decodedBytes: number; mediaType: string } | null {
  const result = objectValue(value);
  const file = objectValue(result?.file);
  if (!result || !file) return null;
  if (result.type === "image") {
    if (
      !hasExactKeys(result, ["type", "file"])
      || !hasExactKeys(file, ["base64", "type", "originalSize"], ["dimensions"])
      || (file.type !== "image/jpeg"
        && file.type !== "image/png"
        && file.type !== "image/gif"
        && file.type !== "image/webp")
      || !validImageDimensions(file.dimensions)
    ) {
      return null;
    }
  } else if (result.type === "pdf") {
    if (
      !hasExactKeys(result, ["type", "file"])
      || !hasExactKeys(file, ["filePath", "base64", "originalSize"])
      || typeof file.filePath !== "string"
      || file.filePath.length === 0
      || file.filePath.length > 4_096
      || file.filePath.includes("\0")
    ) {
      return null;
    }
  } else {
    return null;
  }
  if (
    typeof file.base64 !== "string"
    || typeof file.originalSize !== "number"
    || !Number.isSafeInteger(file.originalSize)
    || file.originalSize < 1
  ) {
    throw new Error("Claude sent malformed structured tool-result media.");
  }
  if (file.base64.length > MAX_CLAUDE_EVENT_MEDIA_ENCODED_CHARS) {
    throw new Error("Claude sent oversized tool-result media.");
  }
  const decodedBytes = canonicalBase64Bytes(file.base64);
  if (decodedBytes === null) {
    throw new Error("Claude sent non-canonical base64 tool-result media.");
  }
  if (
    decodedBytes > MAX_CLAUDE_EVENT_MEDIA_BYTES
    || file.originalSize > MAX_CLAUDE_EVENT_MEDIA_BYTES
  ) {
    throw new Error("Claude sent oversized tool-result media.");
  }
  if (decodedBytes !== file.originalSize) {
    throw new Error("Claude sent inconsistent tool-result media metadata.");
  }
  return {
    data: file.base64,
    decodedBytes,
    mediaType: result.type === "image" ? file.type as string : "application/pdf",
  };
}

function projectedMediaEvent(
  message: JsonObject,
  content: unknown[],
  candidate: ClaudeMediaCandidate,
  structured: JsonObject,
): unknown {
  const marker = `[base64 media omitted; sha256=${candidate.digest}; bytes=${candidate.decodedBytes}]`;
  const projectedContent = content.map((outer, outerIndex) => {
    if (outerIndex !== candidate.outerIndex) return outer;
    const result = objectValue(outer)!;
    const resultContent = result.content as unknown[];
    return {
      ...result,
      content: resultContent.map((inner, innerIndex) => {
        if (innerIndex !== candidate.innerIndex) return inner;
        const block = objectValue(inner)!;
        const source = objectValue(block.source)!;
        return { ...block, source: { ...source, data: marker } };
      }),
    };
  });
  const file = objectValue(structured.file)!;
  return {
    ...message,
    message: {
      ...objectValue(message.message),
      content: projectedContent,
    },
    tool_use_result: {
      ...structured,
      file: { ...file, base64: marker },
    },
  };
}

/**
 * Projects only the Claude SDK's exact duplicated Read image/PDF result shape.
 * Arbitrary base64 fields and every non-media field remain in the ordinary
 * event serialization budget and therefore cannot use this exception.
 */
export function projectClaudeSdkEventMedia(value: unknown): ClaudeMediaProjection {
  const message = objectValue(value);
  const sdkMessage = objectValue(message?.message);
  if (
    !message
    || message.type !== "user"
    || !sdkMessage
    || sdkMessage.role !== "user"
    || !Array.isArray(sdkMessage.content)
  ) {
    return { value, mediaBytes: 0, mediaEncodedBytes: 0 };
  }
  const candidates = toolResultMedia(sdkMessage.content);
  // Query yields the SDK contract's snake_case `tool_use_result`. Claude's
  // separate on-disk transcript serializer writes the same field as
  // `toolUseResult`; accepting that persistence shape here would widen the
  // live protocol boundary without evidence that Query can emit it.
  const structured = objectValue(message.tool_use_result);
  const readMedia = structuredReadMedia(structured);
  if (!structured || !readMedia) {
    return { value, mediaBytes: 0, mediaEncodedBytes: 0 };
  }
  const matches = candidates.filter((candidate) =>
    candidate.decodedBytes === readMedia.decodedBytes
    && candidate.mediaType === readMedia.mediaType
    && candidate.data === readMedia.data);
  if (matches.length !== 1) {
    return { value, mediaBytes: 0, mediaEncodedBytes: 0 };
  }
  return {
    value: projectedMediaEvent(message, sdkMessage.content, matches[0]!, structured),
    mediaBytes: matches[0]!.decodedBytes,
    // The exact Read topology contains the same ASCII base64 once in the
    // model-facing block and once in the SDK's structured result.
    mediaEncodedBytes: matches[0]!.data.length * 2,
  };
}

export class ClaudeRunEventBudget {
  private mediaBytes = 0;
  private mediaEncodedBytes = 0;

  constructor(private readonly events: ProviderRunEventBudget) {}

  observe(value: unknown): void {
    const projected = projectClaudeSdkEventMedia(value);
    if (this.mediaBytes + projected.mediaBytes > MAX_CLAUDE_RUN_MEDIA_BYTES) {
      throw new Error("Claude exceeded the bounded media event budget for this run.");
    }
    // For the current exact two-copy topology this is a derived raw-wire
    // ceiling for the decoded budget. Keep it explicit so a future topology
    // change cannot silently add another encoded occurrence.
    if (
      this.mediaEncodedBytes + projected.mediaEncodedBytes
      > MAX_CLAUDE_RUN_MEDIA_ENCODED_BYTES
    ) {
      throw new Error("Claude exceeded the bounded encoded-media event budget for this run.");
    }
    this.events.observe(projected.value);
    this.mediaBytes += projected.mediaBytes;
    this.mediaEncodedBytes += projected.mediaEncodedBytes;
  }
}
