import type { WebContents } from "electron";

import { agentPageIsFrozen, evaluateInFrozenAgentPage } from "./preview-agent-boundary.js";
import { AGENT_BROWSER_WORLD_ID } from "./preview-agent-page.js";

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
    element.scrollIntoView({ block: "center", inline: "nearest" });
    return { found: true, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY } };
  })()`);
  if (typeof value !== "object" || value === null || (value as { found?: unknown }).found !== true) {
    return { found: false };
  }
  return { found: true, viewport: viewport((value as { viewport?: unknown }).viewport) };
}
