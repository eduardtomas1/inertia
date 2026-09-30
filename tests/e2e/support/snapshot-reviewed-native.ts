import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nativeImage, type BrowserWindow } from "electron";
import type { SnapshotDelivery } from "../../../src/shared/snapshots";
import type { SnapshotReview } from "../../../src/shared/snapshot-review";
import { SnapshotReviewService } from "../../../src/main/snapshot-review";
import type { AttachmentRegistry } from "../../../src/main/attachment-registry";
import type { RendererAttachmentImportCoordinator } from "../../../src/main/attachment-import-ipc";

export async function verifyReviewedNativeScreenshot(window: BrowserWindow): Promise<void> {
  const frame = window.webContents.mainFrame;
  const owner = { window, conversationId: randomUUID(), document: { owner: window.webContents,
    processId: frame.processId, frameId: frame.routingId, frameToken: frame.frameToken } };
  const reviewId = randomUUID();
  let received: SnapshotReview | null = null;
  let imported: Buffer | null = null;
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    if (channel === "inertia:snapshot-ready") {
      const delivery = args[0] as SnapshotDelivery;
      if (delivery.review) received = delivery.review;
    }
    send(channel, ...args);
  };
  const review = (): SnapshotReview => { assert(received); return received; };
  const imports: Pick<RendererAttachmentImportCoordinator, "begin" | "cancel" | "importSelection"> = { begin: () => randomUUID(), cancel: async () => undefined,
      importSelection: async (_document, _batch, run) => await run(new AbortController().signal),
  };
  const service = new SnapshotReviewService({
    imports: imports as RendererAttachmentImportCoordinator,
    registry: () => ({ import: async (inputs: { data: Buffer }[]) => {
      imported = inputs[0]!.data; return [{ id: randomUUID() }];
    } }) as unknown as AttachmentRegistry,
  });
  try {
    await service.request(owner, { type: "review-start", reviewId, conversationId: owner.conversationId });
    const sources = review(); assert.equal(sources.stage, "sources");
    if (sources.stage !== "sources") return;
    const target = sources.sources.find((source) => source.name === "Inertia native snapshot fixture");
    assert(target, "The actual synthetic X11 window must be offered");
    assert.equal(imported, null);
    await service.request(owner, { type: "review-select", reviewId, sourceId: target.id });
    const selected = review(); assert.equal(selected.stage, "image");
    if (selected.stage !== "image") return;
    assert.equal(imported, null, "Pixels must stay out of the attachment registry before review");
    const original = nativeImage.createFromDataURL(selected.preview);
    assert(!original.isEmpty());
    await service.request(owner, { type: "review-edit", reviewId, revision: selected.revision,
      operation: "mask", area: { x: 10, y: 10, width: 100, height: 100 } });
    const masked = review(); assert.equal(masked.stage, "image"); if (masked.stage !== "image") return;
    const bitmap = nativeImage.createFromDataURL(masked.preview).toBitmap();
    assert.deepEqual([...bitmap.subarray((20 * masked.width + 20) * 4, (20 * masked.width + 20) * 4 + 4)], [36, 36, 36, 255]);
    await service.request(owner, { type: "review-edit", reviewId, revision: masked.revision,
      operation: "crop", area: { x: 10, y: 10, width: 200, height: 150 } });
    const cropped = review(); assert.equal(cropped.stage, "image"); if (cropped.stage !== "image") return;
    assert.equal(cropped.width, 200); assert.equal(cropped.height, 150); assert.equal(imported, null);
    await service.request(owner, { type: "review-approve", reviewId, revision: cropped.revision });
    assert(imported);
    assert.deepEqual(imported, nativeImage.createFromDataURL(cropped.preview).toPNG(), "Import exactly the approved, edited pixels");
    console.log("NATIVE_SNAPSHOT_EVIDENCE reviewed-without-accessibility");
  } finally { await service.stop(); window.webContents.send = send; }
}
