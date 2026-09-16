import { createCanvas, loadImage } from "@napi-rs/canvas";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotElement } from "../../src/main/snapshot-accessibility";
const native = vi.hoisted(() => {
  class XA11yError extends Error {}
  return { x11: vi.fn(), foreground: vi.fn(), screenshot: vi.fn(), errors: {
    AccessibilityNotEnabledError: class extends XA11yError {}, PermissionDeniedError: class extends XA11yError {},
    SelectorNotMatchedError: class extends XA11yError {}, PlatformError: class extends XA11yError {},
  } };
});
vi.mock("@crowecawcaw/xa11y", () => ({ default: { App: { foreground: native.foreground, byPid: native.foreground }, screenshot: native.screenshot, ...native.errors } }));
vi.mock("../../src/main/snapshot-x11-foreground", () => ({ readX11Foreground: native.x11, matchesX11Bounds: (bounds: unknown) => Boolean(bounds), SnapshotX11ForegroundError: class extends Error {} }));
import { captureForegroundSnapshot, SnapshotCaptureFailure, snapshotFailureCategory } from "../../src/main/snapshot-capture-worker";
import { SnapshotGeometryError } from "../../src/main/snapshot-accessibility";
import type { SnapshotCapturePhase, SnapshotFailureCategory } from "../../src/shared/snapshots";
const { AccessibilityNotEnabledError, PermissionDeniedError, SelectorNotMatchedError, PlatformError } = native.errors;

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
  native.x11.mockReturnValue({ id: 100, pid: 123, name: "Review window" });
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
  it("uses the fresh verified labels, values and truncation state as provider context", async () => {
    const label: SnapshotElement = { role: "static_text", name: "stale context ".repeat(100), value: "stale value", raw: {}, bounds: null, children: async () => [] };
    native.foreground.mockResolvedValueOnce(foreground("Review window", [field(), label])).mockResolvedValueOnce(foreground())
      .mockResolvedValue(foreground("Review window", [field(), { ...label, name: "Updated label", value: "Updated value" }]));
    const result = await captureForegroundSnapshot();
    expect(result.source.accessibility.nodes[2]).toMatchObject({ name: "Updated label", value: "Updated value" });
    expect(result.source.accessibility.truncated).toBe(false);
    expect(JSON.stringify(result.source)).not.toContain("stale");
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

describe("foreground snapshot failure categories", () => {
  it.each([
    [new AccessibilityNotEnabledError("empty tree"), "foreground", "accessibility-unavailable"],
    [new AccessibilityNotEnabledError("empty tree"), "verification", "accessibility-unavailable"],
    [new SelectorNotMatchedError("no foreground app"), "foreground", "no-active-window"],
    [new SelectorNotMatchedError("stale element"), "accessibility", "changed"],
    [new SnapshotCaptureFailure("no-active-window"), "foreground", "no-active-window"],
    [new SnapshotCaptureFailure("no-active-window"), "verification", "changed"],
    [new PermissionDeniedError("denied"), "screenshot", "permission-denied"],
    [new SnapshotGeometryError("A protected field could not be located safely."), "accessibility", "invalid-geometry"],
    [new SnapshotCaptureFailure("invalid-geometry"), "foreground", "invalid-geometry"],
    [new PlatformError("capture failed"), "screenshot", "native-failure"],
    [new Error("raw native detail"), "encoding", "native-failure"],
    ["not an error", "foreground", "native-failure"],
    [new SnapshotCaptureFailure("incomplete"), "accessibility", "incomplete"],
    [new SnapshotCaptureFailure("changed"), "verification", "changed"],
    [new SnapshotCaptureFailure("large"), "encoding", "large"],
  ] as const)("maps %o during %s to %s", (error, phase, category) => {
    expect(snapshotFailureCategory(error, phase as SnapshotCapturePhase)).toBe(category as SnapshotFailureCategory);
  });

  it("reports zero active windows after a bounded retry without taking pixels", async () => {
    const app = foreground();
    const inactive = { ...app.asElement(), active: false, name: "Not the foreground window" };
    native.foreground.mockResolvedValue({ ...app, asElement: () => inactive, children: async () => [inactive] });
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category: "no-active-window", phase: "foreground", message: "no-active-window" });
    expect(native.foreground).toHaveBeenCalledTimes(3);
    expect(native.screenshot).not.toHaveBeenCalled();
  });

  it("reports an empty accessibility tree during traversal without taking pixels", async () => {
    const app = foreground();
    const window = { ...app.asElement(), children: async () => { throw new AccessibilityNotEnabledError("Chromium exposes an empty tree"); } };
    native.foreground.mockResolvedValue({ ...app, asElement: () => window, children: async () => [window] });
    const failure = await captureForegroundSnapshot().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SnapshotCaptureFailure);
    expect(failure).toMatchObject({ category: "accessibility-unavailable", phase: "accessibility" });
    expect(JSON.stringify(failure)).not.toContain("Chromium");
    expect(native.screenshot).not.toHaveBeenCalled();
  });

  it("retries accessibility startup from a fresh foreground identity and keeps masking", async () => {
    native.foreground.mockRejectedValueOnce(new AccessibilityNotEnabledError("not ready")).mockResolvedValue(foreground());
    const result = await captureForegroundSnapshot();
    expect(native.foreground).toHaveBeenCalledTimes(5);
    const canvas = createCanvas(100, 100); const ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(result.png), 0, 0);
    expect([...ctx.getImageData(15, 15, 1, 1).data]).toEqual([36, 36, 36, 255]);
    expect(JSON.stringify(result.source)).not.toContain("fixture-masked-text");
  });

  it("does not retry a retryable category after its pixels were discarded for a changed window", async () => {
    native.foreground.mockResolvedValueOnce(foreground()).mockResolvedValueOnce(foreground()).mockRejectedValue(new SelectorNotMatchedError("gone"));
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category: "changed", phase: "verification" });
    expect(native.screenshot).toHaveBeenCalledOnce();
  });

  it.each([
    ["permission-denied", "foreground", () => { native.foreground.mockRejectedValue(new PermissionDeniedError("denied")); }],
    ["invalid-geometry", "foreground", () => { const flat = { ...foreground().asElement(), bounds: { x: 0, y: 0, width: 0, height: 10 } }; native.foreground.mockResolvedValue({ ...foreground(), asElement: () => flat, children: async () => [flat] }); }],
    ["invalid-geometry", "accessibility", () => { native.foreground.mockResolvedValue(foreground("Review window", [{ ...field(), bounds: null }])); }],
    ["native-failure", "screenshot", () => { native.screenshot.mockRejectedValue(new PlatformError("capture failed")); }],
    ["native-failure", "screenshot", () => { native.screenshot.mockResolvedValue({ width: 0, height: 0, pixels: Buffer.alloc(0) }); }],
  ] as const)("fails closed with %s during %s without retrying", async (category, phase, arrange) => {
    arrange();
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category, phase });
    expect(native.foreground.mock.calls.length).toBeLessThanOrEqual(2);
  });
});


