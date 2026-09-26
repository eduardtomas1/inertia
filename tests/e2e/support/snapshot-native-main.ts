import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, BrowserWindow } from "electron";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { SnapshotService } from "../../../src/main/snapshot-service";

app.disableHardwareAcceleration();
const negative = process.argv.includes("--negative");
const runFile = promisify(execFile);
const timer = setTimeout(() => app.exit(2), 20_000);
async function run(): Promise<void> {
  await app.whenReady();
  const window = new BrowserWindow({ width: 640, height: 480, show: true });
  const html = '<title>Inertia native snapshot fixture</title><style>body{background:#fff;color:#111}input{background:#fc0;width:280px;height:50px}</style><h1>Public snapshot evidence</h1><label>Private note <input value="snapshot-private-sentinel"></label>';
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  window.show(); window.focus(); window.webContents.focus();
  let finish!: () => void, fail!: (error: unknown) => void;
  let clientSize: { width: number; height: number } | undefined;
  const captured = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const service = new SnapshotService(async () => {
    try {
      const result = await service.capture();
      assert(!negative, "Missing accessibility must never return pixels");
      assert(clientSize);
      assert.equal(result.source.width, clientSize.width, "Capture stays within the native X11 client width");
      assert.equal(result.source.height, clientSize.height, "Capture stays within the native X11 client height");
      assert(!JSON.stringify(result.source).includes("snapshot-private-sentinel"));
      assert(JSON.stringify(result.source).includes("Public snapshot evidence"));
      const masks = result.source.accessibility.nodes.filter((node) => node.redacted);
      assert(masks.length > 0);
      const canvas = createCanvas(result.source.width, result.source.height), ctx = canvas.getContext("2d");
      ctx.drawImage(await loadImage(result.png), 0, 0);
      for (const mask of masks) {
        assert(mask.bounds);
        const { x, y, width, height } = mask.bounds;
        assert.deepEqual([...ctx.getImageData(Math.round(x + width / 2), Math.round(y + height / 2), 1, 1).data], [36, 36, 36, 255]);
      }
      console.log("NATIVE_SNAPSHOT_EVIDENCE masked-capture"); finish();
    } catch (error) {
      if (negative && error instanceof Error && error.message.includes("not exposing its accessibility tree")) {
        console.log("NATIVE_SNAPSHOT_EVIDENCE accessibility-refused"); finish();
      } else fail(error);
    }
  });
  try {
    assert((await service.configure(true, "accelerator")).enabled);
    const windowId = String(window.getNativeWindowHandle().readUInt32LE());
    await runFile("xdotool", ["windowactivate", "--sync", windowId], { timeout: 3000, maxBuffer: 1024 });
    const { stdout } = await runFile("xdotool", ["getactivewindow"], { timeout: 1000, maxBuffer: 1024 });
    assert.equal(stdout.trim(), windowId, "The synthetic capture window must own the foreground");
    const { stdout: geometry } = await runFile("xdotool", ["getwindowgeometry", "--shell", windowId], { timeout: 1000, maxBuffer: 1024 });
    clientSize = { width: Number(/^WIDTH=(\d+)$/mu.exec(geometry)?.[1]), height: Number(/^HEIGHT=(\d+)$/mu.exec(geometry)?.[1]) };
    assert(clientSize.width > 0 && clientSize.height > 0);
    // Use an OS key event, not a test-only call to the shortcut callback.
    await Promise.all([captured, runFile("xdotool", ["key", "--clearmodifiers", "ctrl+alt+s"], { timeout: 3000, maxBuffer: 1024 })]);
  } finally { await service.dispose(); window.destroy(); }
}
void run().then(() => { clearTimeout(timer); app.exit(0); }, (error: unknown) => { console.error(error); clearTimeout(timer); app.exit(1); });
