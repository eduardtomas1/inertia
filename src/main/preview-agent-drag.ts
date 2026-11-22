import type { WebContents } from "electron";

import { stopForAbort } from "./preview-agent-action.js";
import { agentPageIsFrozen, evaluateInFrozenAgentPage } from "./preview-agent-boundary.js";
import { sendAgentPageInput } from "./preview-agent-control.js";
import { AGENT_BROWSER_WORLD_ID, agentPageInputRefusal, waitForAgentPageHover } from "./preview-agent-page.js";
import type { AgentPagePointMap } from "./preview-agent-viewport.js";

/** Pointer moves between press and release; drag libraries need several to pass their thresholds. */
export const AGENT_PAGE_DRAG_STEPS = 5;
const DRAG_INTERCEPT_TIMEOUT_MS = 2_000;
const MAX_DRAG_ITEMS = 64;
const MAX_DRAG_ITEM_CHARS = 1_048_576;

type Point = { x: number; y: number };

/**
 * How the page took the drag: its own pointer handlers, native HTML drag and
 * drop, the guard refused the press, or the drop target changed during the
 * drag and nothing was dropped on it.
 */
export type AgentPageDragOutcome = "pointer" | "native" | "refused" | "retargeted";

/**
 * Checks the drop target again just before the drop and returns where it is
 * now, or null when it is gone, out of view or no longer the approved one.
 */
export type AgentPageDropCheck = (native: boolean) => Promise<Point | null>;

interface AgentPageDragItem {
  mimeType: string;
  data: string;
  title?: string;
  baseURL?: string;
}

interface AgentPageDragData {
  items: AgentPageDragItem[];
  dragOperationsMask: number;
}

const WATCH_DRAG_START = `(() => {
  const state = globalThis.__inertiaAgentBrowser;
  if (state?.privacyGuardInstalled !== true) return false;
  state.agentDragWatchStop?.();
  state.agentDragStart = undefined;
  const listener = (event) => { if (event.isTrusted === true) state.agentDragStart = event; };
  addEventListener("dragstart", listener, true);
  state.agentDragWatchStop = () => {
    removeEventListener("dragstart", listener, true);
    state.agentDragWatchStop = undefined;
    state.agentDragStart = undefined;
  };
  return true;
})()`;
// Read after the page's own dragstart handlers ran: a cancelled dragstart starts no drag.
const DRAG_STARTED = `(() => {
  const event = globalThis.__inertiaAgentBrowser?.agentDragStart;
  return Boolean(event) && event.defaultPrevented !== true;
})()`;
const STOP_DRAG_WATCH = "globalThis.__inertiaAgentBrowser?.agentDragWatchStop?.(), true";

