import type { NativeImage } from "electron";

import {
  MAX_AGENT_BROWSER_SCREENSHOT_BYTES,
  type AgentBrowserResult,
  type AgentBrowserState,
} from "../shared/agent-browser.js";

export function boundedAgentScreenshot(source: NativeImage): NativeImage {
  let image = source;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const size = image.getSize();
    const scale = Math.min(1, 1_600 / size.width, 1_000 / size.height);
    if (scale < 1) {
      image = image.resize({
        width: Math.max(1, Math.floor(size.width * scale)),
        height: Math.max(1, Math.floor(size.height * scale)),
        quality: "good",
      });
    }
    if (image.toPNG().byteLength <= MAX_AGENT_BROWSER_SCREENSHOT_BYTES) break;
    image = image.resize({
      width: Math.max(1, Math.floor(image.getSize().width * 0.72)),
      quality: "good",
    });
  }
  return image;
}

export function capturedAgentScreenshotResult(
  source: NativeImage,
  tabId: string,
  url: string,
  state: AgentBrowserState,
): AgentBrowserResult {
  const image = boundedAgentScreenshot(source);
  const png = image.toPNG();
  if (png.byteLength === 0) {
    return { ok: false, code: "unavailable", message: "The active Browser page had no drawable screenshot." };
  }
  if (png.byteLength > MAX_AGENT_BROWSER_SCREENSHOT_BYTES) {
    return { ok: false, code: "too-large", message: "The Browser screenshot exceeded its bounded image size." };
  }
  return {
    ok: true,
    text: JSON.stringify({
      captured: true,
      tabId,
      url,
      width: image.getSize().width,
      height: image.getSize().height,
    }),
    state,
    image: { mimeType: "image/png", data: png.toString("base64") },
  };
}
