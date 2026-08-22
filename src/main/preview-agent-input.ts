import type { WebContents } from "electron";

import { previewNavigationTarget } from "../shared/preview-url.js";

const INPUT_NAVIGATION_GRACE_MS = 250;
const NAVIGATION_TIMEOUT_MS = 30_000;

interface AgentPageBoundaryState {
  mainFrameId: string | null;
  nestedContentObserved: boolean;
}

const agentPageBoundaryStates = new WeakMap<WebContents, AgentPageBoundaryState>();
const agentPageDebuggerBootstraps = new WeakMap<WebContents, number>();

function stopForAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("browser-action-cancelled");
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
      enabled: true,
      cancel: true,
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

const fileChooserBlocks = new WeakMap<WebContents, Promise<void>>();

export function ensureAgentFileChooserBlock(contents: WebContents): Promise<void> {
  const existing = fileChooserBlocks.get(contents);
  if (existing) return existing;
  const ready = installAgentFileChooserBlock(contents);
  fileChooserBlocks.set(contents, ready);
  void ready.catch(() => undefined);
  return ready;
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
