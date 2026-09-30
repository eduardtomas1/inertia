import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeImage, BrowserWindow } from "electron";
import { snapshotReviewRequestSchemas, reviewedSnapshotBackend } from "../../src/shared/snapshot-review";
import type { SnapshotDelivery } from "../../src/shared/snapshots";
import type { AttachmentImportDocument, RendererAttachmentImportCoordinator } from "../../src/main/attachment-import-ipc";
import type { AttachmentRegistry } from "../../src/main/attachment-registry";
const native = vi.hoisted(() => ({ sources: vi.fn(), bitmap: vi.fn() }));
vi.mock("electron", () => ({ desktopCapturer: { getSources: native.sources }, nativeImage: { createFromBitmap: native.bitmap } }));
import { editReviewedImage, SnapshotReviewService } from "../../src/main/snapshot-review";

function image(width = 10, height = 10, byte = 255): NativeImage {
  return { getSize: () => ({ width, height }), isEmpty: () => false,
    toPNG: () => Buffer.alloc(width * height, byte), toBitmap: () => Buffer.alloc(width * height * 4, byte),
    crop: ({ width: w, height: h }: { width: number; height: number }) => image(w, h),
  } as unknown as NativeImage;
}
const source = (id = "window:1:0", thumbnail = image()) => ({ id, name: "Private window title", thumbnail });
const services: SnapshotReviewService[] = [];
beforeEach(() => { vi.stubEnv("DISPLAY", ":1"); vi.stubEnv("XDG_SESSION_TYPE", "x11"); vi.stubEnv("WAYLAND_DISPLAY", ""); });
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

function fixture() {
  const send = vi.fn();
  const webContents = Object.assign(new EventEmitter(), { send, isDestroyed: () => false, mainFrame: { processId: 1, routingId: 2, frameToken: "frame" } });
  const owner = { window: { webContents, isVisible: () => false, hide: vi.fn(), show: vi.fn(), showInactive: vi.fn(), focus: vi.fn(), isDestroyed: () => false } as unknown as BrowserWindow,
    document: { owner: webContents, processId: 1, frameId: 2, frameToken: "frame" } as AttachmentImportDocument,
    conversationId: "11111111-1111-4111-8111-111111111111" };
  const imports = { begin: vi.fn(() => "batch"), importSelection: vi.fn(async (_doc, _id, run) => await run(new AbortController().signal)), cancel: vi.fn(async () => undefined) };
  const registry = { import: vi.fn(async () => [{ id: "attachment" }]) };
  const onFailure = vi.fn();
  const service = new SnapshotReviewService({ imports: imports as unknown as RendererAttachmentImportCoordinator, registry: () => registry as unknown as AttachmentRegistry, onFailure });
  services.push(service);
  const reviewId = "22222222-2222-4222-8222-222222222222";
  const last = () => (send.mock.calls.at(-1)![1] as SnapshotDelivery).review!;
  const start = () => service.request(owner, { type: "review-start", reviewId, conversationId: owner.conversationId });
  const select = async () => {
    const state = last(); if (state.stage !== "sources") throw new Error("Expected picker");
    await service.request(owner, { type: "review-select", reviewId, sourceId: state.sources[0]!.id });
  };
  return { service, owner, imports, registry, reviewId, send, last, start, select, onFailure };
}

