import { StringDecoder } from "node:string_decoder";

export class ProviderNdjsonDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private bufferBytes = 0;
  private discardingLine = false;

  constructor(
    private readonly maxLineBytes: number,
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
    this.bufferBytes = 0;
  }

  private consume(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        const remainder = text.slice(offset);
        if (this.discardingLine) return;
        const remainderBytes = Buffer.byteLength(remainder, "utf8");
        if (this.bufferBytes + remainderBytes > this.maxLineBytes) {
          this.buffer = "";
          this.bufferBytes = 0;
          this.discardingLine = true;
          this.onOverflow();
        } else {
          this.buffer += remainder;
          this.bufferBytes += remainderBytes;
        }
        return;
      }

      const segment = text.slice(offset, newline);
      offset = newline + 1;
      if (this.discardingLine) {
        this.discardingLine = false;
        this.bufferBytes = 0;
        continue;
      }
      const segmentBytes = Buffer.byteLength(segment, "utf8");
      if (this.bufferBytes + segmentBytes > this.maxLineBytes) {
        this.buffer = "";
        this.bufferBytes = 0;
        this.onOverflow();
        continue;
      }
      const line = `${this.buffer}${segment}`.trimEnd();
      this.buffer = "";
      this.bufferBytes = 0;
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

export const PROVIDER_EVENT_BUDGET_WINDOW_MS = 60_000;

export interface ProviderRunEventBudgetOptions {
  /**
   * Event limits are a burst/rate guard, not a lifetime allowance. A provider
   * run may legitimately remain active for hours, so capacity replenishes over
   * this window while the per-event limit continues to bound retained memory.
   */
  windowMs?: number;
  now?: () => number;
}

export class ProviderRunEventBudget {
  private availableEvents: number;
  private availableBytes: number;
  private lastRefillAt: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    private readonly providerLabel: string,
    private readonly maxEventBytes: number,
    private readonly maxEvents: number,
    private readonly maxTotalBytes: number,
    options: ProviderRunEventBudgetOptions = {},
  ) {
    this.windowMs = options.windowMs ?? PROVIDER_EVENT_BUDGET_WINDOW_MS;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(maxEventBytes)
      || maxEventBytes < 1
      || !Number.isSafeInteger(maxEvents)
      || maxEvents < 1
      || !Number.isSafeInteger(maxTotalBytes)
      || maxTotalBytes < 1
      || !Number.isSafeInteger(this.windowMs)
      || this.windowMs < 1
    ) {
      throw new Error("The provider event budget is invalid.");
    }
    this.availableEvents = maxEvents;
    this.availableBytes = maxTotalBytes;
    this.lastRefillAt = this.now();
  }

  observe(value: unknown): void {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error(`${this.providerLabel} sent an unserializable event.`);
    }
    if (serialized === undefined) {
      throw new Error(`${this.providerLabel} sent an unserializable event.`);
    }
    this.observeBytes(Buffer.byteLength(serialized, "utf8"));
  }

  observeBytes(byteLength: number): void {
    if (
      !Number.isSafeInteger(byteLength)
      || byteLength < 0
      || byteLength > this.maxEventBytes
    ) {
      throw new Error(`${this.providerLabel} sent an oversized event.`);
    }
    this.refill();
    if (this.availableEvents < 1 || this.availableBytes < byteLength) {
      throw new Error(
        `${this.providerLabel} exceeded the bounded event rate for this run.`,
      );
    }
    this.availableEvents -= 1;
    this.availableBytes -= byteLength;
  }

  private refill(): void {
    const observedAt = this.now();
    const elapsedMs = observedAt - this.lastRefillAt;
    if (!Number.isFinite(observedAt) || elapsedMs <= 0) return;
    this.lastRefillAt = observedAt;
    const fraction = Math.min(1, elapsedMs / this.windowMs);
    this.availableEvents = Math.min(
      this.maxEvents,
      this.availableEvents + this.maxEvents * fraction,
    );
    this.availableBytes = Math.min(
      this.maxTotalBytes,
      this.availableBytes + this.maxTotalBytes * fraction,
    );
  }
}
