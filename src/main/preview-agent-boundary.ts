import type { WebContents } from "electron";

import { AGENT_BROWSER_WORLD_ID } from "./preview-agent-page.js";

const MAX_AGENT_PAGE_BOUNDARY_ELEMENTS = 4_000;

interface AgentPageBoundaryState {
  mainFrameId: string | null;
  nestedContentObserved: boolean;
}

const agentPageBoundaryStates = new WeakMap<WebContents, AgentPageBoundaryState>();
const agentPageDebuggerBootstraps = new WeakMap<WebContents, number>();

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function installAgentFileChooserBlock(contents: WebContents): Promise<void> {
  if (contents.debugger.isAttached()) {
    throw new Error("The Browser page is already attached to another debugger.");
  }
  if (!contents.getURL()) {
    await contents.loadURL("about:blank");
    agentPageDebuggerBootstraps.set(contents, contents.navigationHistory.getActiveIndex());
  }
  contents.debugger.attach("1.3");
  const state: AgentPageBoundaryState = {
    mainFrameId: null,
    nestedContentObserved: false,
  };
  agentPageBoundaryStates.set(contents, state);
  contents.debugger.on("message", (_event, method, params) => {
    const payload = objectRecord(params);
    if (method === "Page.frameNavigated") {
      const frame = objectRecord(payload?.frame);
      const id = frame?.id;
      if (typeof id === "string" && typeof frame?.parentId !== "string") {
        state.mainFrameId = id;
        state.nestedContentObserved = false;
      }
      return;
    }
    if (method === "Page.frameAttached") {
      if (typeof payload?.parentFrameId === "string") state.nestedContentObserved = true;
      return;
    }
    if (method === "DOM.shadowRootPushed") {
      const root = objectRecord(payload?.root);
      if (root?.shadowRootType !== "user-agent") state.nestedContentObserved = true;
    }
  });
  try {
    await contents.debugger.sendCommand("Page.enable");
    await contents.debugger.sendCommand("DOM.enable");
    await contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", {
      enabled: false,
    });
  } catch (error) {
    try {
      if (contents.debugger.isAttached()) contents.debugger.detach();
    } catch {
      // Preserve the setup failure that made the action unsafe.
    }
    throw error;
  }
}

export function settleAgentPageDebuggerBootstrap(contents: WebContents): void {
  const index = agentPageDebuggerBootstraps.get(contents);
  agentPageDebuggerBootstraps.delete(contents);
  if (index === undefined || index < 0 || index === contents.navigationHistory.getActiveIndex()) return;
  if (contents.navigationHistory.getEntryAtIndex(index)?.url === "about:blank") {
    contents.navigationHistory.removeEntryAtIndex(index);
  }
}

/** Fail closed unless privileged and isolated-world boundary views agree. */
async function hasUnreachableAgentPageElements(contents: WebContents): Promise<boolean> {
  const lightCount = await contents.executeJavaScriptInIsolatedWorld(
    AGENT_BROWSER_WORLD_ID,
    [{ code: `(() => { // __inertia_boundary_count__
      const root = document.documentElement;
      const iterator = root && typeof document.createNodeIterator === "function"
        ? document.createNodeIterator(root, 1)
        : null;
      if (!iterator) return null;
      let count = 0;
      while (iterator.nextNode()) {
        count += 1;
        if (count > ${MAX_AGENT_PAGE_BOUNDARY_ELEMENTS}) return null;
      }
      return count;
    })()` }],
    true,
  );
  if (!Number.isInteger(lightCount)
    || lightCount < 0
    || lightCount > MAX_AGENT_PAGE_BOUNDARY_ELEMENTS) return true;

  const search = objectRecord(await contents.debugger.sendCommand("DOM.performSearch", {
    query: "*",
    includeUserAgentShadowDOM: false,
  }));
  const searchId = search?.searchId;
  if (typeof searchId !== "string") return true;
  try {
    const resultCount = search?.resultCount;
    return !Number.isInteger(resultCount)
      || (resultCount as number) !== lightCount
      || (resultCount as number) > MAX_AGENT_PAGE_BOUNDARY_ELEMENTS;
  } finally {
    await contents.debugger.sendCommand("DOM.discardSearchResults", { searchId });
  }
}

/**
 * Browser evidence currently has document-start credential ownership only for
 * the top-level document. Fail closed when a page contains author-controlled
 * nested documents or shadow roots rather than capture pixels from an
 * unguarded DOM boundary. User-agent shadow roots are excluded because their
 * contents are owned by Chromium, not the page.
 */
export function hasUnguardedAgentPageContent(boundaryState: unknown): boolean {
  return objectRecord(boundaryState)?.nestedContentObserved !== false;
}

export async function agentPageHasUnguardedNestedContent(
  contents: WebContents,
): Promise<boolean> {
  const state = agentPageBoundaryStates.get(contents);
  if (state?.nestedContentObserved !== false) return true;
  if (!contents.debugger.isAttached()) {
    throw new Error("The Browser security debugger is unavailable.");
  }
  const frameId = state.mainFrameId;
  try {
    if (await hasUnreachableAgentPageElements(contents)
      || state.mainFrameId !== frameId) {
      state.nestedContentObserved = true;
    }
  } catch {
    state.nestedContentObserved = true;
  }
  return hasUnguardedAgentPageContent(state);
}

export async function setAgentPageFrozen(
  contents: WebContents,
  frozen: boolean,
): Promise<void> {
  if (!contents.debugger.isAttached()) {
    throw new Error("The Browser security debugger is unavailable.");
  }
  await contents.debugger.sendCommand("Page.setWebLifecycleState", {
    state: frozen ? "frozen" : "active",
  });
}
