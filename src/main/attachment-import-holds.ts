import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
} from "../shared/attachments.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Privileged staging state for renderer imports not yet adopted by Composer. */
export class RendererAttachmentImportHolds {
  private readonly batches = new Map<string, Set<string>>();
  private readonly attachmentBatches = new Map<string, string>();

  constructor(
    private readonly attachmentSize: (attachmentId: string) => number | null,
    private readonly unavailable: (attachmentId: string) => boolean,
  ) {}

  has(attachmentId: string): boolean {
    return this.attachmentBatches.has(attachmentId);
  }

  hold(batchId: string, attachmentIds: readonly string[]): void {
    if (
      !UUID_PATTERN.test(batchId)
      || attachmentIds.length !== 1
      || !UUID_PATTERN.test(attachmentIds[0] ?? "")
    ) throw new Error("Invalid attachment import batch.");
    const attachmentId = attachmentIds[0]!;
    const size = this.attachmentSize(attachmentId);
    const held = this.batches.get(batchId) ?? new Set<string>();
    const heldBytes = [...held].reduce(
      (total, id) => total + (this.attachmentSize(id) ?? 0),
      0,
    );
    if (
      held.size >= MAX_CHAT_ATTACHMENTS
      || size === null
      || heldBytes + size > MAX_CHAT_ATTACHMENT_TOTAL_BYTES
      || held.has(attachmentId)
      || this.attachmentBatches.has(attachmentId)
      || this.unavailable(attachmentId)
    ) throw new Error("Attachment import batch is unavailable.");
    held.add(attachmentId);
    this.batches.set(batchId, held);
    this.attachmentBatches.set(attachmentId, batchId);
  }

  commit(
    batchId: string,
    adoptedAttachmentIds: readonly string[],
    rollback: (attachmentId: string) => Promise<void>,
  ): Promise<void> {
    this.assertAdoptedIds(batchId, adoptedAttachmentIds);
    const held = this.batches.get(batchId);
    if (!held) {
      if (adoptedAttachmentIds.length === 0) return Promise.resolve();
      throw new Error("Attachment import batch is unavailable.");
    }
    if (adoptedAttachmentIds.some((id) => !held.has(id))) {
      throw new Error("Attachment import batch is unavailable.");
    }
    const adopted = new Set(adoptedAttachmentIds);
    const rejected = [...held].filter((id) => !adopted.has(id));
    this.batches.delete(batchId);
    for (const id of adopted) this.attachmentBatches.delete(id);
    return Promise.all(rejected.map(rollback)).then(() => undefined);
  }

  rollback(
    batchId: string,
    rollback: (attachmentId: string) => Promise<void>,
  ): Promise<void> {
    if (!UUID_PATTERN.test(batchId)) {
      throw new Error("Invalid attachment import batch.");
    }
    const held = this.batches.get(batchId);
    return held
      ? Promise.all([...held].map(rollback)).then(() => undefined)
      : Promise.resolve();
  }

  drop(attachmentId: string): void {
    const batchId = this.attachmentBatches.get(attachmentId);
    if (!batchId) return;
    this.attachmentBatches.delete(attachmentId);
    const batch = this.batches.get(batchId);
    batch?.delete(attachmentId);
    if (batch?.size === 0) this.batches.delete(batchId);
  }

  clear(): void {
    this.batches.clear();
    this.attachmentBatches.clear();
  }

  private assertAdoptedIds(
    batchId: string,
    adoptedAttachmentIds: readonly string[],
  ): void {
    if (
      !UUID_PATTERN.test(batchId)
      || adoptedAttachmentIds.length > MAX_CHAT_ATTACHMENTS
      || new Set(adoptedAttachmentIds).size !== adoptedAttachmentIds.length
      || adoptedAttachmentIds.some((id) => !UUID_PATTERN.test(id))
    ) throw new Error("Invalid attachment import batch.");
  }
}
