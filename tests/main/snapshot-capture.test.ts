import { createCanvas, loadImage } from "@napi-rs/canvas";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotElement } from "../../src/main/snapshot-accessibility";
const native = vi.hoisted(() => {
  class XA11yError extends Error {}
  return { x11: vi.fn(), foreground: vi.fn(), screenshot: vi.fn(), errors: {
    AccessibilityNotEnabledError: class extends XA11yError {}, PermissionDeniedError: class extends XA11yError {},
    SelectorNotMatchedError: class extends XA11yError {}, PlatformError: class extends XA11yError {},
  } };
});
vi.mock("@crowecawcaw/xa11y", () => ({ default: { App: { foreground: native.foreground, byPid: native.foreground }, screenshot: native.screenshot, ...native.errors } }));
vi.mock("../../src/main/snapshot-x11-foreground", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/snapshot-x11-foreground")>(), readX11Foreground: native.x11,
}));
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
const nativeBounds = { x: 50, y: 50, width: 100, height: 100 };
beforeEach(() => {
  vi.resetAllMocks();
  native.x11.mockReturnValue({ id: 100, pid: 123, name: "Review window", bounds: nativeBounds, frameBounds: nativeBounds });
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
    const listeners = { exit: process.listeners("exit"), term: process.listeners("SIGTERM") };
    try {
      vi.resetModules(); await import("../../src/main/snapshot-capture-worker");
      await vi.advanceTimersByTimeAsync(11_999); expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(exit).toHaveBeenCalledWith(1);
      expect(native.foreground).not.toHaveBeenCalled();
    } finally {
      for (const listener of process.listeners("exit")) if (!listeners.exit.includes(listener)) process.removeListener("exit", listener);
      for (const listener of process.listeners("SIGTERM")) if (!listeners.term.includes(listener)) process.removeListener("SIGTERM", listener);
      exit.mockRestore(); vi.useRealTimers();
      if (prior) Object.defineProperty(process, "parentPort", prior);
      else Reflect.deleteProperty(process, "parentPort");
    }
  });
});

describe("capture worker lifetime", () => {
  it("stops a running window capture when the worker exits or is terminated, and refuses a capture without its folder", async () => {
    const prior = Object.getOwnPropertyDescriptor(process, "parentPort");
    const stop = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const parent = new EventEmitter();
    const before = { exit: process.listeners("exit"), term: process.listeners("SIGTERM") };
    vi.useFakeTimers();
    Object.defineProperty(process, "parentPort", { configurable: true, value: parent });
    try {
      vi.resetModules();
      vi.doMock("../../src/main/snapshot-macos-window", async (original) => ({ ...await original<typeof import("../../src/main/snapshot-macos-window")>(), stopMacWindowCaptures: stop }));
      await import("../../src/main/snapshot-capture-worker");
      expect(process.listeners("exit")).toContain(stop);
      const terminate = process.listeners("SIGTERM").find((listener) => !before.term.includes(listener));
      terminate?.("SIGTERM");
      expect(exit).toHaveBeenCalledWith(1);
      exit.mockClear();
      parent.emit("message", { data: "capture" });
      expect(exit).toHaveBeenCalledWith(1);
      expect(native.foreground).not.toHaveBeenCalled();
    } finally {
      for (const listener of process.listeners("exit")) if (!before.exit.includes(listener)) process.removeListener("exit", listener);
      for (const listener of process.listeners("SIGTERM")) if (!before.term.includes(listener)) process.removeListener("SIGTERM", listener);
      vi.doUnmock("../../src/main/snapshot-macos-window");
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
    ["invalid-geometry", "accessibility", () => { native.foreground.mockResolvedValue(foreground("Review window", [{ ...field(), bounds: null }])); }],
    ["native-failure", "screenshot", () => { native.screenshot.mockRejectedValue(new PlatformError("capture failed")); }],
    ["native-failure", "screenshot", () => { native.screenshot.mockResolvedValue({ width: 0, height: 0, pixels: Buffer.alloc(0) }); }],
  ] as const)("fails closed with %s during %s without retrying", async (category, phase, arrange) => {
    arrange();
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category, phase });
    expect(native.foreground.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("refuses invalid foreground geometry before taking pixels", async () => {
    const flat = { ...foreground().asElement(), bounds: { x: 0, y: 0, width: 0, height: 10 } };
    native.foreground.mockResolvedValue({ ...foreground(), asElement: () => flat, children: async () => [flat] });
    const category = process.platform === "linux" ? "no-active-window" : "invalid-geometry";
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category, phase: "foreground" });
    expect(native.foreground).toHaveBeenCalledTimes(process.platform === "linux" ? 3 : 1);
    expect(native.screenshot).not.toHaveBeenCalled();
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
    const window = { pid: 123, name: "Review window", bounds: nativeBounds, frameBounds: nativeBounds };
    native.x11.mockReturnValueOnce({ ...window, id: 100 })
      .mockReturnValueOnce({ ...window, id: 100 })
      .mockReturnValue({ ...window, id: 101 });
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category: "changed", phase: "verification" });
    expect(native.screenshot).toHaveBeenCalledOnce();
  });
  it("masks the client region when xa11y returns decorated frame bounds", async () => {
    const frameBounds = { x: 49, y: 30, width: 102, height: 125 };
    const app = foreground();
    native.x11.mockReturnValue({ id: 100, pid: 123, name: "Review window", bounds: nativeBounds, frameBounds });
    native.foreground.mockResolvedValue({ ...app, children: async () => [{ ...app.asElement(), bounds: frameBounds }] });
    const result = await captureForegroundSnapshot();
    expect(native.screenshot).toHaveBeenCalledExactlyOnceWith({ region: nativeBounds });
    expect(result.source).toMatchObject({ width: 100, height: 100 });
    expect(result.source.accessibility.nodes[1]).toMatchObject({ redacted: true, bounds: { x: 10, y: 10, width: 20, height: 20 } });
    const canvas = createCanvas(100, 100), ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(result.png), 0, 0);
    expect([...ctx.getImageData(15, 15, 1, 1).data]).toEqual([36, 36, 36, 255]);
  });
  it("reports missing AT-SPI access when X11 proves a foreground process exists", async () => {
    native.foreground.mockRejectedValue(new SelectorNotMatchedError("unregistered app"));
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category: "accessibility-unavailable" });
    expect(native.screenshot).not.toHaveBeenCalled();
  });
});


