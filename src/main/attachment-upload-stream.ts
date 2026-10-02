import type { FileHandle } from "node:fs/promises";
import { ATTACHMENT_UPLOAD_CHUNK_BYTES } from "../shared/attachments.js";

export class AttachmentUploadStream {
  private offset = 0;
  private destination: FileHandle | null = null;
  private ready!: () => void;
  private failReady!: (error: unknown) => void;
  private readonly opened = new Promise<void>((resolve, reject) => {
    this.ready = resolve;
    this.failReady = reject;
  });
  private finish!: () => void;
  private fail!: (error: unknown) => void;
  private readonly completed = new Promise<void>((resolve, reject) => {
    this.finish = resolve;
    this.fail = reject;
  });
  private writing = false;

  constructor(readonly size: number, signal: AbortSignal) {
    void this.opened.catch(() => undefined);
    void this.completed.catch(() => undefined);
    const abort = (): void => this.cancel(new Error("Attachment import was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    void this.completed.finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
    if (signal.aborted) abort();
  }

  cancel(error: unknown): void {
    this.failReady(error);
    this.fail(error);
  }

  async write(destination: FileHandle): Promise<void> {
    this.destination = destination;
    this.ready();
    await this.completed;
  }

  async chunk(data: unknown, offset: number, final: boolean): Promise<void> {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1
      || data.byteLength > ATTACHMENT_UPLOAD_CHUNK_BYTES || this.writing
      || offset !== this.offset || offset + data.byteLength > this.size
      || final !== (offset + data.byteLength === this.size)) {
      throw new Error("Invalid attachment upload chunk.");
    }
    this.writing = true;
    try {
      await this.opened;
      const bytes = Buffer.from(data);
      let written = 0;
      while (written < bytes.length) {
        const result = await this.destination!.write(bytes, written, bytes.length - written, offset + written);
        if (result.bytesWritten === 0) throw new Error("Attachment upload could not be written.");
        written += result.bytesWritten;
      }
      this.offset += bytes.length;
      if (final) this.finish();
    } finally {
      this.writing = false;
    }
  }
}
