import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";

import { captureMaskedWindow } from "../../src/main/app-control-capture";
import { parseAppControlWorkerResponse } from "../../src/main/app-control-worker-protocol";

const bounds = { x: 50, y: 50, width: 200, height: 100 };

async function pixel(png: Buffer, x: number, y: number): Promise<number[]> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return [...context.getImageData(x, y, 1, 1).data];
}

describe("App control window capture", () => {
  it("masks protected fields in an X11 region capture and says overlapping windows may show", async () => {
    const regionScreenshot = vi.fn(async () => ({ width: 200, height: 100, pixels: Buffer.alloc(200 * 100 * 4, 255) }));
    const capture = await captureMaskedWindow({ pid: 10, title: "Main", bounds }, [{ x: 60, y: 60, width: 20, height: 20 }], {
      platform: "linux", env: { DISPLAY: ":0" }, regionScreenshot,
    });
    expect(regionScreenshot).toHaveBeenCalledWith(bounds);
    expect(capture).toMatchObject({ width: 200, height: 100, mayIncludeOverlappingWindows: true });
    expect(await pixel(capture.png, 15, 15)).toEqual([36, 36, 36, 255]);
    expect(await pixel(capture.png, 150, 80)).toEqual([255, 255, 255, 255]);
  });

  it("reduces large captures before they leave the worker", async () => {
    const capture = await captureMaskedWindow({ pid: 10, title: "Main", bounds: { x: 0, y: 0, width: 2_000, height: 1_000 } }, [], {
      platform: "win32", env: {}, regionScreenshot: async () => ({ width: 2_000, height: 1_000, pixels: Buffer.alloc(2_000 * 1_000 * 4, 128) }),
    });
    expect(capture.width).toBeLessThanOrEqual(1_024);
    expect(capture.height).toBeLessThanOrEqual(640);
  });

  it("captures exactly the macOS window through the Snapshots screencapture path", async () => {
    const source = createCanvas(400, 200);
    source.getContext("2d").fillStyle = "#ffffff";
    source.getContext("2d").fillRect(0, 0, 400, 200);
    const macPixels = { locate: vi.fn(() => ({ id: 77, frame: bounds })), capture: vi.fn(async () => source.toBuffer("image/png")) };
    const regionScreenshot = vi.fn();
    const capture = await captureMaskedWindow({ pid: 10, title: "Main", bounds }, [{ x: 60, y: 60, width: 20, height: 20 }], {
      platform: "darwin", env: {}, regionScreenshot, macPixels,
    });
    expect(macPixels.locate).toHaveBeenCalledWith({ pid: 10, title: "Main", bounds });
    expect(macPixels.capture).toHaveBeenCalledWith(77);
    expect(regionScreenshot).not.toHaveBeenCalled();
    expect(capture.mayIncludeOverlappingWindows).toBe(false);
    // A Retina image maps masks at two pixels per point.
    expect(await pixel(capture.png, 30, 30)).toEqual([36, 36, 36, 255]);
    macPixels.locate.mockReturnValueOnce(null as never);
    await expect(captureMaskedWindow({ pid: 10, title: "Main", bounds }, [], { platform: "darwin", env: {}, regionScreenshot, macPixels }))
      .rejects.toMatchObject({ code: "native-failure" });
  });

  it("has no capture path on Wayland and refuses malformed pixels", async () => {
    const regionScreenshot = vi.fn(async () => ({ width: 10, height: 10, pixels: Buffer.alloc(3) }));
    await expect(captureMaskedWindow({ pid: 10, title: null, bounds }, [], { platform: "linux", env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, regionScreenshot }))
      .rejects.toMatchObject({ code: "unsupported", reason: "wayland" });
    expect(regionScreenshot).not.toHaveBeenCalled();
    await expect(captureMaskedWindow({ pid: 10, title: null, bounds }, [], { platform: "linux", env: { DISPLAY: ":0" }, regionScreenshot }))
      .rejects.toMatchObject({ code: "native-failure" });
  });
});

describe("App control worker responses", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 30 }, () => 0)]);

  it("accepts only an answer to the request it was sent", () => {
    const answer = { id: 3, result: { ok: true, value: { kind: "perform", rootKey: null, windowClosed: false } } };
    expect(parseAppControlWorkerResponse(answer, 3, "perform")).toEqual(answer.result);
    expect(parseAppControlWorkerResponse(answer, 4, "perform")).toBeNull();
    expect(parseAppControlWorkerResponse(answer, 3, "snapshot")).toBeNull();
    expect(parseAppControlWorkerResponse({ ...answer, extra: 1 }, 3, "perform")).toBeNull();
  });

  it("lets a masked capture exceed the thumbnail bound before main reduces it, up to 8 MiB", () => {
    const shot = (bytes: Uint8Array) => ({ id: 1, result: { ok: true, value: { kind: "screenshot", png: bytes, width: 1_024, height: 640, mayIncludeOverlappingWindows: true } } });
    expect(parseAppControlWorkerResponse(shot(new Uint8Array([...png, ...new Uint8Array(1_000_000)])), 1, "screenshot")).toMatchObject({ ok: true });
    expect(parseAppControlWorkerResponse(shot(new Uint8Array(9 * 1024 * 1024)), 1, "screenshot")).toBeNull();
    expect(parseAppControlWorkerResponse(shot(new Uint8Array(40)), 1, "screenshot")).toBeNull();
  });

  it("validates the Windows process table", () => {
    const tree = (entries: unknown[]) => ({ id: 2, result: { ok: true, value: { kind: "tree", entries } } });
    expect(parseAppControlWorkerResponse(tree([{ pid: 1, parentPid: 0, startedAtMs: null, executable: "a.exe" }]), 2, "tree")).toMatchObject({ ok: true });
    expect(parseAppControlWorkerResponse(tree([{ pid: -1, parentPid: 0, startedAtMs: null, executable: null }]), 2, "tree")).toBeNull();
    expect(parseAppControlWorkerResponse({ id: 2, result: { ok: false, code: "native-failure", reason: null, dispatched: false } }, 2, "tree"))
      .toMatchObject({ ok: false, code: "native-failure" });
  });
});