describe("Windows application roots", () => {
  let platform: PropertyDescriptor;
  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  });
  afterEach(() => { Object.defineProperty(process, "platform", platform); });

  it("captures the unique active modal below the synthetic application root", async () => {
    const app = foreground();
    const main = { ...app.asElement(), active: false };
    const modal = { ...app.asElement(), name: "Active modal", stableId: "modal-window", role: "dialog" };
    native.foreground.mockResolvedValue({ ...app,
      asElement: () => ({ ...main, role: "application", bounds: null }),
      children: async () => [main, modal],
    });
    const result = await captureForegroundSnapshot();
    expect(result.source.windowTitle).toBe("Active modal");
    expect(native.screenshot).toHaveBeenCalledExactlyOnceWith({ element: modal });
    expect(native.x11).not.toHaveBeenCalled();
  });

  it("refuses a process with two active windows", async () => {
    const app = foreground();
    native.foreground.mockResolvedValue({ ...app,
      asElement: () => ({ ...app.asElement(), role: "application", active: false, bounds: null }),
      children: async () => [0, 1].map((index) => ({ ...app.asElement(), stableId: `window-${index}` })),
    });
    await expect(captureForegroundSnapshot()).rejects.toMatchObject({ category: "no-active-window", phase: "foreground" });
    expect(native.foreground).toHaveBeenCalledTimes(3);
    expect(native.screenshot).not.toHaveBeenCalled();
  });
});

describe("window-only pixels", () => {
  const frame = { x: 50, y: 50, width: 100, height: 100 };
  function windowPng(width: number, height: number): Buffer {
    const canvas = createCanvas(width, height); const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
    return canvas.toBuffer("image/png");
  }
  function pixels(png = windowPng(200, 200), ids: number[] = [77]) {
    let call = 0;
    return {
      locate: vi.fn(() => ({ id: ids[Math.min(call++, ids.length - 1)]!, frame })),
      capture: vi.fn(async () => png),
    };
  }

  it("captures only the matched window and maps masks onto its Retina image", async () => {
    const source = pixels();
    const result = await captureForegroundSnapshot(source);
    expect(native.screenshot).not.toHaveBeenCalled();
    expect(source.capture).toHaveBeenCalledExactlyOnceWith(77);
    expect(source.locate).toHaveBeenCalledWith({ pid: 123, title: "Review window", bounds: frame });
    expect(result.source).toMatchObject({ width: 200, height: 200 });
    expect(result.source.accessibility.nodes[1]).toMatchObject({ redacted: true, bounds: { x: 20, y: 20, width: 40, height: 40 } });
    const canvas = createCanvas(200, 200); const ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(result.png), 0, 0);
    for (const [x, y] of [[20, 20], [59, 59], [18, 18], [61, 61]]) expect([...ctx.getImageData(x!, y!, 1, 1).data]).toEqual([36, 36, 36, 255]);
    expect([...ctx.getImageData(70, 70, 1, 1).data]).toEqual([255, 255, 255, 255]);
  });

  it("fails closed without pixels when no single window matches the accessibility window", async () => {
    const source = { locate: vi.fn(() => null), capture: vi.fn() };
    await expect(captureForegroundSnapshot(source)).rejects.toMatchObject({ category: "no-active-window", phase: "foreground" });
    expect(source.capture).not.toHaveBeenCalled();
    expect(native.screenshot).not.toHaveBeenCalled();
  });

  it("discards pixels when a different window matches after capture", async () => {
    const source = pixels(windowPng(200, 200), [77, 77, 78]);
    await expect(captureForegroundSnapshot(source)).rejects.toMatchObject({ category: "changed", phase: "verification" });
    expect(source.capture).toHaveBeenCalledOnce();
  });

  it.each([
    ["a stretched image", windowPng(200, 150)],
    ["an image that is not a PNG", Buffer.from("not a png image at all, only text")],
  ])("refuses %s rather than guessing where masks belong", async (_case, png) => {
    await expect(captureForegroundSnapshot(pixels(png))).rejects.toMatchObject({ category: "native-failure", phase: "screenshot" });
  });
});
