import type { WebContents } from "electron";

import type { AgentBrowserResult } from "../shared/agent-browser.js";
import { previewNavigationTarget } from "../shared/preview-url.js";
import { AgentBrowserRefusal } from "./preview-agent-action.js";
import { navigationFailureMessage } from "./preview-agent-messages.js";
import { failedAgentBrowserResult as failure } from "./preview-agent-result.js";

export type AgentHistoryDirection = "back" | "forward" | "reload";

const NOT_LOCAL_HISTORY_MESSAGE = "The history entry Chromium opened is not a local development page, so Inertia stopped it. Navigate to a local URL instead.";

const SCHEMELESS_LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/iu;
const CANCELLED_HISTORY_MESSAGE = "The page navigation was cancelled before a page loaded, usually because it redirected to an address outside this machine. The tab still shows its previous page.";

export function withLoopbackScheme(url: string): string {
  return SCHEMELESS_LOOPBACK.test(url) ? `http://${url}` : url;
}

function localPage(url: string | undefined): boolean {
  try {
    return previewNavigationTarget(url).kind === "embed";
  } catch {
    return false;
  }
}

export function agentHistoryRefusal(
  contents: WebContents,
  direction: AgentHistoryDirection,
): AgentBrowserResult | null {
  const history = contents.navigationHistory;
  if (direction === "reload") {
    return localPage(contents.getURL())
      ? null
      : failure("invalid", "This tab is not showing a local page to reload. Navigate to a URL instead.");
  }
  const back = direction === "back";
  const available = back ? history.canGoBack() : history.canGoForward();
  const target = available
    ? history.getEntryAtIndex(history.getActiveIndex() + (back ? -1 : 1))?.url
    : undefined;
  if (localPage(target)) return null;
  return failure(
    "invalid",
    back
      ? "There is no earlier local page in this tab's history. Navigate to a URL instead."
      : "There is no later local page in this tab's history. Navigate to a URL instead.",
  );
}

export async function agentHistoryNavigation(
  contents: WebContents,
  direction: "back" | "forward",
  scope: { signal: AbortSignal; inputSent: boolean },
  waitMs: number,
): Promise<boolean> {
  const { signal } = scope;
  const previousUrl = contents.getURL();
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.removeListener("did-stop-loading", onStopped);
      contents.removeListener("did-navigate", onNavigated);
      contents.removeListener("did-navigate-in-page", onInPage);
      contents.removeListener("did-fail-load", onFailed);
      contents.removeListener("destroyed", onDestroyed);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onStopped = (): void => finish(() => resolve(true));
    const refuseRemote = (url: string): boolean => {
      if (localPage(url)) return false;
      finish(() => {
        if (!contents.isDestroyed()) contents.stop();
        reject(new AgentBrowserRefusal(failure("unavailable", NOT_LOCAL_HISTORY_MESSAGE)));
      });
      return true;
    };
    const onNavigated = (_event: unknown, url: string): void => {
      if (refuseRemote(url)) return;
      if (!contents.isLoading()) finish(() => resolve(true));
    };
    const onInPage = (_event: unknown, url: string, isMainFrame: boolean): void => {
      if (!isMainFrame || refuseRemote(url)) return;
      finish(() => resolve(true));
    };
    const onFailed = (
      _event: unknown,
      errorCode: number,
      description: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return;
      if (errorCode === -3) {
        finish(() => {
          if (contents.isDestroyed() || contents.isLoading() || contents.getURL() !== previousUrl) resolve(false);
          else reject(new AgentBrowserRefusal(failure("unavailable", CANCELLED_HISTORY_MESSAGE)));
        });
        return;
      }
      finish(() => reject(new AgentBrowserRefusal(
        failure("unavailable", navigationFailureMessage(new Error(description))),
      )));
    };
    const onDestroyed = (): void => finish(() => reject(
      new Error("The active Browser tab was closed during navigation."),
    ));
    const onAbort = (): void => finish(() => {
      if (!contents.isDestroyed()) contents.stop();
      reject(new Error("browser-action-cancelled"));
    });
    const timer = setTimeout(() => finish(() => resolve(false)), waitMs);
    timer.unref();
    contents.on("did-stop-loading", onStopped);
    contents.on("did-navigate", onNavigated);
    contents.on("did-navigate-in-page", onInPage);
    contents.on("did-fail-load", onFailed);
    contents.once("destroyed", onDestroyed);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      scope.inputSent = true;
      if (direction === "back") contents.navigationHistory.goBack();
      else contents.navigationHistory.goForward();
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error("The Browser navigation failed.")));
    }
  });
}
