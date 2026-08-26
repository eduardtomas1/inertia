import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageActivationBlocked,
  agentPageRefHasFocus,
  installAgentPagePrivacyGuard,
  locateAgentPageRef,
  semanticPageSnapshot,
  setAgentPageInputGuard,
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

describe("agent Browser semantic audit inputs", () => {
  it("preserves native editability and subpixel geometry while excluding hidden names", async () => {
    const native = (tagName: "INPUT" | "TEXTAREA", y: number) => ({
      nodeType: 1, tagName, type: "text", value: "draft", labels: [], firstChild: null,
      parentElement: null, readOnly: false, disabled: false, checked: undefined,
      getAttribute: (name: string) => name === "role" ? "region" : null,
      hasAttribute: (name: string) => name === "role", matches: () => false,
      getBoundingClientRect: () => ({
        x: 10, y, left: 10, top: y, right: 210, bottom: y + 30, width: 200, height: 30,
      }),
    });
    const input = native("INPUT", 10);
    const textarea = native("TEXTAREA", 50);
    const readonlyInput = { ...native("INPUT", 90), readOnly: true };
    const checkbox = { ...native("INPUT", 130), type: "checkbox" };
    const hiddenText = {
      nodeType: 3, nodeValue: "×", parentElement: null as unknown,
      parentNode: null as unknown, nextSibling: null,
    };
    const hidden = {
      nodeType: 1, tagName: "SPAN", hidden: false, firstChild: hiddenText,
      parentElement: null as unknown, parentNode: null as unknown, nextSibling: null,
      getAttribute: (name: string) => name === "aria-hidden" ? "true" : null,
      hasAttribute: (name: string) => name === "aria-hidden",
    };
    const button = {
      nodeType: 1, tagName: "BUTTON", type: "button", value: "", firstChild: hidden,
      parentElement: null as unknown, readOnly: false, isContentEditable: false,
      disabled: false, checked: undefined, isConnected: true,
      getAttribute: (name: string) => name === "role" ? "region" : null,
      hasAttribute: (name: string) => name === "role", matches: () => false,
      contains: (candidate: unknown) => candidate === button || candidate === hidden,
      getBoundingClientRect: () => ({
        x: -0.4, y: 170, left: -0.4, top: 170,
        right: 23.2, bottom: 193.6, width: 23.6, height: 23.6,
      }),
    };
    hidden.parentElement = button;
    hidden.parentNode = button;
    hiddenText.parentElement = hidden;
    hiddenText.parentNode = hidden;
    const ariaHiddenButton = {
      ...button, firstChild: null, parentElement: null,
      getAttribute: (name: string) => ["aria-hidden", "role"].includes(name)
        ? name === "aria-hidden" ? "true" : "region"
        : null,
      hasAttribute: (name: string) => ["aria-hidden", "role"].includes(name),
    };
    const visibleImage = {
      nodeType: 1, tagName: "IMG", hidden: false, firstChild: null,
      parentElement: null as unknown, parentNode: null as unknown, nextSibling: null,
      getAttribute: (name: string) => name === "alt" ? "Checkout" : null,
    };
    const visibilityHiddenSpan = {
      nodeType: 1, tagName: "SPAN", hidden: false, firstChild: visibleImage,
      parentElement: null as unknown, parentNode: null as unknown, nextSibling: null,
      getAttribute: () => null,
    };
    const imageButton = {
      ...button, firstChild: visibilityHiddenSpan, parentElement: null,
      getAttribute: () => null, hasAttribute: () => false,
      contains: (candidate: unknown) => [
        imageButton, visibilityHiddenSpan, visibleImage,
      ].some((value) => value === candidate),
      getBoundingClientRect: () => ({
        x: 40, y: 165, left: 40, top: 165,
        right: 140, bottom: 195, width: 100, height: 30,
      }),
    };
    visibilityHiddenSpan.parentElement = imageButton;
    visibilityHiddenSpan.parentNode = imageButton;
    visibleImage.parentElement = visibilityHiddenSpan;
    visibleImage.parentNode = visibilityHiddenSpan;
    const opacityText = {
      nodeType: 3, nodeValue: "Save", parentElement: null as unknown,
      parentNode: null as unknown, nextSibling: null,
    };
    const opacityTextSpan = {
      nodeType: 1, tagName: "SPAN", hidden: false, firstChild: opacityText,
      parentElement: null as unknown, parentNode: null as unknown, nextSibling: null,
      getAttribute: () => null, hasAttribute: () => false,
    };
    const opacityTextButton = {
      ...button, firstChild: opacityTextSpan, parentElement: null,
      getAttribute: () => null, hasAttribute: () => false,
      contains: (candidate: unknown) => [
        opacityTextButton, opacityTextSpan, opacityText,
      ].some((value) => value === candidate),
      getBoundingClientRect: () => ({
        x: 150, y: 10, left: 150, top: 10,
        right: 250, bottom: 40, width: 100, height: 30,
      }),
    };
    opacityTextSpan.parentElement = opacityTextButton;
    opacityTextSpan.parentNode = opacityTextButton;
    opacityText.parentElement = opacityTextSpan;
    opacityText.parentNode = opacityTextSpan;
    const opacityImage = {
      nodeType: 1, tagName: "IMG", hidden: false, firstChild: null,
      parentElement: null as unknown, parentNode: null as unknown, nextSibling: null,
      getAttribute: (name: string) => name === "alt" ? "Save" : null,
      hasAttribute: (name: string) => name === "alt",
    };
    const opacityImageButton = {
      ...button, firstChild: opacityImage, parentElement: null,
      getAttribute: () => null, hasAttribute: () => false,
      contains: (candidate: unknown) => [opacityImageButton, opacityImage]
        .some((value) => value === candidate),
      getBoundingClientRect: () => ({
        x: 150, y: 50, left: 150, top: 50,
        right: 250, bottom: 80, width: 100, height: 30,
      }),
    };
    opacityImage.parentElement = opacityImageButton;
    opacityImage.parentNode = opacityImageButton;
    const elements = [
      input, textarea, readonlyInput, checkbox, button, hidden, ariaHiddenButton,
      imageButton, visibilityHiddenSpan, visibleImage,
      opacityTextButton, opacityTextSpan, opacityImageButton, opacityImage,
    ];
    const visibilityHiddenParent = { parentElement: null };
    const body = bodyWithText("Visible page copy");
    const hiddenCopyText = {
      nodeType: 3, nodeValue: "Hidden page copy", parentElement: null as unknown,
      parentNode: null as unknown, nextSibling: null,
    };
    const hiddenCopy = {
      nodeType: 1, tagName: "SPAN", hidden: false, firstChild: hiddenCopyText,
      parentElement: body, parentNode: body, nextSibling: body.firstChild,
      getAttribute: (name: string) => name === "aria-hidden" ? "true" : null,
    };
    hiddenCopyText.parentElement = hiddenCopy;
    hiddenCopyText.parentNode = hiddenCopy;
    body.firstChild = hiddenCopy;
    const document = {
      title: "Native editors", body, documentElement: {},
      activeElement: null, createNodeIterator: iteratorFor(elements),
      elementFromPoint: (): unknown => button,
    };
    const context = {
      document, location: { href: "http://127.0.0.1:3000/editors" }, URL,
      encodeURIComponent, innerWidth: 320, innerHeight: 200, scrollX: 0, scrollY: 0,
      getComputedStyle: (element: unknown) => ({
        visibility: element === visibilityHiddenParent || element === visibilityHiddenSpan
          ? "hidden"
          : "visible",
        display: "block",
        opacity: element === opacityTextSpan || element === opacityImage ? "0" : "1",
      }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const snapshot = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: Array<{
        ref: string; role: string; actionable: boolean; editable: boolean;
        name: string; nameSource: string; rect: object;
      }>;
      text: string;
    };
    expect(snapshot.text).toBe("Visible page copy");
    expect(snapshot.elements).toHaveLength(8);
    expect(snapshot.elements.slice(0, 4).map(({ editable }) => editable))
      .toEqual([true, true, false, false]);
    expect(snapshot.elements[0]).toMatchObject({ role: "region", editable: true });
    expect(snapshot.elements[4]).toMatchObject({
      role: "region", actionable: true, editable: false, name: "", nameSource: "none",
      rect: { x: -0.4, y: 170, width: 23.6, height: 23.6 },
    });
    expect(snapshot.elements[5]).toMatchObject({ name: "Checkout", nameSource: "content" });
    expect(snapshot.elements.slice(6)).toMatchObject([
      { name: "Save", nameSource: "content" },
      { name: "Save", nameSource: "content" },
    ]);
    const audited = JSON.parse(withFrontendBrowserAudit(JSON.stringify(snapshot))) as {
      inertiaAudit: { issues: Array<{ code: string; refs: string[] }> };
    };
    expect(audited.inertiaAudit.issues.find(({ code }) => code === "missing-stable-name")?.refs)
      .toContain("e1");
    expect(audited.inertiaAudit.issues.find(({ code }) => code === "missing-stable-name")?.refs)
      .toContain("e5");
    expect(audited.inertiaAudit.issues.find(({ code }) => code === "missing-stable-name")?.refs)
      .not.toEqual(expect.arrayContaining(["e7", "e8"]));
    expect(audited.inertiaAudit.issues.find(({ code }) => code === "small-target")?.refs)
      .toContain("e5");
    expect(audited.inertiaAudit.issues.find(({ code }) => code === "clipped-control")?.refs)
      .toContain("e5");
    button.parentElement = visibilityHiddenParent;
    await expect(locateAgentPageRef(contents as never, "e5"))
      .resolves.toMatchObject({ found: true, editable: false, label: "element" });
    document.elementFromPoint = () => imageButton;
    await expect(locateAgentPageRef(contents as never, "e6"))
      .resolves.toMatchObject({ found: true, label: "Checkout" });
    document.elementFromPoint = () => opacityTextButton;
    await expect(locateAgentPageRef(contents as never, "e7"))
      .resolves.toMatchObject({ found: true, label: "Save" });
    document.elementFromPoint = () => opacityImageButton;
    await expect(locateAgentPageRef(contents as never, "e8"))
      .resolves.toMatchObject({ found: true, label: "Save" });
  });

  it("bounds aria-disabled before every snapshot and activation normalization", async () => {
    const hostile = "x".repeat(50_000);
    const text = {
      nodeType: 3, nodeValue: "Continue", parentElement: null as unknown,
      parentNode: null as unknown, nextSibling: null,
    };
    const button = {
      nodeType: 1, tagName: "BUTTON", type: "button", value: "", firstChild: text,
      parentElement: null, readOnly: false, isContentEditable: false,
      disabled: false, checked: undefined, isConnected: true,
      getAttribute: (name: string) => name === "aria-disabled" ? hostile : null,
      hasAttribute: (name: string) => name === "aria-disabled",
      matches: () => false, contains: (candidate: unknown) => candidate === button,
      getBoundingClientRect: () => ({
        x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30,
      }),
    };
    text.parentElement = button;
    text.parentNode = button;
    const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
    const documentListeners = new Map<
      string,
      Array<(event: Record<string, unknown>) => void>
    >();
    const addListener = (
      target: Map<string, Array<(event: Record<string, unknown>) => void>>,
      name: string,
      listener: (event: Record<string, unknown>) => void,
    ) => target.set(name, [...(target.get(name) ?? []), listener]);
    const document = {
      title: "Hostile attributes", body: bodyWithText(""), documentElement: {},
      activeElement: button, createNodeIterator: iteratorFor([button]),
      elementFromPoint: () => button,
      addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => {
        addListener(documentListeners, name, listener);
      },
    };
    class MutationObserver {
      constructor(_callback: (records: unknown[]) => void) {}
      observe(): void {}
    }
    const context = {
      document, MutationObserver,
      addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => {
        addListener(listeners, name, listener);
      },
      location: { href: "http://127.0.0.1:3000/hostile" }, URL, encodeURIComponent,
      innerWidth: 320, innerHeight: 200, scrollX: 0, scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    runInNewContext(`{
      const lower = String.prototype.toLowerCase;
      String.prototype.toLowerCase = function () {
        if (this.length > 4096) throw new Error("unbounded lowercase");
        return Reflect.apply(lower, this, []);
      };
    }`, context);
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const snapshot = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: Array<{ disabled: boolean }>;
    };
    expect(snapshot.elements[0]?.disabled).toBe(false);
    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toMatchObject({ found: true, disabled: false });
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBeNull();
    await installAgentPagePrivacyGuard(contents as never);
    await setAgentPageInputGuard(contents as never, true);
    const preventDefault = vi.fn();
    expect(() => listeners.get("keydown")?.[0]?.({
      composedPath: () => [button], isTrusted: true, key: "Enter",
      preventDefault, stopImmediatePropagation: vi.fn(),
    })).not.toThrow();
    expect(preventDefault).not.toHaveBeenCalled();
    const deepPath = Array.from({ length: 4_001 }, () => ({}));
    listeners.get("input")?.[0]?.({ composedPath: () => deepPath, isTrusted: true });
    expect(runInNewContext(
      "globalThis.__inertiaAgentBrowser.nestedContentObserved",
      context,
    )).toBe(true);
    const deepClickPrevented = vi.fn();
    documentListeners.get("click")?.[0]?.({
      composedPath: () => deepPath, isTrusted: true,
      preventDefault: deepClickPrevented, stopImmediatePropagation: vi.fn(),
    });
    expect(deepClickPrevented).toHaveBeenCalledOnce();
  });

  it("fails closed when focused open-shadow descent exceeds its budget", async () => {
    const chain = Array.from({ length: 4_002 }, () => ({
      isConnected: true,
      shadowRoot: undefined as unknown,
    }));
    for (let index = 0; index < chain.length - 1; index += 1) {
      chain[index]!.shadowRoot = { activeElement: chain[index + 1] };
    }
    const context = {
      document: { activeElement: chain[0] },
      __inertiaAgentBrowser: { refs: new Map([["e1", chain.at(-1)]]) },
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };
    await expect(agentPageRefHasFocus(contents as never, "e1")).resolves.toBe(false);
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBe("disabled");
  });
});
