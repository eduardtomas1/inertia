import { createCanvas, loadImage } from "@napi-rs/canvas";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotElement } from "../../src/main/snapshot-accessibility";
const native = vi.hoisted(() => ({ foreground: vi.fn(), screenshot: vi.fn() }));
vi.mock("@crowecawcaw/xa11y", () => ({ default: { App: { foreground: native.foreground }, screenshot: native.screenshot } }));
import { captureForegroundSnapshot } from "../../src/main/snapshot-capture-worker";

function field(bounds = { x: 60, y: 60, width: 20, height: 20 }): SnapshotElement {
  return { role: "text_field", name: "Editable note", value: "fixture-masked-text", raw: {}, bounds, children: async () => [] };
}
function foreground(name = "Review window", fields: SnapshotElement[] = [field()]) {
  const window = {
    active: true, stableId: "fixture-window", name, role: "window", value: null, raw: {},
    bounds: { x: 50, y: 50, width: 100, height: 100 },
    children: async () => fields,
  };
  return { pid: 123, name: "Fixture", asElement: () => window, children: async () => [window] };
}
beforeEach(() => {
  vi.resetAllMocks();
  native.foreground.mockResolvedValue(foreground());
  native.screenshot.mockResolvedValue({ width: 100, height: 100, pixels: Buffer.alloc(100 * 100 * 4, 255) });
});
describe("foreground snapshot pixels and context", () => {
  it("masks editable pixels and accessibility text before returning the PNG", async () => {
    const result = await captureForegroundSnapshot();
    expect(JSON.stringify(result.source)).not.toContain("fixture-masked-text");
    expect(result.source.accessibility.nodes[1]).toMatchObject({ redacted: true, bounds: { x: 10, y: 10, width: 20, height: 20 } });
    const canvas = createCanvas(100, 100); const ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(result.png), 0, 0);
    expect([...ctx.getImageData(15, 15, 1, 1).data]).toEqual([36, 36, 36, 255]);
    expect([...ctx.getImageData(80, 80, 1, 1).data]).toEqual([255, 255, 255, 255]);
  });
  it("refuses capture when the foreground identity changes during traversal", async () => {
    native.foreground.mockResolvedValueOnce(foreground()).mockResolvedValue(foreground("Other window"));
    await expect(captureForegroundSnapshot()).rejects.toThrow("changed");
    expect(native.screenshot).not.toHaveBeenCalled();
  });
  it("discards pixels when the foreground changes while the screenshot is taken", async () => {
    native.foreground.mockResolvedValueOnce(foreground()).mockResolvedValueOnce(foreground()).mockResolvedValue(foreground("Other window"));
    await expect(captureForegroundSnapshot()).rejects.toThrow("changed");
    expect(native.screenshot).toHaveBeenCalledOnce();
  });
  it.each([
    ["moves", [field({ x: 80, y: 60, width: 20, height: 20 })]],
    ["resizes", [field({ x: 60, y: 60, width: 30, height: 20 })]],
    ["appears", [field(), field({ x: 80, y: 80, width: 10, height: 10 })]],
    ["disappears", []],
  ] as const)("discards pixels when a protected field %s while the screenshot is taken", async (_change, fields) => {
    native.foreground.mockResolvedValueOnce(foreground()).mockResolvedValueOnce(foreground())
      .mockResolvedValue(foreground("Review window", [...fields]));
    await expect(captureForegroundSnapshot()).rejects.toThrow("changed");
    expect(native.screenshot).toHaveBeenCalledOnce();
  });
  it("accepts unchanged masks even when a fresh tree enumerates them in a different order", async () => {
    const fields = [field(), field({ x: 80, y: 80, width: 10, height: 10 })];
    native.foreground.mockResolvedValueOnce(foreground("Review window", fields)).mockResolvedValueOnce(foreground("Review window", fields))
      .mockResolvedValue(foreground("Review window", fields.toReversed()));
    await expect(captureForegroundSnapshot()).resolves.toMatchObject({ ok: true });
    expect(native.foreground).toHaveBeenCalledTimes(4);
  });
  it("refuses an incomplete fresh accessibility scan after pixel capture", async () => {
    let nested: SnapshotElement = field();
    for (let depth = 0; depth < 18; depth++) {
      const child = nested;
      nested = { role: "group", name: null, value: null, raw: {}, bounds: null, children: async () => [child] };
    }
    native.foreground.mockResolvedValueOnce(foreground()).mockResolvedValueOnce(foreground())
      .mockResolvedValue(foreground("Review window", [nested]));
    await expect(captureForegroundSnapshot()).rejects.toThrow("incomplete");
    expect(native.screenshot).toHaveBeenCalledOnce();
  });
  it("rejects a foreground change during the verification scan", async () => {
    native.foreground.mockResolvedValueOnce(foreground()).mockResolvedValueOnce(foreground())
      .mockResolvedValueOnce(foreground()).mockResolvedValue(foreground("Other window"));
    await expect(captureForegroundSnapshot()).rejects.toThrow("changed");
  });
  it("exits an orphaned utility worker without waiting indefinitely for its parent", async () => {
    const prior = Object.getOwnPropertyDescriptor(process, "parentPort");
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    Object.defineProperty(process, "parentPort", { configurable: true, value: new EventEmitter() });
    try {
      vi.resetModules(); await import("../../src/main/snapshot-capture-worker");
      await vi.advanceTimersByTimeAsync(11_999); expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(exit).toHaveBeenCalledWith(1);
      expect(native.foreground).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore(); vi.useRealTimers();
      if (prior) Object.defineProperty(process, "parentPort", prior);
      else Reflect.deleteProperty(process, "parentPort");
    }
  });
});
