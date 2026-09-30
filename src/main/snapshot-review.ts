import { randomUUID } from "node:crypto";
import { desktopCapturer, nativeImage, type BrowserWindow, type DesktopCapturerSource, type NativeImage } from "electron";
import { DESKTOP_IPC } from "../shared/desktop-ipc.js";
import { SNAPSHOT_MAX_IMAGE_BYTES, type SnapshotDelivery } from "../shared/snapshots.js";
import { reviewedSnapshotBackend, type SnapshotReview, type SnapshotReviewRequest, type SnapshotReviewArea } from "../shared/snapshot-review.js";
import type { AttachmentImportDocument, RendererAttachmentImportCoordinator } from "./attachment-import-ipc.js";
import type { AttachmentRegistry } from "./attachment-registry.js";

const MAX_SOURCES = 48;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const REVIEW_TIMEOUT = 180_000;

export function editReviewedImage(image: NativeImage, operation: "crop" | "mask", area: SnapshotReviewArea): NativeImage {
  const { width, height } = image.getSize();
  if (area.x + area.width > width || area.y + area.height > height) throw new Error("Choose an area inside the image.");
  if (operation === "crop") return image.crop(area);
  const bitmap = image.toBitmap();
  if (bitmap.length !== width * height * 4) throw new Error("This image could not be edited.");
  for (let y = area.y; y < area.y + area.height; y += 1) {
    for (let x = area.x; x < area.x + area.width; x += 1) {
      const offset = (y * width + x) * 4;
      bitmap[offset] = bitmap[offset + 1] = bitmap[offset + 2] = 36;
      bitmap[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
}

interface ReviewOwner {
  document: AttachmentImportDocument;
  window: BrowserWindow;
  conversationId: string;
}
interface PendingReview extends ReviewOwner {
  id: string;
  image: NativeImage | null;
  revision: number;
  sources: Map<string, string>;
  busy: boolean;
  controller: AbortController;
  batchId: string | null;
  timer: NodeJS.Timeout;
  detach(): void;
}

export class SnapshotReviewService {
  private pending: PendingReview | null = null;
  private acquisition: Promise<DesktopCapturerSource[]> | null = null;
  private readonly cleanups = new Set<Promise<void>>();
  constructor(private readonly options: {
    imports: RendererAttachmentImportCoordinator;
    registry(): AttachmentRegistry;
    onFailure?(): void;
  }) {}

  private live(review: PendingReview): boolean {
    if (this.pending !== review || review.window.isDestroyed() || review.window.webContents.isDestroyed()) return false;
    const frame = review.window.webContents.mainFrame;
    return frame.processId === review.document.processId && frame.routingId === review.document.frameId
      && frame.frameToken === review.document.frameToken;
  }

  private send(review: PendingReview, state: SnapshotReview): void {
    if (!this.live(review)) return;
    try {
      review.window.webContents.send(DESKTOP_IPC.snapshotReady, {
        conversationId: review.conversationId, review: state,
      } satisfies SnapshotDelivery);
    } catch {
      return;
    }
  }

  private owned(owner: ReviewOwner, id: string): PendingReview {
    const review = this.pending;
    if (!review || !this.live(review) || review.id !== id || owner.document.owner !== review.document.owner
      || owner.document.processId !== review.document.processId || owner.document.frameId !== review.document.frameId
      || owner.document.frameToken !== review.document.frameToken || owner.conversationId !== review.conversationId) {
      throw new Error("This screenshot review is no longer available.");
    }
    return review;
  }

  async request(owner: ReviewOwner, request: SnapshotReviewRequest): Promise<void> {
    if (request.type === "review-start") { await this.start(owner, request.reviewId); return; }
    const review = this.owned(owner, request.reviewId);
    if (request.type === "review-cancel") { await this.cancel(); return; }
    if (review.busy) throw new Error("Wait for the current screenshot operation to finish.");
    review.busy = true;
    try {
      if (request.type === "review-select") {
        const sourceId = review.sources.get(request.sourceId);
        if (!sourceId) throw new Error("Choose a window from this screenshot review.");
        const sources = await this.capture(review, 2048, false, sourceId.startsWith("screen:"));
        if (!this.live(review)) return;
        const source = sources.find((candidate) => candidate.id === sourceId);
        if (!source) throw new Error("The selected window closed. Start a new screenshot.");
        this.setImage(review, source.thumbnail);
      } else {
        if (!review.image || request.revision !== review.revision) throw new Error("Review the current image before attaching it.");
        if (request.type === "review-edit") {
          if (review.revision >= 50) throw new Error("Start a new screenshot to make more edits.");
          this.setImage(review, editReviewedImage(review.image, request.operation, request.area));
        } else {
          const png = review.image.toPNG();
          review.batchId = this.options.imports.begin(review.document);
          const attachments = await this.options.imports.importSelection(review.document, review.batchId,
            async (signal) => await this.options.registry().import([{
              name: "reviewed-screenshot.png", mimeType: "image/png", data: png,
            }], signal));
          if (!this.live(review)) { await this.options.imports.cancel(review.document, review.batchId); return; }
          review.window.webContents.send(DESKTOP_IPC.snapshotReady, {
            conversationId: review.conversationId, selection: { batchId: review.batchId, attachments },
          } satisfies SnapshotDelivery);
          review.batchId = null;
          this.release(review);
        }
      }
    } catch {
      if (this.live(review)) {
        this.options.onFailure?.();
        this.send(review, { reviewId: review.id, stage: "closed", message: "Screenshot could not be prepared. Start a new screenshot and try again." });
        await this.cancel();
      }
    } finally { review.busy = false; }
  }

  private async start(owner: ReviewOwner, id: string): Promise<void> {
    const backend = reviewedSnapshotBackend(process.platform, process.env);
    if (!backend) throw new Error("Reviewed screenshots require a Linux desktop session.");
    if (this.pending || this.acquisition || this.cleanups.size) throw new Error("Finish or close the current system screenshot picker first.");
    const review: PendingReview = { ...owner, id, image: null, revision: 0, sources: new Map(), busy: true, controller: new AbortController(), batchId: null,
      timer: setTimeout(() => {
        this.send(review, { reviewId: id, stage: "closed", message: "Screenshot review expired. Take a new screenshot." });
        void this.cancel().catch(() => undefined);
      }, REVIEW_TIMEOUT), detach: () => undefined };
    const invalidate = (): void => { if (this.pending === review) void this.cancel().catch(() => undefined); };
    const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) invalidate();
    };
    owner.document.owner.on("destroyed", invalidate);
    owner.document.owner.on("render-process-gone", invalidate);
    owner.document.owner.on("did-start-navigation", navigate);
    review.detach = () => {
      owner.document.owner.removeListener("destroyed", invalidate);
      owner.document.owner.removeListener("render-process-gone", invalidate);
      owner.document.owner.removeListener("did-start-navigation", navigate);
    };
    this.pending = review;
    try {
      const sources = await this.capture(review, backend === "system-picker" ? 2048 : 320, backend === "system-picker", backend === "system-picker");
      if (!this.live(review)) return;
      if (backend === "system-picker") {
        if (sources.length !== 1) throw new Error("The system did not select a source.");
        this.setImage(review, sources[0]!.thumbnail);
      } else {
        let bytes = 0;
        const choices = [];
        for (const source of sources.slice(0, MAX_SOURCES)) {
          if (source.thumbnail.isEmpty()) continue;
          const png = source.thumbnail.toPNG();
          bytes += png.length;
          if (bytes > MAX_PREVIEW_BYTES) break;
          const key = randomUUID();
          review.sources.set(key, source.id);
          choices.push({ id: key, name: source.name.slice(0, 200), preview: `data:image/png;base64,${png.toString("base64")}` });
        }
        if (!choices.length) throw new Error("No capture sources are available.");
        review.timer.refresh();
        this.send(review, { reviewId: id, stage: "sources", sources: choices });
      }
    } catch {
      if (this.live(review)) {
        this.options.onFailure?.();
        this.send(review, { reviewId: id, stage: "closed", message: "Screenshot was cancelled, denied, or unavailable. Nothing was attached." });
        await this.cancel();
      }
    } finally { review.busy = false; }
  }

  private async capture(review: PendingReview, size: number, interactive: boolean, hidePicker: boolean): Promise<DesktopCapturerSource[]> {
    const hidden = hidePicker && review.window.isVisible();
    if (hidden) review.window.hide();
    try {
      if (hidden) await new Promise((resolve) => setTimeout(resolve, 150));
      return await this.acquire(size, interactive, review.controller.signal);
    } finally {
      if (hidden && !review.window.isDestroyed()) {
        if (this.live(review)) { review.window.show(); review.window.focus(); }
        else review.window.showInactive();
      }
    }
  }

  private async acquire(size: number, interactive: boolean, signal: AbortSignal): Promise<DesktopCapturerSource[]> {
    if (signal.aborted) throw new Error("Screenshot cancelled.");
    if (this.acquisition) throw new Error("The system picker is still open.");
    const acquisition = desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: size, height: size }, fetchWindowIcons: false });
    this.acquisition = acquisition;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    void acquisition.finally(() => { if (this.acquisition === acquisition) this.acquisition = null; }).catch(() => undefined);
    try {
      return await Promise.race([acquisition, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Screenshot cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("Screenshot selection timed out.")), interactive ? 120_000 : 15_000);
      })]);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
  }

  private setImage(review: PendingReview, image: NativeImage): void {
    const { width, height } = image.getSize();
    if (image.isEmpty() || width <= 0 || height <= 0 || width > 2048 || height > 2048) throw new Error("The selected image is unavailable.");
    const png = image.toPNG();
    if (png.length > SNAPSHOT_MAX_IMAGE_BYTES) throw new Error("The selected screenshot is too large.");
    review.timer.refresh();
    review.image = image;
    review.sources.clear();
    review.revision += 1;
    this.send(review, { reviewId: review.id, stage: "image", revision: review.revision, width, height,
      preview: `data:image/png;base64,${png.toString("base64")}` });
  }

  private release(review: PendingReview): void {
    this.send(review, { reviewId: review.id, stage: "closed" });
    review.controller.abort();
    clearTimeout(review.timer);
    review.detach();
    review.image = null;
    review.sources.clear();
    if (this.pending === review) this.pending = null;
  }

  async cancel(document?: AttachmentImportDocument): Promise<void> {
    const review = this.pending;
    if (review && (!document || (review.document.owner === document.owner && review.document.frameToken === document.frameToken
      && review.document.processId === document.processId && review.document.frameId === document.frameId))) {
      this.release(review);
      if (review.batchId) {
        const cleanup = this.options.imports.cancel(review.document, review.batchId);
        this.cleanups.add(cleanup);
        try { await cleanup; } finally { this.cleanups.delete(cleanup); }
      }
    }
    await Promise.all(this.cleanups);
  }

  async stop(): Promise<void> {
    await this.cancel();
    if (!this.acquisition) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.acquisition.catch(() => undefined), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Close the system screenshot picker to finish cleanup.")), 3000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
