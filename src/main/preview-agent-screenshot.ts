import type { NativeImage } from "electron";

import {
  type AgentBrowserResult,
  type AgentBrowserState,
} from "../shared/agent-browser.js";

export function capturedAgentScreenshotResult(
  source: NativeImage,
  tabId: string,
  url: string,
  state: AgentBrowserState,
): AgentBrowserResult {
  const size = source.getSize();
  if (size.width <= 0 || size.height <= 0) {
    return { ok: false, code: "unavailable", message: "The active Browser page had no drawable screenshot." };
  }
  return {
    ok: true,
    text: JSON.stringify({
      captured: true,
      tabId,
      url,
      width: Math.min(Math.trunc(size.width), 4_096),
      height: Math.min(Math.trunc(size.height), 4_096),
      bitmap: "local-only",
      providerImage: false,
    }),
    state,
  };
}
