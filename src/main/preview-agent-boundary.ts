import type { WebContents } from "electron";

const MAX_AGENT_PAGE_FOCUS_DEPTH = 4_000;
const AGENT_PAGE_BOUNDARY_OBJECT_GROUP = "inertia-agent-page-boundary";
const AGENT_PAGE_WORLD_NAME = "Electron Isolated Context";
const AGENT_PAGE_WORLD_UNAVAILABLE = "Inertia could not confirm its private inspection context for this page. Navigate to the page again to reload it, then continue.";

interface AgentPageBoundaryState {
  mainFrameId: string | null;
  documentGeneration: number;
  framesObserved: boolean;
  shadowRootsObserved: boolean;
}

interface FrozenAgentPage {
  contextId: number;
  documentGeneration: number;
}

type AgentPageDebuggerListener = (event: unknown, method: string, params: unknown) => void;

const agentPageBoundaryStates = new WeakMap<WebContents, AgentPageBoundaryState>();
const agentPageDebuggerBootstraps = new WeakMap<WebContents, number>();
const agentPageDebuggerListeners = new WeakMap<WebContents, AgentPageDebuggerListener>();
const agentPageContextCollectors = new WeakMap<WebContents, AgentPageDebuggerListener>();
const frozenAgentPages = new WeakMap<WebContents, FrozenAgentPage>();
const agentPageFreezeGenerations = new WeakMap<WebContents, number>();

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
    documentGeneration: 0,
    framesObserved: false,
    shadowRootsObserved: false,
  };
  agentPageBoundaryStates.set(contents, state);
  const listener: AgentPageDebuggerListener = (_event, method, params) => {
    const payload = objectRecord(params);
    if (method === "Page.frameNavigated") {
      const frame = objectRecord(payload?.frame);
      const id = frame?.id;
      if (typeof id === "string" && typeof frame?.parentId !== "string") {
        state.mainFrameId = id;
        state.documentGeneration += 1;
        state.framesObserved = false;
        state.shadowRootsObserved = false;
      }
      return;
    }
    if (method === "Page.frameAttached") {
      if (typeof payload?.parentFrameId === "string") state.framesObserved = true;
      return;
    }
    if (method === "DOM.shadowRootPushed") {
      const root = objectRecord(payload?.root);
      if (root?.shadowRootType !== "user-agent") state.shadowRootsObserved = true;
    }
  };
  agentPageDebuggerListeners.set(contents, listener);
  contents.debugger.on("message", listener);
  try {
    await contents.debugger.sendCommand("Page.enable");
    await contents.debugger.sendCommand("DOM.enable");
    await contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", {
      enabled: false,
    });
  } catch (error) {
    releaseAgentPageDebugger(contents);
    throw error;
  }
}

