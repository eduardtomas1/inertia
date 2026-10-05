import xa11y from "@crowecawcaw/xa11y";
import { createCanvas, ImageData, loadImage, type Image } from "@napi-rs/canvas";
import { readSnapshotAccessibility, SnapshotGeometryError } from "./snapshot-accessibility.js";
import { snapshotImageScale, snapshotMaskRect } from "./snapshot-geometry.js";
import { macWindowPixels, type MacWindowTarget } from "./snapshot-macos-window.js";
import {
  SNAPSHOT_MAX_IMAGE_BYTES, SNAPSHOT_MAX_SOURCE_BYTES, snapshotSourceSchema,
  type SnapshotCapturePhase, type SnapshotFailureCategory, type SnapshotRect, type SnapshotSource,
} from "../shared/snapshots.js";
import { readX11Foreground, x11CaptureBounds, SnapshotX11ForegroundError } from "./snapshot-x11-foreground.js";
const { App, screenshot, AccessibilityNotEnabledError, PermissionDeniedError, SelectorNotMatchedError } = xa11y;

export interface SnapshotWindowPixels {
  locate(target: MacWindowTarget): { id: number; frame: SnapshotRect } | null;
  capture(id: number): Promise<Buffer>;
}

export class SnapshotCaptureFailure extends Error {
  constructor(readonly category: SnapshotFailureCategory, readonly phase?: SnapshotCapturePhase) { super(category); }
}

export function snapshotFailureCategory(error: unknown, phase: SnapshotCapturePhase): SnapshotFailureCategory {
  const category = error instanceof SnapshotCaptureFailure ? error.category
    : error instanceof SnapshotGeometryError ? "invalid-geometry"
      : error instanceof AccessibilityNotEnabledError ? "accessibility-unavailable"
        : error instanceof PermissionDeniedError ? "permission-denied"
          : error instanceof SelectorNotMatchedError || error instanceof SnapshotX11ForegroundError ? "no-active-window" : "native-failure";
  return category === "no-active-window" && phase !== "foreground" ? "changed" : category;
}

async function foreground(phase: SnapshotCapturePhase, pixels?: SnapshotWindowPixels) {
  // Chromium can expose a complete AT-SPI tree without marking its frame ACTIVE.
  // X11 identifies the process; require one exact named AX window in that process.
  // Keep the native window ID in every before/after identity check, including
  // switches between identically titled windows in one application.
  const native = process.platform === "linux" ? readX11Foreground() : null;
  const app = native ? await App.byPid(native.pid, { timeout: 0 }).catch((error: unknown) => {
    if (phase === "foreground" && error instanceof SelectorNotMatchedError) throw new SnapshotCaptureFailure("accessibility-unavailable");
    throw error;
  }) : await App.foreground({ timeout: 0 });
  const candidates = await app.children();
  const active = candidates.filter((element) => native ? element.name === native.name && x11CaptureBounds(element.bounds, native) : element.active);
  if (active.length !== 1 || !app.pid) throw new SnapshotCaptureFailure("no-active-window");
  const window = active[0]!;
  if (!window.bounds) throw new SnapshotCaptureFailure("invalid-geometry");
  const region = native ? x11CaptureBounds(window.bounds, native)! : null;
  const located = pixels ? pixels.locate({ pid: app.pid, title: window.name, bounds: window.bounds }) : null;
  if (pixels && !located) throw new SnapshotCaptureFailure("no-active-window");
  return { app, window, region, located, identity: JSON.stringify([native, app.pid, window.stableId, window.name, window.bounds, located]) };
}

function protectedGeometry(rectangles: readonly SnapshotRect[]): string {
  return JSON.stringify(rectangles.map(({ x, y, width, height }) => JSON.stringify([x, y, width, height])).sort());
}

const RETRYABLE: ReadonlySet<SnapshotFailureCategory> = new Set(["accessibility-unavailable", "no-active-window"]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function windowImage(png: Buffer): Promise<Image> {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR"
    || png.readUInt32BE(16) * png.readUInt32BE(20) > 32_000_000) throw new SnapshotCaptureFailure("native-failure");
  return await loadImage(png).catch(() => { throw new SnapshotCaptureFailure("native-failure"); });
}

