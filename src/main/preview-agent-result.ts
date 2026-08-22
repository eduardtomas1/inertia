import type { AgentBrowserResult, AgentBrowserState } from "../shared/agent-browser.js";
import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../shared/agent-browser.js";

export function failedAgentBrowserResult(
  code: Extract<AgentBrowserResult, { ok: false }>["code"],
  message: string,
): AgentBrowserResult {
  return { ok: false, code, message };
}

export function successfulAgentBrowserResult(
  text: string,
  state: AgentBrowserState,
  image?: { mimeType: "image/png"; data: string },
): AgentBrowserResult {
  if (Buffer.byteLength(text, "utf8") > MAX_AGENT_BROWSER_TEXT_BYTES) {
    return failedAgentBrowserResult(
      "too-large",
      "The Browser result exceeded its bounded text size.",
    );
  }
  return { ok: true, text, state, ...(image ? { image } : {}) };
}
