import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageInputRefusal,
  installAgentPagePrivacyGuard,
  setAgentPageInputGuard,
} from "../../src/main/preview-agent-page";

type Listener = (event: Record<string, unknown>) => void;

function element(tagName: string, extra: Record<string, unknown> = {}) {
  return { nodeType: 1, tagName, isConnected: true, disabled: false, getAttribute: () => null, matches: () => false, ...extra };
}

async function guardedPage() {
  const listeners = new Map<string, Listener>();
  const body = { tagName: "BODY", parentElement: null, innerText: "", firstChild: null };
  const document = {
    title: "Board",
    body,
    documentElement: { nodeType: 1, tagName: "HTML", querySelectorAll: () => [] },
    activeElement: null,
    addEventListener: vi.fn(),
    querySelectorAll: () => [],
    elementFromPoint: () => null,
    createNodeIterator: () => ({ nextNode: () => null }),
  };
  class MutationObserver {
    constructor(_callback: (records: unknown[]) => void) {}
    observe(): void {}
  }
  const context: Record<string, unknown> = {
    document,
    MutationObserver,
    location: { href: "http://127.0.0.1:3000/board" },
    URL,
    encodeURIComponent,
    innerWidth: 1_200,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    addEventListener: vi.fn((name: string, listener: Listener) => { listeners.set(name, listener); }),
  };
  const contents = {
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, scripts: Array<{ code: string }>) =>
      runInNewContext(scripts[0]!.code, context)),
  };
  await installAgentPagePrivacyGuard(contents as never);
  const card = element("DIV");
  const column = element("DIV");
  const board = element("MAIN");
  const state = context.__inertiaAgentBrowser as { refs: Map<string, unknown> };
  state.refs.set("e1", card);
  state.refs.set("e2", column);
  const fire = (name: string, path: unknown[]) => {
    const preventDefault = vi.fn();
    const stopImmediatePropagation = vi.fn();
    listeners.get(name)?.({ isTrusted: true, composedPath: () => path, preventDefault, stopImmediatePropagation });
    return preventDefault.mock.calls.length > 0 && stopImmediatePropagation.mock.calls.length > 0;
  };
  return { contents, listeners, card, column, board, fire };
}

describe("agent input guard for double clicks and drags", () => {
  it("matches a double click to the clicked ref like its presses", async () => {
    const page = await guardedPage();
    await setAgentPageInputGuard(page.contents as never, true, "e1");
    expect(page.listeners.has("dblclick")).toBe(true);
    expect(page.fire("dblclick", [page.card, page.board])).toBe(false);
    await expect(agentPageInputRefusal(page.contents as never)).resolves.toBeNull();
    expect(page.fire("dblclick", [page.column, page.board])).toBe(true);
    await expect(agentPageInputRefusal(page.contents as never)).resolves.toBe("retargeted");
  });

  it("matches only the press of a drag, so the release can land on the dragged element", async () => {
    const page = await guardedPage();
    await setAgentPageInputGuard(page.contents as never, true, "e1", true);
    expect(page.fire("mousedown", [page.card, page.board])).toBe(false);
    expect(page.fire("mouseup", [page.card, page.board])).toBe(false);
    expect(page.fire("mouseup", [element("SPAN"), page.board])).toBe(false);
    expect(page.fire("click", [page.board])).toBe(false);
    await expect(agentPageInputRefusal(page.contents as never)).resolves.toBeNull();
  });

  it("refuses a drag that presses another element, and a drag click on a file input", async () => {
    const page = await guardedPage();
    await setAgentPageInputGuard(page.contents as never, true, "e1", true);
    expect(page.fire("mousedown", [page.column, page.board])).toBe(true);
    await expect(agentPageInputRefusal(page.contents as never)).resolves.toBe("retargeted");

    await setAgentPageInputGuard(page.contents as never, true, "e1", true);
    expect(page.fire("click", [element("INPUT", { type: "file" }), page.board])).toBe(true);
    await expect(agentPageInputRefusal(page.contents as never)).resolves.toBe("file");
  });

  it("matches every press again once the drag guard is replaced by a click guard", async () => {
    const page = await guardedPage();
    await setAgentPageInputGuard(page.contents as never, true, "e1", true);
    await setAgentPageInputGuard(page.contents as never, true, "e1");
    expect(page.fire("mouseup", [page.column, page.board])).toBe(true);
    await expect(agentPageInputRefusal(page.contents as never)).resolves.toBe("retargeted");
  });
});
