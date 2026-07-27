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
  | "aggregate-overflow"
  | "malformed-utf8";

/**
 * Frames JSONL by UTF-8 bytes rather than JavaScript characters. Retained
 * memory is bounded to one frame and chunks are joined only when a complete
 * line is ready to parse.
 */
export class JsonLineDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly chunks: Buffer[] = [];
  private lineBytes = 0;
  private totalBytes = 0;
  private stopped = false;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onFailure: (failure: JsonLineDecoderFailure) => void,
    private readonly maxTotalBytes = Number.MAX_SAFE_INTEGER,
  ) {}

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
    this.chunks.length = 0;
    this.lineBytes = 0;
  }

  private append(segment: Buffer): boolean {
    if (segment.length === 0) return true;
    if (this.lineBytes + segment.length > this.maxLineBytes) {
      this.fail("line-overflow");
      return false;
    }
    if (!this.consumeBytes(segment.length)) return false;
    // Copy so a short retained segment cannot pin a much larger stream chunk.
    this.chunks.push(Buffer.from(segment));
    this.lineBytes += segment.length;
    return true;
  }

  private consumeBytes(count: number): boolean {
    if (this.totalBytes + count > this.maxTotalBytes) {
      this.fail("aggregate-overflow");
      return false;
    }
    this.totalBytes += count;
    return true;
  }

  private emitLine(): void {
    if (this.stopped) return;
    const bytes = this.chunks.length === 1
      ? this.chunks[0]!
      : Buffer.concat(this.chunks, this.lineBytes);
    this.chunks.length = 0;
    this.lineBytes = 0;
    let line: string;
    try {
      line = this.decoder.decode(bytes).replace(/\r$/u, "").trimEnd();
    } catch {
      this.fail("malformed-utf8");
      return;
    }
    if (line) this.onLine(line);
  }

  private fail(failure: JsonLineDecoderFailure): void {
    if (this.stopped) return;
    this.stop();
    this.onFailure(failure);
  }
}
