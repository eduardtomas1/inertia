import { createCanvas, loadImage } from "@napi-rs/canvas";
import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ foreground: vi.fn(), screenshot: vi.fn() }));
vi.mock("@crowecawcaw/xa11y", () => ({ default: { App: { foreground: native.foreground }, screenshot: native.screenshot } }));
import { captureForegroundSnapshot } from "../../src/main/snapshot-capture-worker";

function foreground(name = "Review window") {
  const window = {
    active: true, stableId: "fixture-window", name, role: "window", value: null, raw: {},
    bounds: { x: 50, y: 50, width: 100, height: 100 },
    children: async () => [{ role: "text_field", name: "Editable note", value: "fixture-masked-text", raw: {}, bounds: { x: 60, y: 60, width: 20, height: 20 }, children: async () => [] }],
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
});