export async function captureForegroundSnapshot(pixels?: SnapshotWindowPixels) {
  const retryUntil = Date.now() + 1000;
  for (let attempt = 1; ; attempt += 1) {
    const progress: { phase: SnapshotCapturePhase } = { phase: "foreground" };
    try { return await captureOnce(progress, pixels); }
    catch (error) {
      const failure = new SnapshotCaptureFailure(snapshotFailureCategory(error, progress.phase), progress.phase);
      if (attempt === 3 || !RETRYABLE.has(failure.category) || Date.now() > retryUntil) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function captureOnce(progress: { phase: SnapshotCapturePhase }, pixels?: SnapshotWindowPixels) {
  const { app, window, region, located, identity } = await foreground(progress.phase, pixels);
  const bounds = located?.frame ?? region ?? window.bounds!;
  if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || bounds.width * bounds.height > 16_000_000) throw new SnapshotCaptureFailure("invalid-geometry");
  progress.phase = "accessibility";
  const deadline = Date.now() + 3000;
  const context = await readSnapshotAccessibility(window, () => Date.now() < deadline);
  // A partial traversal cannot prove where every protected field is. Fail closed.
  if (!context.complete) throw new SnapshotCaptureFailure("incomplete");
  if ((await foreground(progress.phase, pixels)).identity !== identity) throw new SnapshotCaptureFailure("changed");
  progress.phase = "screenshot";
  const shot = located ? await windowImage(await pixels!.capture(located.id)) : await screenshot(region ? { region } : { element: window });
  if (shot.width * shot.height > 32_000_000 || shot.width <= 0 || shot.height <= 0) throw new SnapshotCaptureFailure("native-failure");
  const imageScale = snapshotImageScale(bounds, shot, located ? 0.02 : Infinity);
  if (!imageScale) throw new SnapshotCaptureFailure("native-failure");
  progress.phase = "verification";
  const after = await foreground(progress.phase, pixels);
  if (after.identity !== identity) throw new SnapshotCaptureFailure("changed");
  // A fresh native tree must agree with the masks sampled before pixel capture.
  const verificationDeadline = Date.now() + 3000;
  const verification = await readSnapshotAccessibility(after.window, () => Date.now() < verificationDeadline);
  if (!verification.complete) throw new SnapshotCaptureFailure("incomplete");
  if (protectedGeometry(context.redactions) !== protectedGeometry(verification.redactions)
    || (await foreground(progress.phase, pixels)).identity !== identity) throw new SnapshotCaptureFailure("changed");
  progress.phase = "encoding";
  const canvas = createCanvas(shot.width, shot.height);
  const ctx = canvas.getContext("2d");
  if ("pixels" in shot) ctx.putImageData(new ImageData(new Uint8ClampedArray(shot.pixels), shot.width, shot.height), 0, 0);
  else ctx.drawImage(shot, 0, 0);
  ctx.fillStyle = "#242424";
  const { x: scaleX, y: scaleY } = imageScale;
  for (const rect of context.redactions) {
    const mask = snapshotMaskRect(rect, bounds, imageScale);
    ctx.fillRect(mask.x, mask.y, mask.width, mask.height);
  }
  const scale = Math.min(1, 2048 / shot.width, 2048 / shot.height);
  const output = createCanvas(Math.max(1, Math.round(shot.width * scale)), Math.max(1, Math.round(shot.height * scale)));
  output.getContext("2d").drawImage(canvas, 0, 0, output.width, output.height);
  const png = output.toBuffer("image/png");
  if (png.length > SNAPSHOT_MAX_IMAGE_BYTES) throw new SnapshotCaptureFailure("large");
  const source: SnapshotSource = {
    appName: app.name.slice(0, 200), windowTitle: (window.name ?? "Captured window").slice(0, 500),
    capturedAt: new Date().toISOString(), width: output.width, height: output.height,
    accessibility: { format: "element-tree", coordinateSpace: "captured-image", truncated: verification.truncated,
      nodes: verification.nodes.map((node) => ({ ...node, ...(node.bounds ? { bounds: {
        x: (node.bounds.x - bounds.x) * scaleX * scale, y: (node.bounds.y - bounds.y) * scaleY * scale,
        width: node.bounds.width * scaleX * scale, height: node.bounds.height * scaleY * scale,
      } } : {}) })),
    },
  };
  while (Buffer.byteLength(JSON.stringify(source), "utf8") > SNAPSHOT_MAX_SOURCE_BYTES && source.accessibility.nodes.length > 0) {
    source.accessibility.nodes.pop(); source.accessibility.truncated = true;
  }
  return { ok: true, png, source: snapshotSourceSchema.parse(source) };
}

const parent = process.parentPort;
// Keep an orphaned worker bounded even if main disappears before sending capture.
if (parent) setTimeout(() => process.exit(1), 12_000);
if (parent) parent.once("message", (event) => {
  if (event.data !== "capture") { process.exit(1); return; }
  const finish = (result: unknown): void => {
    const timer = setTimeout(() => process.exit(1), 3000);
    parent.once("message", (ack) => { clearTimeout(timer); process.exit(ack.data === "received" ? 0 : 1); });
    parent.postMessage(result);
  };
  void captureForegroundSnapshot(process.platform === "darwin" ? macWindowPixels : undefined).then((result) => {
    finish(result);
  }, (error: unknown) => {
    finish(error instanceof SnapshotCaptureFailure ? { ok: false, code: error.category, phase: error.phase } : { ok: false, code: "native-failure" });
  });
});
