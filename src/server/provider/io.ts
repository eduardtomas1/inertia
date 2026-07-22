import { StringDecoder } from "node:string_decoder";

export class ProviderNdjsonDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discardingLine = false;

  constructor(
    private readonly maxLineChars: number,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  end(): void {
    this.consume(this.decoder.end());
    if (!this.discardingLine && this.buffer.trim()) this.onLine(this.buffer.trimEnd());
    this.buffer = "";
  }

  private consume(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        const remainder = text.slice(offset);
        if (this.discardingLine) return;
        if (this.buffer.length + remainder.length > this.maxLineChars) {
          this.buffer = "";
          this.discardingLine = true;
          this.onOverflow();
        } else {
          this.buffer += remainder;
        }
        return;
      }

      const segment = text.slice(offset, newline);
      offset = newline + 1;
      if (this.discardingLine) {
        this.discardingLine = false;
        continue;
      }
      if (this.buffer.length + segment.length > this.maxLineChars) {
        this.buffer = "";
        this.onOverflow();
        continue;
      }
      const line = `${this.buffer}${segment}`.trimEnd();
      this.buffer = "";
      if (line) this.onLine(line);
    }
  }
}

export class CappedProviderBuffer {
  private value = "";
  truncated = false;

  constructor(private readonly maxChars: number) {}

  append(text: string): void {
    if (!text || this.truncated) return;
    const remaining = this.maxChars - this.value.length;
    if (text.length <= remaining) {
      this.value += text;
      return;
    }
    this.value += text.slice(0, Math.max(0, remaining));
    this.truncated = true;
  }

  toString(): string {
    return this.value;
  }
}
