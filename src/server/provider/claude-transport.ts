import { Transform, type TransformCallback } from "node:stream";

import { ProviderRunEventBudget } from "./io";

// A Read result can contain two base64 copies of a 20 MiB image/PDF, plus
// its ordinary envelope. This raw boundary precedes the stricter parsed
// event/media budgets; it must also cover output the SDK ignores entirely.
export const CLAUDE_TRANSPORT_LIMITS = {
  maxLineBytes: 64 * 1024 * 1024,
  maxBurstLines: 32_768,
  maxBurstBytes: 192 * 1024 * 1024,
} as const;

export interface ClaudeTransportLimits {
  maxLineBytes: number;
  maxBurstLines: number;
  maxBurstBytes: number;
}

/** Counts bytes before SDK readline can retain them; never assembles a line. */
export class BoundedClaudeTransport extends Transform {
  private lineBytes = 0;
  private readonly budget: ProviderRunEventBudget;

  constructor(private readonly limits: ClaudeTransportLimits = CLAUDE_TRANSPORT_LIMITS) {
    super();
    this.budget = new ProviderRunEventBudget(
      "Claude transport", limits.maxLineBytes, limits.maxBurstLines, limits.maxBurstBytes,
    );
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      for (const byte of chunk) {
        this.lineBytes += 1;
        if (this.lineBytes > this.limits.maxLineBytes) {
          throw new Error("Claude transport sent an oversized stdout line.");
        }
        if (byte === 0x0a || byte === 0x0d) {
          // Count blank/ignored output and both CR/LF boundaries too. Counting
          // CRLF twice is conservative and included in the control-frame headroom.
          this.budget.observeBytes(this.lineBytes);
          this.lineBytes = 0;
        }
      }
      // Transform's writable/readable high water marks propagate backpressure
      // to child.stdout. Forward at most this chunk, without retaining a copy.
      callback(null, chunk);
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.lineBytes > 0) this.budget.observeBytes(this.lineBytes);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}
