import type { WebContents } from "electron";

import { previewNavigationTarget } from "../shared/preview-url.js";
import { locateAgentPageRef, type PreviewAgentTarget, waitForAgentPageHover } from "./preview-agent-page.js";

const INPUT_NAVIGATION_GRACE_MS = 250;
const HOVER_INPUT_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const FILE_CHOOSER_ACTIVATION_POLL_MS = 100;
const FILE_CHOOSER_ACTIVATION_LIMIT_MS = 10_000;

interface AgentPageBoundaryState {
  mainFrameId: string | null;
  nestedContentObserved: boolean;
}

const agentPageBoundaryStates = new WeakMap<WebContents, AgentPageBoundaryState>();
const agentPageDebuggerBootstraps = new WeakMap<WebContents, number>();

function stopForAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("browser-action-cancelled");
}

async function dispatchAgentPageHover(
  contents: WebContents,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<void> {
  stopForAbort(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      contents.removeListener("input-event", onInput);
      contents.removeListener("destroyed", onDestroyed);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onInput = (_event: unknown, input: { type?: string; x?: number; y?: number }): void => {
      if (input.type === "mouseMove" && Math.round(input.x ?? NaN) === Math.round(x)
          && Math.round(input.y ?? NaN) === Math.round(y)) finish();
    };
    const onDestroyed = (): void => finish(new Error("The active Browser tab closed during hover."));
    const onAbort = (): void => finish(new Error("browser-action-cancelled"));
    const timeout = setTimeout(
      () => finish(new Error("The Browser page did not acknowledge the hover.")),
      HOVER_INPUT_TIMEOUT_MS,
    );
    timeout.unref();
    contents.on("input-event", onInput);
    contents.once("destroyed", onDestroyed);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (contents.isDestroyed()) finish(new Error("The active Browser tab closed before hover."));
      else contents.sendInputEvent({ type: "mouseMove", x, y });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("The Browser hover failed."));
    }
  });
}

export async function hoverAgentPageRef(
  contents: WebContents,
  ref: string,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<PreviewAgentTarget> {
  let hoverX = x;
  let hoverY = y;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dispatchAgentPageHover(contents, hoverX, hoverY, signal);
    stopForAbort(signal);
    await waitForAgentPageHover(contents);
    stopForAbort(signal);
    const target = await locateAgentPageRef(contents, ref);
    if (!target.found || target.x === undefined || target.y === undefined) return target;
    if (Math.round(target.x) === Math.round(hoverX)
        && Math.round(target.y) === Math.round(hoverY)) return target;
    hoverX = target.x;
    hoverY = target.y;
  }
  stopForAbort(signal);
  return { found: false };
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

interface AgentFileChooserBlock {
  generation: number;
  ready: Promise<void>;
}

const fileChooserBlocks = new WeakMap<WebContents, AgentFileChooserBlock>();

function agentFileChooserBlock(contents: WebContents): AgentFileChooserBlock {
  const existing = fileChooserBlocks.get(contents);
  if (existing) return existing;
  const state: AgentFileChooserBlock = {
    generation: 0,
    ready: installAgentFileChooserBlock(contents),
  };
  fileChooserBlocks.set(contents, state);
  void state.ready.catch(() => undefined);
  return state;
}

export function ensureAgentFileChooserBlock(contents: WebContents): Promise<void> {
  return agentFileChooserBlock(contents).ready;
}

export async function beginAgentFileChooserBlock(contents: WebContents): Promise<number> {
  const state = agentFileChooserBlock(contents);
  await state.ready;
  state.generation += 1;
  const generation = state.generation;
  await contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", {
    enabled: true,
    cancel: true,
  });
  return generation;
}

function chooserPollDelay(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, FILE_CHOOSER_ACTIVATION_POLL_MS);
    timeout.unref();
  });
}

/**
 * Keep indirect chooser callbacks blocked only while Chromium can still use
 * the transient activation created by this exact agent input. Once that
 * causal capability expires, restore the ordinary native chooser for human
 * interaction without detaching the debugger used by the evidence boundary.
 */
export async function releaseAgentFileChooserBlock(
  contents: WebContents,
  generation: number,
  hasTransientUserActivation: () => Promise<boolean>,
): Promise<void> {
  const state = fileChooserBlocks.get(contents);
  if (!state) return;
  const deadline = Date.now() + FILE_CHOOSER_ACTIVATION_LIMIT_MS;
  while (state.generation === generation && !contents.isDestroyed()) {
    let active = true;
    try {
      active = await hasTransientUserActivation();
    } catch {
      // Keep the boundary fail-closed until the bounded activation window ends.
    }
    if (!active || Date.now() >= deadline) break;
    await chooserPollDelay();
  }
  if (state.generation !== generation || contents.isDestroyed()) return;
  await contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", {
    enabled: false,
  });
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Browser evidence currently has document-start credential ownership only for
 * the top-level document. Fail closed when a page contains author-controlled
 * nested documents or shadow roots rather than capture pixels from an
 * unguarded DOM boundary. User-agent shadow roots are excluded because their
 * contents are owned by Chromium, not the page.
 */
