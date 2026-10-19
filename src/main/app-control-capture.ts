import { createCanvas, ImageData, loadImage, type Image } from "@napi-rs/canvas";

import type { MacWindowTarget } from "./snapshot-macos-window.js";
import { snapshotImageScale, snapshotMaskRect } from "./snapshot-geometry.js";
import { AppControlNativeFailure, type NativeRect } from "./app-control-native.js";
import { APP_CONTROL_CAPTURE_MAX_BYTES } from "./app-control-worker-protocol.js";
import { appControlScreenshotAvailable } from "./app-control-platform.js";

/**
 * Captures one App control window as local evidence and masks every protected
 * field with Snapshots' geometry rules before the pixels leave the worker.
 * macOS captures exactly that window with `screencapture -l` (the Snapshots
 * helper); Windows and X11 capture the pixels under the window bounds, which
 * can include overlapping windows; Wayland has no capture path.
 */

export const APP_CONTROL_CAPTURE_MAX_WIDTH = 1_024;
export const APP_CONTROL_CAPTURE_MAX_HEIGHT = 640;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface AppControlCaptureDependencies {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  regionScreenshot(region: NativeRect): Promise<{ width: number; height: number; pixels: Buffer }>;
  macPixels?: {
    locate(target: MacWindowTarget): { id: number; frame: NativeRect } | null;
    capture(id: number): Promise<Buffer>;
  };
}

export interface AppControlCapture {
  png: Buffer;
  width: number;
  height: number;
  mayIncludeOverlappingWindows: boolean;
}

async function decodePng(png: Buffer): Promise<Image> {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR"
    || png.readUInt32BE(16) * png.readUInt32BE(20) > 32_000_000) throw new AppControlNativeFailure("native-failure");
  return await loadImage(png).catch(() => { throw new AppControlNativeFailure("native-failure"); });
}

export async function captureMaskedWindow(
  target: { pid: number; title: string | null; bounds: NativeRect },
  masks: readonly NativeRect[],
  dependencies: AppControlCaptureDependencies,
): Promise<AppControlCapture> {
  const { platform } = dependencies;
  if (!appControlScreenshotAvailable(platform, dependencies.env)) {
    throw new AppControlNativeFailure("unsupported", platform === "linux" ? "wayland" : null);
  }
  let frame = target.bounds;
  let source: { width: number; height: number; draw(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>): void };
  let overlapping = true;
  if (platform === "darwin") {
    const pixels = dependencies.macPixels;
    const located = pixels?.locate({ pid: target.pid, title: target.title, bounds: target.bounds }) ?? null;
    if (!pixels || !located) throw new AppControlNativeFailure("native-failure");
    const image = await decodePng(await pixels.capture(located.id));
    frame = located.frame;
    overlapping = false;
    source = { width: image.width, height: image.height, draw: (context) => context.drawImage(image, 0, 0) };
  } else {
    const shot = await dependencies.regionScreenshot(target.bounds);
    if (!(shot.width > 0 && shot.height > 0 && shot.width * shot.height <= 32_000_000
      && shot.pixels.byteLength === shot.width * shot.height * 4)) throw new AppControlNativeFailure("native-failure");
    source = {
      width: shot.width,
      height: shot.height,
      draw: (context) => context.putImageData(new ImageData(new Uint8ClampedArray(shot.pixels), shot.width, shot.height), 0, 0),
    };
  }
  const scale = snapshotImageScale(frame, source, platform === "darwin" ? 1 : Infinity);
  if (!scale) throw new AppControlNativeFailure("native-failure");
  const canvas = createCanvas(source.width, source.height);
  const context = canvas.getContext("2d");
  source.draw(context);
  context.fillStyle = "#242424";
  for (const rect of masks) {
    const mask = snapshotMaskRect(rect, frame, scale);
    context.fillRect(mask.x, mask.y, mask.width, mask.height);
  }
  const reduce = Math.min(1, APP_CONTROL_CAPTURE_MAX_WIDTH / source.width, APP_CONTROL_CAPTURE_MAX_HEIGHT / source.height);
  const output = createCanvas(Math.max(1, Math.round(source.width * reduce)), Math.max(1, Math.round(source.height * reduce)));
  output.getContext("2d").drawImage(canvas, 0, 0, output.width, output.height);
  const png = output.toBuffer("image/png");
  if (png.length > APP_CONTROL_CAPTURE_MAX_BYTES) throw new AppControlNativeFailure("native-failure");
  return { png, width: output.width, height: output.height, mayIncludeOverlappingWindows: overlapping };
}
