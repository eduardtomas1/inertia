import { StringDecoder } from "node:string_decoder";

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

export class JsonLineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discarding = false;
  private stopped = false;

  constructor(
    private readonly maxLineChars: number,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.stopped) return;
    this.consume(this.decoder.write(chunk));
  }

  end(): void {
    if (this.stopped) return;
    this.consume(this.decoder.end());
    if (this.stopped) return;
    if (!this.discarding && this.buffer.trim()) this.onLine(this.buffer.trimEnd());
    this.buffer = "";
  }

  stop(): void {
    this.stopped = true;
    this.buffer = "";
  }

  private consume(text: string): void {
    let offset = 0;
    while (!this.stopped && offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        if (this.discarding) return;
        const remainder = text.slice(offset);
        if (this.buffer.length + remainder.length > this.maxLineChars) {
          this.buffer = "";
          this.discarding = true;
          this.onOverflow();
        } else {
          this.buffer += remainder;
        }
        return;
      }

      const segment = text.slice(offset, newline);
      offset = newline + 1;
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (this.buffer.length + segment.length > this.maxLineChars) {
        this.buffer = "";
        this.onOverflow();
        if (this.stopped) return;
        continue;
      }
      const line = `${this.buffer}${segment}`.trimEnd();
      this.buffer = "";
      if (line) this.onLine(line);
    }
  }
}
