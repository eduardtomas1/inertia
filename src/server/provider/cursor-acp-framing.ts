import { Transform, type TransformCallback } from "node:stream";

import type { ProviderRunEventBudget } from "./io";
import { parseAcpSessionNotification, validAcpJsonRpcEnvelope } from "./acp-json-rpc";
import {
  parseCursorGenerateImageNotification,
  parseCursorTaskNotification,
  parseCursorTodosRequest,
} from "./cursor-acp-extensions";

export function validateCursorVendorFrame(frame: unknown, active: boolean): void {
  const envelope = frame as { method?: unknown; params?: unknown };
  const notificationOnly = envelope.method === "cursor/update_todos"
    || envelope.method === "cursor/task"
    || envelope.method === "cursor/generate_image";
  if (!notificationOnly) return;
  if (Object.prototype.hasOwnProperty.call(envelope, "id")) {
    throw new Error("Cursor ACP sent a malformed notification as a JSON-RPC request.");
  }
  if (!active) return;
  try {
    if (envelope.method === "cursor/update_todos") parseCursorTodosRequest(envelope.params);
    if (envelope.method === "cursor/task") parseCursorTaskNotification(envelope.params);
    if (envelope.method === "cursor/generate_image") {
      parseCursorGenerateImageNotification(envelope.params);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid payload";
    throw new Error(`Cursor ACP sent a malformed vendor notification: ${detail}`);
  }
}

/**
 * Validates Cursor's newline-delimited ACP transport before the SDK sees it.
 * Byte accounting happens before decoded fragments are retained, and the
 * streaming fatal decoder rejects malformed UTF-8 even when a code point is
 * split across stdout chunks.
 */
export class BoundedJsonLineTransform extends Transform {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private decodedParts: string[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly maxLineBytes: number,
    private readonly eventBudget: ProviderRunEventBudget,
    private readonly validateFrame?: (frame: unknown) => void,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      let newline: number;
      while ((newline = chunk.indexOf(0x0a, offset)) >= 0) {
        this.appendFragment(chunk.subarray(offset, newline));
        this.finishLine();
        offset = newline + 1;
      }
      this.appendFragment(chunk.subarray(offset));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.pendingBytes > 0) this.finishLine();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private appendFragment(fragment: Buffer): void {
    if (fragment.byteLength === 0) return;
    const nextBytes = this.pendingBytes + fragment.byteLength;
    if (nextBytes > this.maxLineBytes) {
      throw new Error("Cursor ACP sent an oversized JSON-RPC frame.");
    }
    const decoded = this.decoder.decode(fragment, { stream: true });
    if (decoded) this.decodedParts.push(decoded);
    this.pendingBytes = nextBytes;
  }

  private finishLine(): void {
    const trailing = this.decoder.decode();
    if (trailing) this.decodedParts.push(trailing);
    const line = this.decodedParts.join("");
    const lineBytes = this.pendingBytes;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.decodedParts = [];
    this.pendingBytes = 0;
    if (lineBytes === 0) return;
    const parsed: unknown = JSON.parse(line);
    if (!validAcpJsonRpcEnvelope(parsed)) {
      throw new Error("Cursor ACP sent a malformed JSON-RPC frame.");
    }
    if ((parsed as { method?: unknown }).method === "session/update") {
      parseAcpSessionNotification((parsed as { params?: unknown }).params);
    }
    this.validateFrame?.(parsed);
    this.eventBudget.observeBytes(lineBytes);
    this.push(`${line}\n`);
  }
}
