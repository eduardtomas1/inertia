import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageActivationBlocked,
  locateAgentPageRef,
  semanticPageSnapshot,
} from "../../src/main/preview-agent-page";
import { withFrontendBrowserAudit } from "../../src/server/runtime/frontend-browser-audit";

function bodyWithText(text: string) {
  const body = { firstChild: null as unknown, parentElement: null, tagName: "BODY" };
  body.firstChild = {
    nodeType: 3, nodeValue: text, parentElement: body, parentNode: body, nextSibling: null,
  };
  return body;
}

function iteratorFor(elements: readonly unknown[]) {
  return () => {
    let index = 0;
    return { nextNode: () => elements[index++] ?? null };
  };
}

function element(tagName: string, y: number, overrides: Record<string, unknown> = {}) {
  const attributes = (overrides.attributes ?? {}) as Record<string, string>;
  const node: Record<string, unknown> = {
    nodeType: 1, tagName, firstChild: null, parentElement: null, labels: [],
    readOnly: false, disabled: false, checked: undefined, isConnected: true,
    isContentEditable: false,
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => Object.hasOwn(attributes, name),
    matches: () => false,
    getBoundingClientRect: () => ({
      x: 10, y, left: 10, top: y, right: 210, bottom: y + 30, width: 200, height: 30,
    }),
    ...overrides,
  };
  node.contains = (candidate: unknown) => candidate === node;
  return node;
}

function page(elements: readonly unknown[], state?: Record<string, unknown>) {
  const context = {
    ...(state ? { __inertiaAgentBrowser: state } : {}),
    document: {
      title: "Coverage", body: bodyWithText("Visible page text"), documentElement: {},
      activeElement: null as unknown, createNodeIterator: iteratorFor(elements),
      elementFromPoint: (): unknown => null,
    },
    location: { href: "http://127.0.0.1:3000/coverage", protocol: "http:" }, URL, encodeURIComponent,
    innerWidth: 1_200, innerHeight: 800, scrollX: 0, scrollY: 0,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  };
  const contents = {
    executeJavaScriptInIsolatedWorld: vi.fn(async (
      _worldId: number,
      scripts: Array<{ code: string }>,
    ) => runInNewContext(scripts[0]!.code, context)),
  };
  return { contents, context };
}

describe("agent Browser page coverage", () => {
  it("omits the not-inspected list for a page that was read completely", async () => {
    const { contents } = page([element("BUTTON", 10, { type: "button", value: "" })]);
    const snapshot = JSON.parse(await semanticPageSnapshot(contents as never)) as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty("notInspected");
    expect(snapshot.truncated).toBe(false);
  });

  it("lists an embedded frame as a placeholder without a ref and never reads inside it", async () => {
    const contentDocument = vi.fn();
    const frame = element("IFRAME", 10, {
      attributes: { title: "Payment form", tabindex: "0", role: "button" },
      value: "frame-value",
    });
    Object.defineProperty(frame, "contentDocument", { get: contentDocument });
    Object.defineProperty(frame, "contentWindow", { get: contentDocument });
    const hiddenFrame = element("IFRAME", 900, { attributes: { title: "Offscreen frame" } });
    const button = element("BUTTON", 60, { type: "button", value: "" });
    const { contents } = page([frame, hiddenFrame, button]);

    const text = await semanticPageSnapshot(contents as never);
    const snapshot = JSON.parse(text) as {
      elements: Array<Record<string, unknown>>;
      notInspected: string[];
    };
    expect(snapshot.notInspected).toEqual(["frames"]);
    expect(snapshot.elements).toEqual([
      {
        role: "frame",
        name: "Payment form",
        notInspected: true,
        rect: { x: 10, y: 10, width: 200, height: 30 },
      },
      expect.objectContaining({ ref: "e1", role: "button" }),
    ]);
    expect(text).not.toContain("frame-value");
    expect(contentDocument).not.toHaveBeenCalled();
    const audited = JSON.parse(withFrontendBrowserAudit(text)) as {
      inertiaAudit: { checkedElements: number };
    };
    expect(audited.inertiaAudit.checkedElements).toBe(1);
  });

  it("caps frame placeholders while still reporting that frames exist", async () => {
    const frames = Array.from({ length: 20 }, (_value, index) => element("IFRAME", 10 + index));
    const { contents } = page(frames);
    const snapshot = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: unknown[];
      notInspected: string[];
    };
    expect(snapshot.elements).toHaveLength(16);
    expect(snapshot.notInspected).toEqual(["frames"]);
  });

  it("keeps shadow hosts clickable but never reads a value from them", async () => {
    const openHost = element("DIV", 10, {
      attributes: { role: "textbox", tabindex: "0" },
      shadowRoot: {},
      value: "open-host-secret",
    });
    const customElement = element("MY-INPUT", 50, {
      attributes: { tabindex: "0" },
      value: "custom-element-secret",
    });
    const nativeInput = element("INPUT", 90, { type: "text", value: "plain value" });
    const { contents } = page([openHost, customElement, nativeInput]);

    const text = await semanticPageSnapshot(contents as never);
    const snapshot = JSON.parse(text) as {
      elements: Array<{ ref: string; value?: string }>;
      notInspected: string[];
    };
    expect(snapshot.notInspected).toEqual(["shadow-roots"]);
    expect(snapshot.elements.map(({ ref, value }) => [ref, value])).toEqual([
      ["e1", undefined],
      ["e2", undefined],
      ["e3", "plain value"],
    ]);
    expect(text).not.toContain("open-host-secret");
    expect(text).not.toContain("custom-element-secret");
  });

  it("merges regions seen by the guard and by the debugger, and marks a bounded scan as truncated", async () => {
    const { contents } = page([element("BUTTON", 10, { type: "button", value: "" })], {
      refs: new Map(), nodes: new WeakMap(), passwordNodes: new WeakSet(),
      passwordValues: new Set(), next: 1,
      framesObserved: true, scanLimitReached: true,
    });
    const snapshot = JSON.parse(
      await semanticPageSnapshot(contents as never, ["shadow-roots", "frames"]),
    ) as { notInspected: string[]; truncated: boolean };
    expect(snapshot.notInspected).toEqual(["frames", "shadow-roots"]);
    expect(snapshot.truncated).toBe(true);
  });

  it("marks Chromium's failed-load page so it is never mistaken for the requested page", async () => {
    const { contents, context } = page([]);
    expect(JSON.parse(await semanticPageSnapshot(contents as never))).not.toHaveProperty("errorPage");
    context.location = { href: "chrome-error://chromewebdata/", protocol: "chrome-error:" } as never;
    expect(JSON.parse(await semanticPageSnapshot(contents as never))).toMatchObject({ errorPage: true });
  });

  it("refuses to click through a ref whose hit target is an embedded frame", async () => {
    const frame = element("IFRAME", 10);
    const link = element("A", 10, { attributes: { href: "/next" } });
    link.contains = (candidate: unknown) => candidate === link || candidate === frame;
    frame.parentElement = link;
    const { contents, context } = page([link], { refs: new Map([["e1", link]]) });
    context.document.elementFromPoint = () => frame;

    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toMatchObject({ found: true, blocked: true });
    context.document.elementFromPoint = () => link;
    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toMatchObject({ found: true, blocked: false });
  });

  it("reports activation as nested only while an embedded frame owns focus", async () => {
    const { contents, context } = page([]);
    context.document.activeElement = element("IFRAME", 10);
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBe("nested");
    context.document.activeElement = element("FRAME", 10);
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBe("nested");
    context.document.activeElement = element("BUTTON", 10, { type: "button" });
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBeNull();
  });
});