describe("reviewed screenshot ownership", () => {
  let platform: PropertyDescriptor;
  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  });
  afterEach(() => { Object.defineProperty(process, "platform", platform); });

  it("requires source selection and exact revision approval before importing, without AX metadata", async () => {
    native.sources.mockResolvedValue([source()]);
    const f = fixture(); await f.start();
    expect(f.imports.begin).not.toHaveBeenCalled();
    const choices = f.last(); expect(choices.stage).toBe("sources");
    if (choices.stage === "sources") expect(choices.sources[0]!.id).not.toContain("window:");
    await f.select(); expect(f.last()).toMatchObject({ stage: "image", revision: 1 });
    expect(f.registry.import).not.toHaveBeenCalled();
    await f.service.request(f.owner, { type: "review-approve", reviewId: f.reviewId, revision: 1 });
    expect(f.registry.import).toHaveBeenCalledWith([{ name: "reviewed-screenshot.png", mimeType: "image/png", data: image().toPNG() }], expect.any(AbortSignal));
    expect(f.send.mock.calls.map((call) => call[1])).toContainEqual({ conversationId: f.owner.conversationId, selection: { batchId: "batch", attachments: [{ id: "attachment" }] } });
    expect(f.last()).toMatchObject({ stage: "closed" });
  });

  it("uses the single Wayland system selection once and requires review", async () => {
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-0"); native.sources.mockResolvedValue([source()]);
    const f = fixture(); await f.start();
    expect(native.sources).toHaveBeenCalledExactlyOnceWith({ types: ["window", "screen"], thumbnailSize: { width: 2048, height: 2048 }, fetchWindowIcons: false });
    expect(f.last()).toMatchObject({ stage: "image" }); expect(f.imports.begin).not.toHaveBeenCalled();
  });

  it.each(["denial", "cancel", "multiple"])("does not fall back after a Wayland %s result", async (result) => {
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
    if (result === "denial") native.sources.mockRejectedValue(new Error("private platform error"));
    else native.sources.mockResolvedValue(result === "cancel" ? [] : [source(), source("window:2:0")]);
    const f = fixture(); await f.start();
    expect(native.sources).toHaveBeenCalledOnce(); expect(f.imports.begin).not.toHaveBeenCalled();
    expect(JSON.stringify(f.send.mock.calls)).not.toContain("private platform error");
    expect(f.send.mock.calls.some((call) => call[1].review?.message?.includes("Nothing was attached"))).toBe(true);
  });

  it.each(["cancel", "navigation", "destroyed", "replacement", "disable"])("discards late pixels after %s and blocks a second native picker", async (reason) => {
    let finish!: (value: unknown[]) => void;
    native.sources.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const f = fixture(); const pending = f.start();
    if (reason === "navigation") f.owner.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    else if (reason === "destroyed") f.owner.window.webContents.emit("destroyed");
    else if (reason === "replacement") Object.assign(f.owner.window.webContents.mainFrame, { frameToken: "replacement" });
    else if (reason === "disable") {
      vi.useFakeTimers(); const stop = f.service.stop(); const failure = expect(stop).rejects.toThrow("Close the system screenshot picker");
      await vi.advanceTimersByTimeAsync(3000); await failure;
    } else await f.service.cancel();
    if (reason !== "replacement") await expect(f.start()).rejects.toThrow("current system screenshot picker");
    finish([source()]); await pending;
    expect(f.imports.begin).not.toHaveBeenCalled();
    expect(f.send.mock.calls.every((call) => call[1].review.stage === "closed")).toBe(true);
  });

  it("hides the review window for system selection and restores it without focus after cancellation", async () => {
    vi.useFakeTimers(); vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
    let finish!: (value: unknown[]) => void;
    native.sources.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const f = fixture(); vi.spyOn(f.owner.window, "isVisible").mockReturnValue(true);
    const pending = f.start(); expect(f.owner.window.hide).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(150); await f.service.cancel(); await pending;
    expect(f.owner.window.showInactive).toHaveBeenCalledOnce(); expect(f.owner.window.focus).not.toHaveBeenCalled();
    await expect(f.start()).rejects.toThrow("current system screenshot picker");
    finish([]); await Promise.resolve();
  });

  it("keeps the user selection deadline separate from review expiry", async () => {
    vi.useFakeTimers(); vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
    let finish!: (value: unknown[]) => void; native.sources.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const f = fixture(); const pending = f.start(); await vi.advanceTimersByTimeAsync(15_000);
    expect(f.send).not.toHaveBeenCalled(); finish([source()]); await pending;
    expect(f.last()).toMatchObject({ stage: "image" });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.last()).toMatchObject({ stage: "closed" }); expect(f.registry.import).not.toHaveBeenCalled();
  });

  it.each(["chat", "document", "window"])("refuses approval from a different %s", async (changed) => {
    native.sources.mockResolvedValue([source()]); const f = fixture(); await f.start(); await f.select();
    const owner = { ...f.owner, document: { ...f.owner.document } };
    if (changed === "chat") owner.conversationId = "another-chat";
    if (changed === "document") owner.document = { ...owner.document, frameToken: "another-frame" };
    if (changed === "window") owner.document = { ...owner.document, owner: new EventEmitter() as never };
    await expect(f.service.request(owner, { type: "review-approve", reviewId: f.reviewId, revision: 1 })).rejects.toThrow("no longer available");
    expect(f.imports.begin).not.toHaveBeenCalled();
  });

  it("releases review state even if renderer delivery throws during cancellation", async () => {
    native.sources.mockResolvedValue([source()]); const f = fixture(); await f.start(); await f.select();
    f.send.mockImplementation(() => { throw new Error("Renderer transport closed"); });
    await expect(f.service.cancel()).resolves.toBeUndefined();
    f.send.mockReset(); await f.start(); expect(f.last()).toMatchObject({ stage: "sources" });
    expect(f.imports.begin).not.toHaveBeenCalled();
  });

  it("requires approval of the edited image and refuses a stale revision", async () => {
    native.sources.mockResolvedValue([source()]); const f = fixture(); await f.start(); await f.select();
    await f.service.request(f.owner, { type: "review-edit", reviewId: f.reviewId, revision: 1, operation: "crop", area: { x: 2, y: 2, width: 4, height: 4 } });
    expect(f.last()).toMatchObject({ stage: "image", revision: 2, width: 4, height: 4 });
    await f.service.request(f.owner, { type: "review-approve", reviewId: f.reviewId, revision: 1 });
    expect(f.imports.begin).not.toHaveBeenCalled();
  });

  it("rolls back a late import after the review is cancelled", async () => {
    native.sources.mockResolvedValue([source()]); const f = fixture(); await f.start(); await f.select();
    let finish!: () => void;
    f.registry.import.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return [{ id: "attachment" }]; });
    const approved = f.service.request(f.owner, { type: "review-approve", reviewId: f.reviewId, revision: 1 });
    await f.service.cancel(); finish(); await approved;
    expect(f.imports.cancel).toHaveBeenCalledWith(f.owner.document, "batch");
    expect(f.send.mock.calls.some((call) => call[1].selection)).toBe(false);
  });
});

