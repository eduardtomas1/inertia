import type { WebContents } from "electron";

import { previewNavigationTarget } from "../shared/preview-url.js";

const INPUT_NAVIGATION_GRACE_MS = 250;
const NAVIGATION_TIMEOUT_MS = 30_000;

function stopForAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("browser-action-cancelled");
}

export async function installAgentFileChooserBlock(contents: WebContents): Promise<void> {
  if (contents.debugger.isAttached()) {
    throw new Error("The Browser page is already attached to another debugger.");
  }
  contents.debugger.attach("1.3");
  try {
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

const fileChooserBlocks = new WeakMap<WebContents, Promise<void>>();

export function ensureAgentFileChooserBlock(contents: WebContents): Promise<void> {
  const existing = fileChooserBlocks.get(contents);
  if (existing) return existing;
  const ready = installAgentFileChooserBlock(contents);
  fileChooserBlocks.set(contents, ready);
  void ready.catch(() => undefined);
  return ready;
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
      if (navigationStarted ? navigationSettled : graceElapsed) finish();
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
        finish(error instanceof Error ? error : new Error("The Browser input failed."));
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("The Browser input failed."));
    }
  });
}
