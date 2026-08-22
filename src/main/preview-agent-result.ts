import {
  MAX_AGENT_BROWSER_TEXT_BYTES,
  type AgentBrowserResult,
  type AgentBrowserState,
} from "../shared/agent-browser.js";

export function failedAgentBrowserResult(
  code: Extract<AgentBrowserResult, { ok: false }>["code"],
  message: string,
): AgentBrowserResult {
  return { ok: false, code, message };
}

export function boundedAgentStateText(
  state: AgentBrowserState,
  detail?: Record<string, unknown>,
): string {
  const payload = detail ? { ...detail, state } : state;
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_AGENT_BROWSER_TEXT_BYTES) {
    return serialized;
  }
  const compactState = {
    ...state,
    tabs: state.tabs.map((tab) => ({
      ...tab,
      title: tab.title.slice(0, 120),
      url: tab.url.slice(0, 1_024),
    })),
    activity: state.activity
      ? { ...state.activity, label: state.activity.label.slice(0, 160) }
      : null,
  };
  return JSON.stringify(detail
    ? { ...detail, state: compactState, truncated: true }
    : { ...compactState, truncated: true });
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
