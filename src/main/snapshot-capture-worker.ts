import xa11y from "@crowecawcaw/xa11y";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { readSnapshotAccessibility, SnapshotGeometryError } from "./snapshot-accessibility.js";
import {
  SNAPSHOT_MAX_IMAGE_BYTES, SNAPSHOT_MAX_SOURCE_BYTES, snapshotSourceSchema,
  type SnapshotCapturePhase, type SnapshotFailureCategory, type SnapshotRect, type SnapshotSource,
} from "../shared/snapshots.js";
import { readX11Foreground, matchesX11Bounds, SnapshotX11ForegroundError } from "./snapshot-x11-foreground.js";
const { App, screenshot, AccessibilityNotEnabledError, PermissionDeniedError, SelectorNotMatchedError } = xa11y;

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

async function foreground(phase: SnapshotCapturePhase) {
  // Chromium can expose a complete AT-SPI tree without marking its frame ACTIVE.
  // X11 identifies the process; require one exact named AX window in that process.
  // Keep the native window ID in every before/after identity check, including
  // switches between identically titled windows in one application.
  const native = process.platform === "linux" ? readX11Foreground() : null;
  const app = native ? await App.byPid(native.pid, { timeout: 0 }).catch((error: unknown) => {
    if (phase === "foreground" && error instanceof SelectorNotMatchedError) throw new SnapshotCaptureFailure("accessibility-unavailable");
    throw error;
  }) : await App.foreground({ timeout: 0 });
  const candidates = process.platform === "win32" ? [app.asElement()] : await app.children();
  const active = candidates.filter((element) => native ? element.name === native.name && matchesX11Bounds(element.bounds, native.bounds) : element.active);
  if (active.length !== 1 || !app.pid) throw new SnapshotCaptureFailure("no-active-window");
  const window = active[0]!;
  if (!window.bounds) throw new SnapshotCaptureFailure("invalid-geometry");
  return { app, window, identity: JSON.stringify([native, app.pid, window.stableId, window.name, window.bounds]) };
}

function protectedGeometry(rectangles: readonly SnapshotRect[]): string {
  return JSON.stringify(rectangles.map(({ x, y, width, height }) => JSON.stringify([x, y, width, height])).sort());
}

const RETRYABLE: ReadonlySet<SnapshotFailureCategory> = new Set(["accessibility-unavailable", "no-active-window"]);

export async function captureForegroundSnapshot() {
  const retryUntil = Date.now() + 1000;
  for (let attempt = 1; ; attempt += 1) {
    const progress: { phase: SnapshotCapturePhase } = { phase: "foreground" };
    try { return await captureOnce(progress); }
    catch (error) {
      const failure = new SnapshotCaptureFailure(snapshotFailureCategory(error, progress.phase), progress.phase);
      if (attempt === 3 || !RETRYABLE.has(failure.category) || Date.now() > retryUntil) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function captureOnce(progress: { phase: SnapshotCapturePhase }) {
  const { app, window, identity } = await foreground(progress.phase);
  const bounds = window.bounds!;
  if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || bounds.width * bounds.height > 16_000_000) throw new SnapshotCaptureFailure("invalid-geometry");
  progress.phase = "accessibility";
  const deadline = Date.now() + 3000;
  const context = await readSnapshotAccessibility(window, () => Date.now() < deadline);
  // A partial traversal cannot prove where every protected field is. Fail closed.
  if (!context.complete) throw new SnapshotCaptureFailure("incomplete");
  if ((await foreground(progress.phase)).identity !== identity) throw new SnapshotCaptureFailure("changed");
  progress.phase = "screenshot";
  const shot = await screenshot({ element: window });
  if (shot.width * shot.height > 32_000_000 || shot.width <= 0 || shot.height <= 0) throw new SnapshotCaptureFailure("native-failure");
  progress.phase = "verification";
  const after = await foreground(progress.phase);
  if (after.identity !== identity) throw new SnapshotCaptureFailure("changed");
  // A fresh native tree must agree with the masks sampled before pixel capture.
  const verificationDeadline = Date.now() + 3000;
  const verification = await readSnapshotAccessibility(after.window, () => Date.now() < verificationDeadline);
  if (!verification.complete) throw new SnapshotCaptureFailure("incomplete");
  if (protectedGeometry(context.redactions) !== protectedGeometry(verification.redactions)
    || (await foreground(progress.phase)).identity !== identity) throw new SnapshotCaptureFailure("changed");
  progress.phase = "encoding";
  const canvas = createCanvas(shot.width, shot.height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(shot.pixels), shot.width, shot.height), 0, 0);
  ctx.fillStyle = "#242424";
  const scaleX = shot.width / bounds.width;
  const scaleY = shot.height / bounds.height;
  for (const rect of context.redactions) ctx.fillRect(Math.floor((rect.x - bounds.x) * scaleX) - 2, Math.floor((rect.y - bounds.y) * scaleY) - 2, Math.ceil(rect.width * scaleX) + 4, Math.ceil(rect.height * scaleY) + 4);
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
  void captureForegroundSnapshot().then((result) => {
    finish(result);
  }, (error: unknown) => {
    finish(error instanceof SnapshotCaptureFailure ? { ok: false, code: error.category, phase: error.phase } : { ok: false, code: "native-failure" });
  });
});
