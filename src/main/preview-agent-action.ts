import type { Rectangle, WebContents } from "electron";
import type { AgentBrowserResult } from "../shared/agent-browser.js";
import { failedAgentBrowserResult as failure } from "./preview-agent-result.js";

export class AgentBrowserRefusal extends Error {
  constructor(readonly result: AgentBrowserResult) {
    super(result.ok ? "The Browser action was refused." : result.message);
  }
}

export function changedGeometry(): AgentBrowserResult {
  return failure(
    "not-found",
    "The Browser page layout changed during this action. Inspect the page again for current refs.",
  );
}

export function sameBounds(left: Rectangle | null, right: Rectangle): boolean { return left !== null && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height; }
export function providerVisiblePageUrl(value: string): string { try { return new URL("/", value).origin; } catch { return ""; } }
export function stopForAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("browser-action-cancelled"); }

const PREVIEW_NAVIGATION_COMMAND_TIMEOUT_MS = 30_000;

export async function waitForNavigationCommand(
  contents: WebContents,
  dispatch: () => void,
  inPageTargetUrl?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      contents.removeListener("did-stop-loading", onStopped);
      contents.removeListener("did-navigate-in-page", onInPage);
      contents.removeListener("destroyed", onDestroyed);
      if (error) reject(error);
      else resolve();
    };
    const onStopped = (): void => finish();
    const onInPage = (
      _event: unknown,
      url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame && inPageTargetUrl && url === inPageTargetUrl) finish();
    };
    const onDestroyed = (): void => finish(
      new Error("The active Browser tab was closed during navigation."),
    );
    const timeout = setTimeout(() => {
      finish(new Error("The Browser navigation command timed out."));
      if (!contents.isDestroyed()) contents.stop();
    }, PREVIEW_NAVIGATION_COMMAND_TIMEOUT_MS);
    contents.once("did-stop-loading", onStopped);
    if (inPageTargetUrl) contents.on("did-navigate-in-page", onInPage);
    contents.once("destroyed", onDestroyed);
    try {
      if (contents.isDestroyed()) {
        finish(new Error("The active Browser tab was closed before navigation."));
        return;
      }
      dispatch();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("The Browser navigation command failed."));
    }
  });
}