export function releaseAgentPageDebugger(contents: WebContents): void {
  const listener = agentPageDebuggerListeners.get(contents);
  const collector = agentPageContextCollectors.get(contents);
  agentPageDebuggerListeners.delete(contents);
  agentPageContextCollectors.delete(contents);
  agentPageBoundaryStates.delete(contents);
  frozenAgentPages.delete(contents);
  agentPageFreezeGenerations.set(contents, (agentPageFreezeGenerations.get(contents) ?? 0) + 1);
  if (contents.isDestroyed()) return;
  if (listener) contents.debugger.removeListener("message", listener);
  if (collector) contents.debugger.removeListener("message", collector);
  try {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  } catch {
    return;
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

export interface AgentPageBoundaryGaps {
  frames: boolean;
  shadowRoots: boolean;
}

export function agentPageBoundaryGaps(contents: WebContents): AgentPageBoundaryGaps {
  const state = agentPageBoundaryStates.get(contents);
  return {
    frames: state?.framesObserved === true,
    shadowRoots: state?.shadowRootsObserved === true,
  };
}

export async function agentPageFocusIsHidden(contents: WebContents): Promise<boolean> {
  const state = agentPageBoundaryStates.get(contents);
  if (!state || !contents.debugger.isAttached()) {
    throw new Error("The Browser security debugger is unavailable.");
  }
  const frameId = state.mainFrameId;
  if (typeof frameId !== "string") return true;
  const world = objectRecord(await contents.debugger.sendCommand("Page.createIsolatedWorld", {
    frameId,
    worldName: AGENT_PAGE_BOUNDARY_OBJECT_GROUP,
    grantUniveralAccess: false,
  }));
  const executionContextId = world?.executionContextId;
  if (typeof executionContextId !== "number" || !Number.isInteger(executionContextId)) return true;
  try {
    const evaluated = objectRecord(await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(() => {
        let active = document.activeElement;
        let depth = 0;
        while (active?.shadowRoot?.activeElement && depth < ${MAX_AGENT_PAGE_FOCUS_DEPTH}) {
          active = active.shadowRoot.activeElement;
          depth += 1;
        }
        if (active?.shadowRoot?.activeElement) return null;
        return active || document.documentElement;
      })()`,
      contextId: executionContextId,
      objectGroup: AGENT_PAGE_BOUNDARY_OBJECT_GROUP,
      returnByValue: false,
      generatePreview: false,
      awaitPromise: false,
      userGesture: false,
      timeout: 3_000,
    }));
    const result = objectRecord(evaluated?.result);
    const objectId = result?.objectId;
    if (evaluated?.exceptionDetails || result?.subtype !== "node" || typeof objectId !== "string") {
      return true;
    }
    const description = objectRecord(await contents.debugger.sendCommand(
      "DOM.describeNode",
      { objectId, depth: 0, pierce: true },
    ));
    const node = objectRecord(description?.node);
    if (node?.nodeType !== 1) return true;
    if (node.shadowRoots === undefined) return false;
    if (!Array.isArray(node.shadowRoots)) return true;
    return node.shadowRoots.some((root) => {
      const type = objectRecord(root)?.shadowRootType;
      return type !== "user-agent" && type !== "open";
    });
  } finally {
    await contents.debugger.sendCommand("Runtime.releaseObjectGroup", {
      objectGroup: AGENT_PAGE_BOUNDARY_OBJECT_GROUP,
    });
  }
}

async function evaluateInAgentPageWorld(
  contents: WebContents,
  contextId: number,
  expression: string,
): Promise<unknown> {
  const evaluated = objectRecord(await contents.debugger.sendCommand("Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: false,
    generatePreview: false,
  }));
  if (!evaluated || evaluated.exceptionDetails !== undefined) {
    throw new Error("The Browser privacy check failed while the page was frozen.");
  }
  return objectRecord(evaluated.result)?.value;
}

async function agentPageWorldContext(
  contents: WebContents,
  state: AgentPageBoundaryState,
): Promise<FrozenAgentPage> {
  const frameId = state.mainFrameId;
  const documentGeneration = state.documentGeneration;
  if (typeof frameId !== "string") throw new Error(AGENT_PAGE_WORLD_UNAVAILABLE);
  const contexts: number[] = [];
  const collect: AgentPageDebuggerListener = (_event, method, params) => {
    if (method !== "Runtime.executionContextCreated") return;
    const context = objectRecord(objectRecord(params)?.context);
    const auxData = objectRecord(context?.auxData);
    if (context?.name === AGENT_PAGE_WORLD_NAME
      && auxData?.frameId === frameId
      && auxData.isDefault === false
      && auxData.type === "isolated"
      && typeof context.id === "number"
      && Number.isInteger(context.id)) contexts.push(context.id);
  };
  const stale = agentPageContextCollectors.get(contents);
  if (stale) contents.debugger.removeListener("message", stale);
  agentPageContextCollectors.set(contents, collect);
  contents.debugger.on("message", collect);
  try {
    await contents.debugger.sendCommand("Runtime.disable");
    await contents.debugger.sendCommand("Runtime.enable");
  } finally {
    contents.debugger.removeListener("message", collect);
    if (agentPageContextCollectors.get(contents) === collect) agentPageContextCollectors.delete(contents);
    await contents.debugger.sendCommand("Runtime.disable");
  }
  const contextId = contexts[0];
  if (contexts.length !== 1 || contextId === undefined) throw new Error(AGENT_PAGE_WORLD_UNAVAILABLE);
  const guarded = await evaluateInAgentPageWorld(
    contents,
    contextId,
    "globalThis.__inertiaAgentBrowser?.privacyGuardInstalled === true",
  );
  if (guarded !== true
    || state.mainFrameId !== frameId
    || state.documentGeneration !== documentGeneration) {
    throw new Error(AGENT_PAGE_WORLD_UNAVAILABLE);
  }
  return { contextId, documentGeneration };
}

export function agentPageIsFrozen(contents: WebContents): boolean {
  return frozenAgentPages.has(contents);
}

export async function evaluateInFrozenAgentPage(
  contents: WebContents,
  expression: string,
): Promise<unknown> {
  const frozen = frozenAgentPages.get(contents);
  const state = agentPageBoundaryStates.get(contents);
  if (!frozen
    || state?.documentGeneration !== frozen.documentGeneration
    || !contents.debugger.isAttached()) {
    throw new Error("The Browser page changed while it was frozen for evidence capture.");
  }
  return await evaluateInAgentPageWorld(contents, frozen.contextId, expression);
}

export async function setAgentPageFrozen(
  contents: WebContents,
  frozen: boolean,
): Promise<void> {
  if (!contents.debugger.isAttached()) {
    throw new Error("The Browser security debugger is unavailable.");
  }
  const generation = (agentPageFreezeGenerations.get(contents) ?? 0) + 1;
  agentPageFreezeGenerations.set(contents, generation);
  if (!frozen) {
    frozenAgentPages.delete(contents);
    await contents.debugger.sendCommand("Page.setWebLifecycleState", { state: "active" });
    return;
  }
  const state = agentPageBoundaryStates.get(contents);
  if (!state) throw new Error(AGENT_PAGE_WORLD_UNAVAILABLE);
  const world = await agentPageWorldContext(contents, state);
  if (agentPageFreezeGenerations.get(contents) !== generation) {
    throw new Error("The Browser evidence freeze was superseded.");
  }
  frozenAgentPages.set(contents, world);
  await contents.debugger.sendCommand("Page.setWebLifecycleState", { state: "frozen" });
}