async function execute(contents: WebContents, code: string): Promise<unknown> {
  if (agentPageIsFrozen(contents)) return await evaluateInFrozenAgentPage(contents, code);
  return await contents.executeJavaScriptInIsolatedWorld(AGENT_BROWSER_WORLD_ID, [{ code }], true);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

/**
 * Keep only the page's own string items. Files are dropped, so a drop can
 * never carry a file into the page, and nothing here reaches the agent.
 */
function dragData(value: unknown): AgentPageDragData | null {
  const data = typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  if (!data || !Array.isArray(data.items) || typeof data.dragOperationsMask !== "number") return null;
  const items = data.items.slice(0, MAX_DRAG_ITEMS).flatMap((entry): AgentPageDragItem[] => {
    const item = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : null;
    if (!item || !text(item.mimeType, 256) || !text(item.data, MAX_DRAG_ITEM_CHARS)) return [];
    return [{
      mimeType: item.mimeType,
      data: item.data,
      ...(text(item.title, 4_096) ? { title: item.title } : {}),
      ...(text(item.baseURL, 4_096) ? { baseURL: item.baseURL } : {}),
    }];
  });
  return { items, dragOperationsMask: data.dragOperationsMask };
}

/** Resolves with the next drag Chromium intercepted instead of starting a system drag. */
function interceptAgentPageDrags(contents: WebContents) {
  const intercepted: AgentPageDragData[] = [];
  let waiting: ((data: AgentPageDragData) => void) | null = null;
  const listener = (_event: unknown, method: string, params: unknown, sessionId?: string): void => {
    if (method !== "Input.dragIntercepted" || sessionId) return;
    const data = dragData((params as { data?: unknown } | undefined)?.data);
    if (!data) return;
    if (waiting) waiting(data);
    else intercepted.push(data);
  };
  contents.debugger.on("message", listener);
  return {
    next(signal?: AbortSignal): Promise<AgentPageDragData> {
      const ready = intercepted.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const finish = (error?: Error, data?: AgentPageDragData): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          waiting = null;
          if (error) reject(error);
          else resolve(data!);
        };
        const onAbort = (): void => finish(new Error("browser-action-cancelled"));
        const timer = setTimeout(
          () => finish(new Error("The page started a drag that Inertia could not take over.")),
          DRAG_INTERCEPT_TIMEOUT_MS,
        );
        timer.unref();
        waiting = (data) => finish(undefined, data);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    dispose(): void {
      contents.debugger.removeListener("message", listener);
    },
  };
}

function along(from: Point, to: Point, step: number): Point {
  return {
    x: from.x + ((to.x - from.x) * step) / AGENT_PAGE_DRAG_STEPS,
    y: from.y + ((to.y - from.y) * step) / AGENT_PAGE_DRAG_STEPS,
  };
}

/**
 * Press on `from`, move in steps and release on `to`, in page CSS pixels.
 * Chromium is told to intercept drags first, so a native HTML drag never
 * starts a system drag session that would wait for the user's real mouse:
 * once the page's dragstart goes through, the rest of the drag is finished
 * with DevTools drag events carrying the page's own drag data.
 */
export async function performAgentPageDrag(
  contents: WebContents,
  from: Point,
  to: Point,
  map: AgentPagePointMap,
  confirmDrop: AgentPageDropCheck,
  signal?: AbortSignal,
): Promise<AgentPageDragOutcome> {
  stopForAbort(signal);
  const interception = interceptAgentPageDrags(contents);
  let data: AgentPageDragData | null = null;
  let pressed = false;
  let last = from;
  const dragEvent = async (type: "dragEnter" | "dragOver" | "drop" | "dragCancel", point: Point): Promise<void> => {
    await contents.debugger.sendCommand("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data });
  };
  const release = (point: Point): void => {
    pressed = false;
    sendAgentPageInput(contents, { type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 }, map);
  };
  try {
    await contents.debugger.sendCommand("Input.setInterceptDrags", { enabled: true });
    if (await execute(contents, WATCH_DRAG_START) !== true) throw new Error("The Browser privacy guard is unavailable.");
    stopForAbort(signal);
    pressed = true;
    sendAgentPageInput(contents, {
      type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1, modifiers: ["leftbuttondown"],
    }, map);
    await waitForAgentPageHover(contents);
    if (await agentPageInputRefusal(contents)) {
      release(from);
      return "refused";
    }
    for (let step = 1; step <= AGENT_PAGE_DRAG_STEPS; step += 1) {
      stopForAbort(signal);
      const point = along(from, to, step);
      last = point;
      if (data) {
        await dragEvent("dragOver", point);
        continue;
      }
      sendAgentPageInput(contents, {
        type: "mouseMove", x: point.x, y: point.y, button: "left", modifiers: ["leftbuttondown"],
      }, map);
      await waitForAgentPageHover(contents);
      if (await execute(contents, DRAG_STARTED) === true) {
        data = await interception.next(signal);
        await dragEvent("dragEnter", point);
      }
    }
    stopForAbort(signal);
    // The page may have moved or replaced the target while it took the drag.
    const drop = await confirmDrop(data !== null);
    stopForAbort(signal);
    const moved = drop !== null && (drop.x !== last.x || drop.y !== last.y);
    if (data) {
      if (!drop) return "retargeted";
      if (moved) await dragEvent("dragOver", drop);
      await dragEvent("drop", drop);
      data = null;
      pressed = false;
      return "native";
    }
    if (!drop) {
      // Give the element back where it came from rather than drop it elsewhere.
      release(from);
      return "retargeted";
    }
    if (moved) {
      sendAgentPageInput(contents, {
        type: "mouseMove", x: drop.x, y: drop.y, button: "left", modifiers: ["leftbuttondown"],
      }, map);
      await waitForAgentPageHover(contents);
    }
    release(drop);
    return "pointer";
  } finally {
    // Never leave the page mid-drag or holding the button, and give real
    // drags back to the user.
    if (!contents.isDestroyed()) {
      if (data) await dragEvent("dragCancel", last).catch(() => undefined);
      else if (pressed) {
        try {
          release(last);
        } catch {
          // The page is gone or the point left the view; nothing is held.
        }
      }
      await execute(contents, STOP_DRAG_WATCH).catch(() => undefined);
      await contents.debugger.sendCommand("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
    }
    interception.dispose();
  }
}