describe.runIf(process.platform === "linux")("X11 foreground identity", () => {
  it("captures one exact named window when Chromium omits AT-SPI ACTIVE", async () => {
    const app = foreground();
    native.foreground.mockResolvedValue({ ...app, children: async () => [{ ...app.asElement(), active: false }] });
    await expect(captureForegroundSnapshot()).resolves.toMatchObject({ ok: true });
    expect(native.foreground).toHaveBeenCalledWith(123, { timeout: 0 });
  });
  it("refuses duplicate named windows rather than guessing which tree masks the pixels", async () => {
    const app = foreground();
    native.foreground.mockResolvedValue({ ...app, children: async () => [app.asElement(), { ...app.asElement(), stableId: "other" }] });
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category: "no-active-window" });
    expect(native.screenshot).not.toHaveBeenCalled();
  });
  it("discards pixels on a same-title same-process native window switch", async () => {
    native.x11.mockReturnValueOnce({ id: 100, pid: 123, name: "Review window" })
      .mockReturnValueOnce({ id: 100, pid: 123, name: "Review window" })
      .mockReturnValue({ id: 101, pid: 123, name: "Review window" });
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category: "changed", phase: "verification" });
    expect(native.screenshot).toHaveBeenCalledOnce();
  });
  it("reports missing AT-SPI access when X11 proves a foreground process exists", async () => {
    native.foreground.mockRejectedValue(new SelectorNotMatchedError("unregistered app"));
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category: "accessibility-unavailable" });
    expect(native.screenshot).not.toHaveBeenCalled();
  });
});