it("masks every selected pixel opaquely and leaves other pixels unchanged", () => {
  editReviewedImage(image(4, 4), "mask", { x: 1, y: 1, width: 2, height: 2 });
  const pixels = native.bitmap.mock.calls[0]![0] as Buffer;
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) {
    expect([...pixels.subarray((y * 4 + x) * 4, (y * 4 + x + 1) * 4)]).toEqual(x >= 1 && x <= 2 && y >= 1 && y <= 2 ? [36, 36, 36, 255] : [255, 255, 255, 255]);
  }
  expect(() => editReviewedImage(image(), "crop", { x: 8, y: 0, width: 5, height: 5 })).toThrow("inside the image");
});
it("validates edit bounds and platform capabilities", () => {
  const edit = snapshotReviewRequestSchemas[2];
  expect(edit.safeParse({ type: "review-edit", reviewId: "22222222-2222-4222-8222-222222222222", revision: 0, operation: "mask", area: { x: -1, y: 0, width: 10, height: 10 } }).success).toBe(false);
  expect(reviewedSnapshotBackend("linux", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" })).toBe("system-picker");
  expect(reviewedSnapshotBackend("linux", { DISPLAY: ":0" })).toBe("window-picker");
  expect(reviewedSnapshotBackend("linux", {})).toBeNull();
  expect(reviewedSnapshotBackend("darwin", {})).toBeNull();
});
