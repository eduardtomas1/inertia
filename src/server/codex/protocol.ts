export type JsonObject = Record<string, unknown>;
export type RpcId = string | number;

export function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function boundedText(value: unknown, maxChars: number): string | undefined {
  const text = stringValue(value)?.replaceAll("\0", "").trim();
  if (!text) return undefined;
  return text.slice(0, maxChars);
}

export function rpcId(value: unknown): RpcId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

export class CappedTextBuffer {
  private value = "";
  truncated = false;

  constructor(private readonly maxChars: number) {}

  append(text: string): void {
    if (!text || this.truncated) return;
    const remaining = this.maxChars - this.value.length;
    this.value += text.slice(0, Math.max(0, remaining));
    if (text.length > remaining) this.truncated = true;
  }

  toString(): string {
    return this.value;
  }
}

export type JsonLineDecoderFailure =
  | "line-overflow"
  | "rate-overflow"
  | "malformed-utf8";

export const JSON_LINE_DEFAULT_WINDOW_MS = 60_000;

export interface JsonLineDecoderRateLimit {
  /** Maximum burst capacity and bytes replenished over one window. */
  maxBytes: number;
  windowMs: number;
  /** Monotonic test seam. Production uses the process monotonic clock. */
  now?: () => number;
}

/**
 * Frames JSONL by UTF-8 bytes rather than JavaScript characters. One growable
 * frame buffer bounds retained memory independently of input fragmentation.
 * The refillable byte budget rejects an unsafe burst without imposing a
 * lifetime cap on healthy long-running sessions.
 */
export class JsonLineDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private frame = Buffer.alloc(0);
  private lineBytes = 0;
  private stopped = false;
  private readonly rateLimit: JsonLineDecoderRateLimit | undefined;
  private readonly now: () => number;
  private availableBytes: number;
  private lastRefillAt: number;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onFailure: (failure: JsonLineDecoderFailure) => void,
    rateLimit?: number | JsonLineDecoderRateLimit,
  ) {
    this.rateLimit = typeof rateLimit === "number"
      ? { maxBytes: rateLimit, windowMs: JSON_LINE_DEFAULT_WINDOW_MS }
      : rateLimit;
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new Error("The JSONL frame limit is invalid.");
    }
    if (
      this.rateLimit
      && (
        !Number.isSafeInteger(this.rateLimit.maxBytes)
        || this.rateLimit.maxBytes < maxLineBytes
        || !Number.isSafeInteger(this.rateLimit.windowMs)
        || this.rateLimit.windowMs < 1
      )
    ) {
      throw new Error("The JSONL rate limit is invalid.");
    }
    this.now = this.rateLimit?.now ?? (() => performance.now());
    this.availableBytes = this.rateLimit?.maxBytes ?? Number.MAX_SAFE_INTEGER;
    this.lastRefillAt = this.now();
  }

  push(chunk: Buffer): void {
    if (this.stopped || chunk.length === 0) return;
    let offset = 0;
    while (!this.stopped && offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.append(chunk.subarray(offset, end))) return;
      if (newline === -1) return;
      if (!this.consumeBytes(1)) return;
      this.emitLine();
      offset = newline + 1;
    }
  }

  end(): void {
    if (this.stopped) return;
    if (this.lineBytes > 0) this.emitLine();
  }

  stop(): void {
    this.stopped = true;
    this.frame = Buffer.alloc(0);
    this.lineBytes = 0;
  }

  private append(segment: Buffer): boolean {
    if (segment.length === 0) return true;
    if (this.lineBytes + segment.length > this.maxLineBytes) {
      this.fail("line-overflow");
      return false;
    }
    if (!this.consumeBytes(segment.length)) return false;
    this.ensureFrameCapacity(this.lineBytes + segment.length);
    segment.copy(this.frame, this.lineBytes);
    this.lineBytes += segment.length;
    return true;
  }

  private consumeBytes(count: number): boolean {
    const rateLimit = this.rateLimit;
    if (!rateLimit) return true;
    const current = this.now();
    const elapsedMs = Math.max(0, current - this.lastRefillAt);
    this.lastRefillAt = current;
    this.availableBytes = Math.min(
      rateLimit.maxBytes,
      this.availableBytes
        + (elapsedMs * rateLimit.maxBytes / rateLimit.windowMs),
    );
    if (count > this.availableBytes) {
      this.fail("rate-overflow");
      return false;
    }
    this.availableBytes -= count;
    return true;
  }

  private ensureFrameCapacity(requiredBytes: number): void {
    if (this.frame.length >= requiredBytes) return;
    let capacity = Math.max(1, this.frame.length);
    while (capacity < requiredBytes) {
      capacity = Math.min(
        this.maxLineBytes,
        Math.max(requiredBytes, capacity * 2),
      );
    }
    const next = Buffer.allocUnsafe(capacity);
    if (this.lineBytes > 0) {
      this.frame.copy(next, 0, 0, this.lineBytes);
    }
    this.frame = next;
  }

  private emitLine(): void {
    if (this.stopped) return;
    const bytes = this.frame.subarray(0, this.lineBytes);
    let line: string;
    try {
      line = this.decoder.decode(bytes).replace(/\r$/u, "").trimEnd();
    } catch {
      this.fail("malformed-utf8");
      return;
    }
    this.lineBytes = 0;
    if (line) this.onLine(line);
  }

  private fail(failure: JsonLineDecoderFailure): void {
    if (this.stopped) return;
    this.stop();
    this.onFailure(failure);
  }
}