export function hasUnguardedAgentPageContent(
  frameTreeResult: unknown,
  snapshotResult: unknown,
): boolean {
  const frameTree = objectRecord(objectRecord(frameTreeResult)?.frameTree);
  if (!frameTree) return true;
  const childFrames = frameTree.childFrames;
  if (childFrames !== undefined && (!Array.isArray(childFrames) || childFrames.length > 0)) {
    return true;
  }

  const snapshot = objectRecord(snapshotResult);
  const strings = snapshot?.strings;
  const documents = snapshot?.documents;
  if (!Array.isArray(strings) || !strings.every((value) => typeof value === "string")
      || !Array.isArray(documents)) return true;
  for (const document of documents) {
    const nodes = objectRecord(objectRecord(document)?.nodes);
    const shadowRootType = objectRecord(nodes?.shadowRootType);
    if (!shadowRootType) continue;
    const indexes = shadowRootType.index;
    const values = shadowRootType.value;
    if (!Array.isArray(indexes) || !Array.isArray(values) || indexes.length !== values.length) {
      return true;
    }
    for (const value of values) {
      if (!Number.isInteger(value)) return true;
      const type = strings[value as number];
      if (type === "open" || type === "closed") return true;
    }
  }
  return false;
}

export async function agentPageHasUnguardedNestedContent(
  contents: WebContents,
): Promise<boolean> {
  if (agentPageBoundaryStates.get(contents)?.nestedContentObserved !== false) return true;
  if (!contents.debugger.isAttached()) {
    throw new Error("The Browser security debugger is unavailable.");
  }
  const frameTree = await contents.debugger.sendCommand("Page.getFrameTree");
  const snapshot = await contents.debugger.sendCommand("DOMSnapshot.captureSnapshot", {
    computedStyles: [],
    includeDOMRects: false,
    includePaintOrder: false,
  });
  return hasUnguardedAgentPageContent(frameTree, snapshot);
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

export async function settleAgentPageInput(
  contents: WebContents,
  dispatch: () => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  stopForAbort(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let dispatchSettled = false;
    let dispatchError: Error | undefined;
    let navigationStarted = false;
    let navigationSettled = false;
    let graceElapsed = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (grace) clearTimeout(grace);
      clearTimeout(timeout);
      contents.removeListener("did-start-navigation", onStarted);
      contents.removeListener("did-navigate-in-page", onInPage);
      contents.removeListener("did-stop-loading", onStopped);
      contents.removeListener("did-fail-load", onFailed);
      contents.removeListener("destroyed", onDestroyed);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error, stop = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stop && navigationStarted && !contents.isDestroyed()) contents.stop();
      if (error) reject(error);
      else resolve();
    };
    const completeIfReady = (): void => {
      if (!dispatchSettled) return;
      if (navigationStarted ? navigationSettled : graceElapsed) finish(dispatchError);
    };
    const armGrace = (): void => {
      if (settled || navigationStarted || grace) return;
      grace = setTimeout(() => {
        graceElapsed = true;
        completeIfReady();
      }, INPUT_NAVIGATION_GRACE_MS);
      grace.unref();
    };
    const onStarted = (
      details: { isMainFrame?: boolean; isSameDocument?: boolean; url?: string },
      legacyUrl?: string,
      legacyInPlace?: boolean,
      legacyMainFrame?: boolean,
    ): void => {
      const isMainFrame = typeof details.isMainFrame === "boolean"
        ? details.isMainFrame
        : legacyMainFrame === true;
      if (!isMainFrame) return;
      const url = typeof details.url === "string" ? details.url : legacyUrl ?? "";
      try {
        if (previewNavigationTarget(url).kind !== "embed") {
          navigationStarted = true;
          navigationSettled = true;
          if (grace) clearTimeout(grace);
          completeIfReady();
          return;
        }
      } catch {
        navigationStarted = true;
        navigationSettled = true;
        if (grace) clearTimeout(grace);
        completeIfReady();
        return;
      }
      navigationStarted = true;
      if (grace) clearTimeout(grace);
      const sameDocument = typeof details.isSameDocument === "boolean"
        ? details.isSameDocument
        : legacyInPlace === true;
      if (sameDocument && contents.getURL() === url) {
        navigationSettled = true;
        completeIfReady();
      }
    };
    const onInPage = (_event: unknown, _url: string, isMainFrame: boolean): void => {
      if (!navigationStarted || !isMainFrame) return;
      navigationSettled = true;
      completeIfReady();
    };
    const onStopped = (): void => {
      if (!navigationStarted) return;
      navigationSettled = true;
      completeIfReady();
    };
    const onFailed = (
      _event: unknown,
      _errorCode: number,
      description: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (navigationStarted && isMainFrame) {
        finish(new Error(`The Browser page failed after the input: ${description}`));
      }
    };
    const onDestroyed = (): void => finish(
      new Error("The active Browser tab was closed after the input."),
    );
    const onAbort = (): void => finish(new Error("browser-action-cancelled"), true);
    const timeout = setTimeout(() => finish(
      new Error("The Browser page did not settle after the input."),
      true,
    ), NAVIGATION_TIMEOUT_MS);
    timeout.unref();
    contents.on("did-start-navigation", onStarted);
    contents.on("did-navigate-in-page", onInPage);
    contents.on("did-stop-loading", onStopped);
    contents.on("did-fail-load", onFailed);
    contents.once("destroyed", onDestroyed);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (contents.isDestroyed()) {
        finish(new Error("The active Browser tab was closed before the input."));
        return;
      }
      void Promise.resolve(dispatch()).then(() => {
        dispatchSettled = true;
        if (navigationStarted) completeIfReady();
        else armGrace();
      }, (error: unknown) => {
        dispatchSettled = true;
        dispatchError = error instanceof Error ? error : new Error("The Browser input failed.");
        if (navigationStarted) completeIfReady();
        else armGrace();
      });
    } catch (error) {
      dispatchSettled = true;
      dispatchError = error instanceof Error ? error : new Error("The Browser input failed.");
      armGrace();
    }
  });
}
