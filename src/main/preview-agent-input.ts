import type { WebContents } from "electron";

import { previewNavigationTarget } from "../shared/preview-url.js";
import { AGENT_BROWSER_WORLD_ID, locateAgentPageRef, type PreviewAgentTarget, waitForAgentPageHover } from "./preview-agent-page.js";
import { installAgentFileChooserBlock } from "./preview-agent-boundary.js";

export {
  agentPageHasUnguardedNestedContent,
  hasUnguardedAgentPageContent,
  installAgentFileChooserBlock,
  setAgentPageFrozen,
  settleAgentPageDebuggerBootstrap,
} from "./preview-agent-boundary.js";

const INPUT_NAVIGATION_GRACE_MS = 250;
const HOVER_INPUT_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const FILE_CHOOSER_ACTIVATION_POLL_MS = 100;
const FILE_CHOOSER_ACTIVATION_LIMIT_MS = 10_000;

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
): Promise<void> {
  const state = fileChooserBlocks.get(contents);
  if (!state) return;
  const deadline = Date.now() + FILE_CHOOSER_ACTIVATION_LIMIT_MS;
  while (state.generation === generation && !contents.isDestroyed()) {
    let active = true;
    try {
      active = await contents.executeJavaScriptInIsolatedWorld(
        AGENT_BROWSER_WORLD_ID,
        [{ code: "navigator.userActivation?.isActive === true" }],
        true,
      ) === true;
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
