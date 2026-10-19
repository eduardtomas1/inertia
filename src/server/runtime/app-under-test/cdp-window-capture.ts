import {
  MAX_APP_AGENT_IMAGE_BYTES,
  MAX_APP_AGENT_IMAGE_EDGE,
  MAX_APP_AGENT_IMAGE_PIXELS,
  MAX_APP_EVIDENCE_THUMBNAIL_BYTES,
  MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT,
  MAX_APP_EVIDENCE_THUMBNAIL_WIDTH,
} from "../../../shared/app-under-test";
import { finiteNumber, MAX_SCREENSHOT_ATTEMPTS, pngDimensions, record, refusal } from "./cdp-window-support";
import type { AppUnderTestAgentImage, AppUnderTestWindowFailure } from "./window-transport";

/**
 * Window captures of the Electron transport. Chromium renders every image
 * already reduced (`clip.scale`), so a full-size bitmap never reaches the
 * runtime: the local Evidence thumbnail, and, when the project lets the model
 * see screenshots, a model-visible copy.
 */

/** Sends one protocol command to the window's session. */
export type CdpCaptureSend = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Image pixels of a model-visible capture. Even an incompressible RGBA PNG of
 * this size (about 2.9 MB, 3.9 MiB in base64) fits one 4 MiB debugging frame,
 * whose bound would otherwise end the window connection.
 */
export const AGENT_IMAGE_MAX_PIXELS = MAX_APP_AGENT_IMAGE_PIXELS;

export interface CdpWindowCapture {
  /** The window's CSS size. */
  width: number;
  height: number;
  thumbnail: { png: Uint8Array; width: number; height: number };
  image: AppUnderTestAgentImage | null;
}

async function capture(send: CdpCaptureSend, metrics: Record<string, unknown> | null, width: number, height: number, scale: number) {
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: finiteNumber(metrics?.pageX) ?? 0, y: finiteNumber(metrics?.pageY) ?? 0, width, height, scale },
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const png = Buffer.from(typeof shot.data === "string" ? shot.data : "", "base64");
  return { png, size: pngDimensions(png) };
}

/**
 * The model-visible copy: long edge at most 1,536 pixels, pixel count within
 * the frame-safe bound, at most 3.75 MB. The thumbnail tells how many image
 * pixels one CSS pixel became (the device scale factor).
 */
async function agentCapture(
  send: CdpCaptureSend,
  metrics: Record<string, unknown> | null,
  width: number,
  height: number,
  thumbnailScale: number,
  thumbnail: { width: number; height: number },
): Promise<AppUnderTestAgentImage | null> {
  const density = Math.max(thumbnail.width / (width * thumbnailScale), thumbnail.height / (height * thumbnailScale), 0.01) * 1.02;
  const pixelWidth = width * density;
  const pixelHeight = height * density;
  let scale = Math.min(1, MAX_APP_AGENT_IMAGE_EDGE / Math.max(pixelWidth, pixelHeight), Math.sqrt(AGENT_IMAGE_MAX_PIXELS / (pixelWidth * pixelHeight)));
  for (let attempt = 0; attempt < MAX_SCREENSHOT_ATTEMPTS; attempt += 1) {
    const { png, size } = await capture(send, metrics, width, height, scale);
    if (!size) return null;
    const edge = Math.max(size.width, size.height);
    if (edge > MAX_APP_AGENT_IMAGE_EDGE || size.width * size.height > AGENT_IMAGE_MAX_PIXELS) {
      scale *= Math.min(MAX_APP_AGENT_IMAGE_EDGE / edge, Math.sqrt(AGENT_IMAGE_MAX_PIXELS / (size.width * size.height))) * 0.98;
    } else if (png.byteLength > MAX_APP_AGENT_IMAGE_BYTES) {
      scale *= 0.72;
    } else {
      return { png: new Uint8Array(png), ...size };
    }
  }
  return null;
}

/** Captures the thumbnail and, when asked, the model-visible copy; the caller applies the privacy gate around it. */
export async function captureCdpWindow(send: CdpCaptureSend, agentImage: boolean): Promise<CdpWindowCapture> {
  const metrics = record((await send("Page.getLayoutMetrics")).cssVisualViewport);
  const width = Math.floor(finiteNumber(metrics?.clientWidth) ?? 0);
  const height = Math.floor(finiteNumber(metrics?.clientHeight) ?? 0);
  if (width <= 0 || height <= 0 || width > 16_384 || height > 16_384) {
    throw refusal("unavailable", "This window has nothing drawable to capture.");
  }
  let scale = Math.min(1, MAX_APP_EVIDENCE_THUMBNAIL_WIDTH / width, MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT / height);
  let thumbnail: CdpWindowCapture["thumbnail"] | null = null;
  for (let attempt = 0; attempt < MAX_SCREENSHOT_ATTEMPTS && thumbnail === null; attempt += 1) {
    const { png, size } = await capture(send, metrics, width, height, scale);
    if (!size) throw refusal("unavailable", "The window returned an unreadable screenshot.");
    if (size.width > MAX_APP_EVIDENCE_THUMBNAIL_WIDTH || size.height > MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT) {
      scale *= Math.min(MAX_APP_EVIDENCE_THUMBNAIL_WIDTH / size.width, MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT / size.height) * 0.98;
    } else if (png.byteLength > MAX_APP_EVIDENCE_THUMBNAIL_BYTES) {
      scale *= 0.72;
    } else {
      thumbnail = { png: new Uint8Array(png), ...size };
    }
  }
  if (!thumbnail) throw refusal("too-large", "The window could not be reduced to a local thumbnail.");
  // The model-visible copy never costs the local thumbnail: a failed capture leaves it local only.
  const image = agentImage ? await agentCapture(send, metrics, width, height, scale, thumbnail).catch(() => null) : null;
  return { width, height, thumbnail, image };
}

/** Electron windows take input over the debugging pipe and never need the foreground. */
export function activateRefused(): AppUnderTestWindowFailure {
  return {
    ok: false,
    code: "invalid",
    message: "inertia_app_activate is only for native windows. This window takes clicks, text, keys and scrolling over the debugging pipe without being in front.",
    dispatched: false,
  };
}
