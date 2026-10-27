import { nativeImage, type NativeImage, type WebContents } from "electron";

import {
  MAX_AGENT_BROWSER_IMAGE_BYTES,
  MAX_AGENT_BROWSER_IMAGE_EDGE,
  type AgentBrowserResult,
  type AgentBrowserState,
} from "../shared/agent-browser.js";
import { agentPageHasClosedShadowRoots } from "./preview-agent-boundary.js";
import type { AgentPageNestedEvidence } from "./preview-agent-nested-evidence.js";
import {
  agentPageDevicePixelRatio,
  agentPageHasSensitiveScreenshotEvidence,
  agentPageNestedScreenshotEvidence,
} from "./preview-agent-page.js";
import { agentPageVisualViewport } from "./preview-agent-viewport.js";

const MAX_SCREENSHOT_REDUCTIONS = 5;
const OVERSIZED_REDUCTION = 0.72;
const UNREADABLE_SCREENSHOT = "The page has frames or shadow roots Inertia cannot inspect.";

export interface AgentPageScreenshot {
  image: NativeImage;
  data: string;
  width: number;
  height: number;
}

export type AgentPageCapture = AgentPageScreenshot | "empty" | "too-large";

function withinImageBytes(data: string): boolean {
  return Math.floor((data.length * 3) / 4) <= MAX_AGENT_BROWSER_IMAGE_BYTES;
}

function boundedAgentScreenshot(source: Buffer): AgentPageCapture {
  let image = nativeImage.createFromBuffer(source);
  let data = source.toString("base64");
  for (let attempt = 0; ; attempt += 1) {
    const { width, height } = image.getSize();
    if (width <= 0 || height <= 0) return "empty";
    const edge = Math.min(1, MAX_AGENT_BROWSER_IMAGE_EDGE / Math.max(width, height));
    const fits = withinImageBytes(data);
    if (edge === 1 && fits) return { image, data, width, height };
    if (attempt === MAX_SCREENSHOT_REDUCTIONS) return "too-large";
    const factor = fits ? edge : edge * OVERSIZED_REDUCTION;
    image = image.resize({
      width: Math.max(1, Math.round(width * factor)),
      height: Math.max(1, Math.round(height * factor)),
      quality: "good",
    });
    data = image.toPNG().toString("base64");
  }
}

export async function agentPageScreenshotPrivacy(
  contents: WebContents,
): Promise<AgentPageNestedEvidence> {
  if (await agentPageHasSensitiveScreenshotEvidence(contents)) return "sensitive";
  const nested = await agentPageNestedScreenshotEvidence(contents);
  return nested === "clear" && agentPageHasClosedShadowRoots(contents) ? "unreadable" : nested;
}

export async function captureAgentPageScreenshot(
  contents: WebContents,
): Promise<AgentPageCapture> {
  const visual = await agentPageVisualViewport(contents);
  const ratio = await agentPageDevicePixelRatio(contents);
  const shown = Math.max(visual.width, visual.height) * visual.scale;
  const edge = Math.min(1, MAX_AGENT_BROWSER_IMAGE_EDGE / shown);
  const captured = await contents.debugger.sendCommand("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: visual.pageX,
      y: visual.pageY,
      width: visual.width,
      height: visual.height,
      scale: (visual.scale * edge) / ratio,
    },
  }) as { data?: unknown } | undefined;
  if (typeof captured?.data !== "string" || captured.data.length === 0) return "empty";
  return boundedAgentScreenshot(Buffer.from(captured.data, "base64"));
}

export function capturedAgentScreenshotResult(
  shot: AgentPageCapture | null,
  tabId: string,
  url: string,
  state: AgentBrowserState,
  unreadable = false,
): AgentBrowserResult {
  if (shot === "too-large") {
    return { ok: false, code: "too-large", message: "The Browser screenshot was too large to return. Take a snapshot instead." };
  }
  if (shot === null || shot === "empty") {
    return { ok: false, code: "unavailable", message: "The active Browser page had no drawable screenshot." };
  }
  return {
    ok: true,
    text: JSON.stringify({
      captured: true,
      tabId,
      url,
      width: shot.width,
      height: shot.height,
      ...(unreadable ? { withheld: UNREADABLE_SCREENSHOT } : {}),
    }),
    state,
    ...(unreadable ? {} : {
      image: { mimeType: "image/png", data: shot.data, width: shot.width, height: shot.height },
    }),
  };
}
