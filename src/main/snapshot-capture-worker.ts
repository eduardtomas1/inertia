import xa11y from "@crowecawcaw/xa11y";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { readSnapshotAccessibility } from "./snapshot-accessibility.js";
import { SNAPSHOT_MAX_IMAGE_BYTES, SNAPSHOT_MAX_SOURCE_BYTES, snapshotSourceSchema, type SnapshotSource } from "../shared/snapshots.js";
const { App, screenshot } = xa11y;

async function foreground() {
  const app = await App.foreground({ timeout: 0 });
  const candidates = process.platform === "win32" ? [app.asElement()] : await app.children();
  const active = candidates.filter((element) => element.active);
  const window = active.length === 1 ? active[0] : undefined;
  if (!window?.bounds || !app.pid) throw new Error("unavailable");
  return { app, window, identity: JSON.stringify([app.pid, window.stableId, window.name, window.bounds]) };
}

export async function captureForegroundSnapshot() {
  const { app, window, identity } = await foreground();
  const bounds = window.bounds!;
  if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || bounds.width * bounds.height > 16_000_000) throw new Error("unavailable");
  const deadline = Date.now() + 3000;
  const context = await readSnapshotAccessibility(window, () => Date.now() < deadline);
  // A partial traversal cannot prove where every protected field is. Fail closed.
  if (!context.complete) throw new Error("incomplete");
  if ((await foreground()).identity !== identity) throw new Error("changed");
  const shot = await screenshot({ element: window });
  if (shot.width * shot.height > 32_000_000 || shot.width <= 0 || shot.height <= 0) throw new Error("unavailable");
  if ((await foreground()).identity !== identity) throw new Error("changed");
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
  if (png.length > SNAPSHOT_MAX_IMAGE_BYTES) throw new Error("large");
  const source: SnapshotSource = {
    appName: app.name.slice(0, 200), windowTitle: (window.name ?? "Captured window").slice(0, 500),
    capturedAt: new Date().toISOString(), width: output.width, height: output.height,
    accessibility: { format: "element-tree", coordinateSpace: "captured-image", truncated: context.truncated,
      nodes: context.nodes.map((node) => ({ ...node, ...(node.bounds ? { bounds: {
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
    const code = error instanceof Error && ["incomplete", "changed", "large"].includes(error.message) ? error.message : "unavailable";
    finish({ ok: false, code });
  });
});
