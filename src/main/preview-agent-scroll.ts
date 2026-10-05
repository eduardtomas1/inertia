import type { WebContents } from "electron";

import { agentPageIsFrozen, evaluateInFrozenAgentPage } from "./preview-agent-boundary.js";
import { AGENT_BROWSER_WORLD_ID, PRIVACY_RUNTIME, type PreviewAgentTarget } from "./preview-agent-page.js";

export interface AgentPageScroll {
  found: boolean;
  viewport?: Record<string, number>;
}

async function execute(contents: WebContents, code: string): Promise<unknown> {
  if (agentPageIsFrozen(contents)) return await evaluateInFrozenAgentPage(contents, code);
  return await contents.executeJavaScriptInIsolatedWorld(AGENT_BROWSER_WORLD_ID, [{ code }], true);
}

function viewport(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(["width", "height", "scrollX", "scrollY"].flatMap((key) => {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? [[key, candidate]] : [];
  }));
}

export async function describeAgentPageRef(contents: WebContents, ref: string): Promise<PreviewAgentTarget> {
  const value = await execute(contents, `(() => {
    const state = globalThis.__inertiaAgentBrowser;
    const element = state?.refs?.get(${JSON.stringify(ref)});
    if (!element || !element.isConnected || state.privacyGuardInstalled !== true) return { found: false };
    const privacy = ${PRIVACY_RUNTIME};
    const attribute = (name) => {
      const value = element.getAttribute?.(name);
      return typeof value === "string" ? value.slice(0, 600) : "";
    };
    const sensitive = Boolean(state.evidenceWithheld) || state.passwordNodes?.has(element) === true
      || privacy.isSensitiveField(element);
    const text = String(element.textContent ?? "").slice(0, 600);
    const role = attribute("role").trim().toLowerCase().slice(0, 50)
      || ({ A: "link", BUTTON: "button", INPUT: "input", SELECT: "select", TEXTAREA: "textbox", SUMMARY: "button" })[element.tagName]
      || String(element.tagName).toLowerCase().slice(0, 50);
    const label = sensitive
      ? "Sensitive field"
      : privacy.redact(state, attribute("aria-label") || text || attribute("title") || attribute("placeholder") || "page control", 300);
    return { found: true, role, label, sensitive };
  })()`);
  if (typeof value !== "object" || value === null || (value as { found?: unknown }).found !== true) return { found: false };
  const target = value as Record<string, unknown>;
  return {
    found: true,
    blocked: false,
    disabled: false,
    editable: false,
    sensitive: target.sensitive === true,
    role: typeof target.role === "string" ? target.role.slice(0, 50) : "",
    label: typeof target.label === "string" ? target.label.slice(0, 300) : "page control",
  };
}

export async function agentPageRefOutsideViewport(contents: WebContents, ref: string): Promise<boolean> {
  return await execute(contents, `(() => {
    const element = globalThis.__inertiaAgentBrowser?.refs?.get(${JSON.stringify(ref)});
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth;
  })()`) === true;
}

export async function scrollAgentPageRefIntoView(contents: WebContents, ref: string): Promise<AgentPageScroll> {
  const value = await execute(contents, `(() => {
    const element = globalThis.__inertiaAgentBrowser?.refs?.get(${JSON.stringify(ref)});
    if (!element || !element.isConnected) return { found: false };
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    return { found: true, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY } };
  })()`);
  if (typeof value !== "object" || value === null || (value as { found?: unknown }).found !== true) {
    return { found: false };
  }
  return { found: true, viewport: viewport((value as { viewport?: unknown }).viewport) };
}
