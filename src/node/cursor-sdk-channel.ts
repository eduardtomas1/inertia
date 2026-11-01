import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

const FRAME_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;
const PENDING_LIMIT = 8;

export class CursorSdkChannel {
  private buffer = Buffer.alloc(0);
  private received = 0;
  private sent = 0;
  private serving = 0;
  private closed = false;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly seen = new Set<string>();

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly handler: (method: string, params: unknown) => Promise<unknown>,
    private readonly fatal: () => void,
  ) {
    input.on("data", (chunk: Buffer) => this.receive(chunk));
    input.once("end", () => this.close());
    input.once("error", () => this.close());
    output.once("error", () => this.close());
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed || this.pending.size >= PENDING_LIMIT || !/^[a-z-]{1,32}$/u.test(method)) return Promise.reject(new Error("Cursor SDK channel unavailable."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), Math.max(1, Math.min(timeoutMs, 30 * 60_000)));
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Cursor SDK private channel closed.")); }
    this.pending.clear();
    this.fatal();
  }

  private write(frame: unknown): void {
    if (this.closed) return;
    try {
      const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
      this.sent += bytes.length;
      if (bytes.length > FRAME_LIMIT || this.sent > TOTAL_LIMIT || this.output.writableLength + bytes.length > FRAME_LIMIT * 2) return this.close();
      this.output.write(bytes, (error) => { if (error) this.close(); });
    } catch { this.close(); }
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.received += chunk.length;
    if (this.received > TOTAL_LIMIT) return this.close();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      if (end > FRAME_LIMIT) return this.close();
      const bytes = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      try { this.dispatch(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
      catch { return this.close(); }
      if (this.closed) return;
    }
    if (this.buffer.length > FRAME_LIMIT) this.close();
  }

  private dispatch(frame: unknown): void {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("frame");
    const value = frame as Record<string, unknown>;
    if (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/u.test(value.id) || Object.keys(value).length !== 3) throw new Error("frame");
    if (typeof value.method === "string") {
      if (!/^[a-z-]{1,32}$/u.test(value.method) || !("params" in value) || this.seen.has(value.id)
        || this.seen.size >= 20_000 || this.serving >= PENDING_LIMIT) throw new Error("request");
      this.seen.add(value.id); this.serving += 1;
      const id = value.id;
      void Promise.resolve().then(() => this.handler(value.method as string, value.params)).then(
        (result) => this.write({ id, ok: true, result: result ?? null }),
        () => this.write({ id, ok: false, result: null }),
      ).finally(() => { this.serving -= 1; });
      return;
    }
    if (typeof value.ok !== "boolean" || !("result" in value)) throw new Error("response");
    const pending = this.pending.get(value.id);
    if (!pending) throw new Error("identity");
    this.pending.delete(value.id); clearTimeout(pending.timer);
    if (value.ok) pending.resolve(value.result);
    else pending.reject(new Error("Cursor SDK operation failed."));
  }
}
