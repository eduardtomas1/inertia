import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageActivationBlocked,
  agentPageHasSensitiveEvidence,
  agentPageInputRefusal,
  agentPageRefHasFocus,
  installAgentPagePrivacyGuard,
  locateAgentPageRef,
  semanticPageSnapshot,
  serializeAgentPageSnapshot,
  setAgentPageInputGuard,
} from "../../src/main/preview-agent-page";
import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../../src/shared/agent-browser";
import { installPreviewAgentShadowBoundarySignal } from "../../src/shared/preview-agent-privacy-guard";

function bodyWithText(text: string): {
  firstChild: { nodeType: number; parentElement: unknown; parentNode: unknown; readonly nodeValue: string; nextSibling: null };
  innerText: string;
  parentElement: null;
  tagName: string;
} {
  const body = {
    innerText: text,
    parentElement: null,
    tagName: "BODY",
  } as {
    firstChild: { nodeType: number; parentElement: unknown; parentNode: unknown; readonly nodeValue: string; nextSibling: null };
    innerText: string;
    parentElement: null;
    tagName: string;
  };
  body.firstChild = { nodeType: 3, parentElement: body, parentNode: body,
    get nodeValue() { return body.innerText; }, nextSibling: null };
  return body;
}

function withSemanticIterator<
  T extends { querySelectorAll: (selector: string) => Iterable<unknown> },
>(document: T): T & {
  createNodeIterator: () => { nextNode: () => unknown | null };
} {
  return Object.assign(document, {
    createNodeIterator: () => {
      const nodes = Array.from(document.querySelectorAll("__semantic_candidates__"));
      let index = 0;
      return { nextNode: () => nodes[index++] ?? null };
    },
  });
}

describe("agent browser semantic snapshots", () => {
  it("rechecks the exact focused ref after page microtasks settle", async () => {
    const targetElement = {
      isConnected: true,
      contains: (candidate: unknown) => candidate === targetElement,
    };
    const decoyElement = {
      isConnected: true,
      contains: (candidate: unknown) => candidate === decoyElement,
    };
    const nestedElement = { isConnected: true };
    const document: { activeElement: unknown } = { activeElement: targetElement };
    const context = {
      document,
      __inertiaAgentBrowser: { refs: new Map([["e1", targetElement]]) },
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(agentPageRefHasFocus(contents as never, "e1")).resolves.toBe(true);
    document.activeElement = nestedElement;
    targetElement.contains = (candidate: unknown) => candidate === nestedElement;
    await expect(agentPageRefHasFocus(contents as never, "e1")).resolves.toBe(false);
    document.activeElement = decoyElement;
    await expect(agentPageRefHasFocus(contents as never, "e1")).resolves.toBe(false);
    await expect(agentPageRefHasFocus(contents as never, "missing")).resolves.toBe(false);
  });

  it("signals a parser-created closed shadow root when page code retrieves its internals", () => {
    const dispatched: string[] = [];
    class FakeEvent {
      constructor(readonly type: string) {}
    }
    class FakeEventTarget {
      dispatchEvent(event: FakeEvent): boolean {
        dispatched.push(event.type);
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      attachShadow(): object { return {}; }
    }
    class FakeHTMLElement extends FakeElement {
      attachInternals(): object { return { shadowRoot: {} }; }
    }
    const context = {
      document: new FakeEventTarget(),
      Element: FakeElement,
      HTMLElement: FakeHTMLElement,
      EventTarget: FakeEventTarget,
      Event: FakeEvent,
    };

    runInNewContext(
      `(${installPreviewAgentShadowBoundarySignal.toString()})("nested-boundary")`,
      context,
    );
    runInNewContext("new HTMLElement().attachInternals()", context);

    expect(dispatched).toEqual(["nested-boundary"]);
  });

  it("signals declarative-root parsing before a detached host can disappear", () => {
    const dispatched: string[] = [];
    class FakeEvent {
      constructor(readonly type: string) {}
    }
    class FakeEventTarget {
      dispatchEvent(event: FakeEvent): boolean {
        dispatched.push(event.type);
        return true;
      }
    }
    class FakeDocumentFragment {
      source = "";
      querySelector(_selector: string): object | null {
        const beforeClose = this.source.split("</template>", 1)[0] ?? "";
        return beforeClose.startsWith("<template") && beforeClose.includes(" shadowrootmode")
          ? {}
          : null;
      }
    }
    class FakeElement extends FakeEventTarget {
      fragment = new FakeDocumentFragment();
      attachShadow(): object { return {}; }
      set innerHTML(source: string) { this.fragment.source = source; }
      setHTML(source: string): void { this.fragment.source = source; }
      setHTMLUnsafe(source: string): void { this.fragment.source = source; }
    }
    class FakeHTMLTemplateElement extends FakeElement {
      get content(): FakeDocumentFragment { return this.fragment; }
    }
    class FakeHTMLElement extends FakeElement {
      attachInternals(): object { return { shadowRoot: null }; }
    }
    class FakeDOMImplementation {
      createHTMLDocument(): FakeDocument { return new FakeDocument(); }
    }
    class FakeDocument extends FakeEventTarget {
      static parseHTML(_html: string): object { return {}; }
      static parseHTMLUnsafe(_html: string): object { return {}; }
      get implementation(): FakeDOMImplementation { return new FakeDOMImplementation(); }
      createElement(): FakeHTMLTemplateElement { return new FakeHTMLTemplateElement(); }
    }
    class FakeShadowRoot {
      setHTML(_html: string): void {}
      setHTMLUnsafe(_html: string): void {}
    }
    const context = {
      document: new FakeDocument(),
      Element: FakeElement,
      HTMLElement: FakeHTMLElement,
      HTMLTemplateElement: FakeHTMLTemplateElement,
      Document: FakeDocument,
      DOMImplementation: FakeDOMImplementation,
      DocumentFragment: FakeDocumentFragment,
      ShadowRoot: FakeShadowRoot,
      EventTarget: FakeEventTarget,
      Event: FakeEvent,
    };

    runInNewContext(
      `(${installPreviewAgentShadowBoundarySignal.toString()})("nested-boundary")`,
      context,
    );
    runInNewContext(`
      new Element().setHTML("<template data-label='>' shadowrootmode=closed>private</template>");
      new Element().setHTMLUnsafe('<template shadowrootmode=closed>private</template>');
      Document.parseHTML('<template shadowrootmode=closed>private</template>');
      Document.parseHTMLUnsafe('<template shadowrootmode=closed>private</template>');
      new ShadowRoot().setHTML('<template shadowrootmode=closed>private</template>');
      new ShadowRoot().setHTMLUnsafe('<template shadowrootmode=closed>private</template>');
    `, context);

    expect(dispatched).toEqual(Array(6).fill("nested-boundary"));

    runInNewContext(`
      new Element().setHTML('<p>ordinary</p>');
      new Element().setHTMLUnsafe('<p>ordinary</p>');
      Document.parseHTML('<p>ordinary</p>');
      Document.parseHTMLUnsafe('<p>ordinary</p>');
      new ShadowRoot().setHTML('<p>ordinary</p>');
      new ShadowRoot().setHTMLUnsafe('<p>ordinary</p>');
      new Element().setHTML('<!-- <template shadowrootmode=open> -->');
      new Element().setHTML('<template data-shadowrootmode=open></template>');
      new Element().setHTML('<template></template><div shadowrootmode=open></div>');
    `, context);
    expect(dispatched).toHaveLength(6);

    runInNewContext("new Element().setHTML('x'.repeat(4097))", context);
    expect(dispatched).toEqual(Array(7).fill("nested-boundary"));
  });

  it("keeps oversized Unicode snapshots valid within the provider byte limit", () => {
    const serialized = serializeAgentPageSnapshot({
      title: "Dense local page",
      url: "http://127.0.0.1:3000/",
      viewport: { width: 1_200, height: 800, scrollX: 0, scrollY: 0 },
      text: "界".repeat(12_000),
      elements: Array.from({ length: 200 }, (_, index) => ({
        ref: `e${index}`,
        role: "button",
        name: "界".repeat(300),
        disabled: false,
        value: "界".repeat(500),
        rect: { x: index, y: index, width: 100, height: 30 },
      })),
      truncated: false,
    });

    expect(Buffer.byteLength(serialized, "utf8"))
      .toBeLessThanOrEqual(MAX_AGENT_BROWSER_TEXT_BYTES);
    expect(() => JSON.parse(serialized)).not.toThrow();
    const parsed = JSON.parse(serialized) as {
      truncated: boolean;
      elements: unknown[];
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.elements.length).toBeGreaterThan(0);
    expect(parsed.elements.length).toBeLessThan(200);
  });

  it("marks text-only snapshots truncated before clipping their body text", () => {
    const serialized = serializeAgentPageSnapshot({
      title: "Long local page",
      url: "http://127.0.0.1:3000/long",
      viewport: { width: 1_200, height: 800, scrollX: 0, scrollY: 0 },
      text: "a".repeat(12_001),
      elements: [],
      truncated: false,
    });

    const parsed = JSON.parse(serialized) as { text: string; truncated: boolean };
    expect(parsed.text).toHaveLength(12_000);
    expect(parsed.truncated).toBe(true);
  });

  it("reports text-only clipping from the semantic page collector", async () => {
    const body = {
      firstChild: null as unknown,
      parentElement: null,
      tagName: "BODY",
    };
    body.firstChild = {
      nodeType: 3, nodeValue: "b".repeat(30_000), parentElement: body,
      parentNode: body, nextSibling: null,
    };
    Object.defineProperty(body, "innerText", {
      get: () => { throw new Error("semantic collection must not read unbounded innerText"); },
    });
    const context = {
      document: withSemanticIterator({
        title: "Long local page",
        body,
        querySelectorAll: () => [],
      }),
      location: { href: "http://127.0.0.1:3000/long?private=value#secret" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const parsed = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      text: string;
      truncated: boolean;
      url: string;
    };
    expect(parsed).toMatchObject({
      truncated: true,
      url: "http://127.0.0.1:3000",
    });
    expect(parsed.text).toHaveLength(12_000);
  });

  it("bounds ordinary input values before normalization", async () => {
    const input = {
      nodeType: 1,
      tagName: "INPUT",
      type: "text",
      value: "x".repeat(50_000),
      labels: [],
      firstChild: null,
      parentElement: null,
      disabled: false,
      checked: false,
      getAttribute: () => null,
      hasAttribute: () => false,
      matches: () => false,
      getBoundingClientRect: () => ({
        x: 10, y: 10, left: 10, top: 10,
        right: 210, bottom: 40, width: 200, height: 30,
      }),
    };
    const context = {
      document: withSemanticIterator({
        title: "Bounded value",
        body: bodyWithText(""),
        documentElement: {},
        querySelectorAll: () => [input],
      }),
      location: { href: "http://127.0.0.1:3000/value" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    runInNewContext(`{
      const replace = String.prototype.replace;
      String.prototype.replace = function (...args) {
        if (this.length > 4096) throw new Error("unbounded normalization");
        return Reflect.apply(replace, this, args);
      };
    }`, context);
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const parsed = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: Array<{ value: string }>;
    };
    expect(parsed.elements[0]?.value).toHaveLength(500);
  });

  it("collects semantic labels through a bounded text-node walk", async () => {
    const button = {
      nodeType: 1,
      tagName: "BUTTON",
      firstChild: null as unknown,
      parentElement: null,
      disabled: false,
      getAttribute: () => null,
      hasAttribute: () => false,
      matches: () => false,
      getBoundingClientRect: () => ({
        x: 10, y: 10, left: 10, top: 10,
        right: 210, bottom: 40, width: 200, height: 30,
      }),
    };
    button.firstChild = {
      nodeType: 3,
      nodeValue: "Label ".repeat(10_000),
      parentElement: button,
      parentNode: button,
      nextSibling: null,
    };
    Object.defineProperty(button, "innerText", {
      get: () => { throw new Error("semantic labels must not read unbounded innerText"); },
    });
    const context = {
      document: withSemanticIterator({
        title: "Bounded label",
        body: bodyWithText(""),
        documentElement: {},
        querySelectorAll: () => [button],
      }),
      location: { href: "http://127.0.0.1:3000/label" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const parsed = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: Array<{ name: string }>;
    };
    expect(parsed.elements[0]?.name).toHaveLength(300);
  });

  it("bounds semantic element discovery before a dense page can materialize candidates", async () => {
    let nextNodeCalls = 0;
    const body = bodyWithText("");
    const querySelectorAll = vi.fn(() => {
      throw new Error("semantic collection must not materialize password inputs");
    });
    const document = {
      title: "Dense controls",
      body,
      documentElement: {},
      querySelectorAll,
      createNodeIterator: () => ({
        nextNode: () => {
          nextNodeCalls += 1;
          return {
            tagName: "DIV",
            getAttribute: () => null,
          };
        },
      }),
    };
    const context = {
      document,
      location: { href: "http://127.0.0.1:3000/dense" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const parsed = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: unknown[];
      truncated: boolean;
    };
    expect(parsed).toMatchObject({ elements: [], truncated: true });
    expect(nextNodeCalls).toBe(4_001);
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it("caches effective opacity across deeply nested semantic controls", async () => {
    const nodes: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 4_000; index += 1) {
      nodes.push({
        nodeType: 1,
        tagName: "BUTTON",
        parentElement: nodes[index - 1] ?? null,
        firstChild: null,
        disabled: false,
        checked: false,
        value: undefined,
        getAttribute: () => null,
        hasAttribute: () => false,
        matches: () => false,
        getBoundingClientRect: () => ({
          x: 10, y: 10, left: 10, top: 10,
          right: 210, bottom: 40, width: 200, height: 30,
        }),
      });
    }
    let next = 0;
    const body = bodyWithText("");
    const document = {
      title: "Hidden controls",
      body,
      documentElement: nodes[0],
      createNodeIterator: () => ({ nextNode: () => nodes[next++] ?? null }),
    };
    const getComputedStyle = vi.fn((element: unknown) => ({
      visibility: "visible",
      display: "block",
      opacity: element === nodes[0] ? "0" : "1",
    }));
    const context = {
      document,
      location: { href: "http://127.0.0.1:3000/hidden" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle,
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const parsed = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: unknown[];
    };
    expect(parsed.elements).toEqual([]);
    expect(getComputedStyle).toHaveBeenCalledTimes(nodes.length + 1);
  });

  it("fails sensitive-evidence inspection closed at the bounded DOM scan limit", async () => {
    let nextNodeCalls = 0;
    const context = {
      __inertiaAgentBrowser: {
        privacyGuardInstalled: true,
        nestedContentObserved: false,
        passwordNodes: new WeakSet(),
        passwordValues: new Set(),
      },
      document: {
        documentElement: {},
        createNodeIterator: () => ({
          nextNode: () => {
            nextNodeCalls += 1;
            return { tagName: "DIV" };
          },
        }),
      },
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(true);
    expect(nextNodeCalls).toBe(4_001);
  });

  it("does not read an ordinary input value during sensitive-evidence preflight", async () => {
    const readValue = vi.fn(() => "x".repeat(50_000));
    const input = { tagName: "INPUT", type: "text" } as { tagName: string; type: string; value: string };
    Object.defineProperty(input, "value", { get: readValue });
    let next = 0;
    const context = {
      __inertiaAgentBrowser: {
        privacyGuardInstalled: true,
        nestedContentObserved: false,
        passwordNodes: new WeakSet(),
        passwordValues: new Set(),
      },
      document: {
        documentElement: {},
        createNodeIterator: () => ({
          nextNode: () => next++ === 0 ? input : null,
        }),
      },
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(false);
    expect(readValue).not.toHaveBeenCalled();
  });

  it("bounds document-start privacy discovery on a dense DOM", async () => {
    let nextNodeCalls = 0;
    class MutationObserver {
      constructor(_callback: (records: unknown[]) => void) {}
      observe(): void {}
    }
    const context = {
      document: {
        documentElement: { nodeType: 1, tagName: "HTML" },
        addEventListener: vi.fn(),
        createNodeIterator: () => ({
          nextNode: () => {
            nextNodeCalls += 1;
            return { nodeType: 1, tagName: "DIV" };
          },
        }),
      },
      MutationObserver,
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await installAgentPagePrivacyGuard(contents as never);
    expect(nextNodeCalls).toBe(4_001);
    expect(runInNewContext(
      "globalThis.__inertiaAgentBrowser.nestedContentObserved",
      context,
    )).toBe(true);
  });

  it("retains document-start taint for a consumed declarative shadow template", async () => {
    let callback: ((records: unknown[]) => void) | undefined;
    class MutationObserver {
      constructor(observer: (records: unknown[]) => void) { callback = observer; }
      observe(): void {}
    }
    const documentElement = { nodeType: 1, tagName: "HTML", matches: () => false };
    const template = {
      nodeType: 1,
      tagName: "TEMPLATE",
      matches: (selector: string) => selector.includes("template[shadowrootmode]"),
    };
    const context = {
      document: {
        documentElement,
        addEventListener: vi.fn(),
        createNodeIterator: (root: unknown) => {
          let next = root;
          return {
            nextNode: () => {
              const value = next;
              next = null;
              return value;
            },
          };
        },
      },
      MutationObserver,
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await installAgentPagePrivacyGuard(contents as never);
    expect(callback).toBeTypeOf("function");
    callback!([{
      type: "childList",
      target: documentElement,
      oldValue: null,
      removedNodes: [template],
      addedNodes: [],
    }]);
    expect(runInNewContext(
      "globalThis.__inertiaAgentBrowser.nestedContentObserved",
      context,
    )).toBe(true);
  });

  it("shares one fail-closed scan budget across each mutation callback", async () => {
    let callback: ((records: unknown[]) => void) | undefined;
    let attributeTargetsInspected = 0;
    let addedNodesInspected = 0;
    class MutationObserver {
      constructor(observer: (records: unknown[]) => void) { callback = observer; }
      observe(): void {}
    }
    const documentElement = { nodeType: 1, tagName: "HTML" };
    const context = {
      document: {
        documentElement,
        addEventListener: vi.fn(),
        createNodeIterator: (root: { nodeType?: number }) => {
          let first = true;
          return {
            nextNode: () => {
              if (!first) return null;
              first = false;
              if (root.nodeType === 1 && root !== documentElement) {
                addedNodesInspected += 1;
              }
              return root;
            },
          };
        },
      },
      MutationObserver,
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await installAgentPagePrivacyGuard(contents as never);
    expect(callback).toBeTypeOf("function");
    const attributeRecords = Array.from({ length: 5_000 }, () => ({
      type: "attributes",
      get target() {
        attributeTargetsInspected += 1;
        return { tagName: "DIV" };
      },
      oldValue: null,
      removedNodes: [],
      addedNodes: [],
    }));
    callback!(attributeRecords);
    expect(attributeTargetsInspected).toBe(4_000);

    const addedNodes = Array.from({ length: 5_000 }, () => ({ nodeType: 1, tagName: "DIV" }));
    callback!([{
      type: "childList",
      target: { tagName: "DIV" },
      oldValue: null,
      removedNodes: [],
      addedNodes,
    }]);
    expect(addedNodesInspected).toBe(2_000);
    expect(runInNewContext(
      "globalThis.__inertiaAgentBrowser.nestedContentObserved",
      context,
    )).toBe(true);
  });

  it("refuses interaction labels when their password scan budget is exhausted", async () => {
    let nextNodeCalls = 0;
    const element = {
      tagName: "BUTTON",
      type: "button",
      value: "",
      disabled: false,
      readOnly: false,
      isContentEditable: false,
      innerText: "Continue",
      isConnected: true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 70, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === element,
    };
    const context = {
      __inertiaAgentBrowser: { refs: new Map([["e1", element]]) },
      document: {
        documentElement: {},
        createNodeIterator: () => ({
          nextNode: () => {
            nextNodeCalls += 1;
            return { tagName: "DIV" };
          },
        }),
        elementFromPoint: () => element,
      },
      innerWidth: 1_200,
      innerHeight: 800,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toEqual({ found: false });
    expect(nextNodeCalls).toBe(4_001);
  });

  it("includes visible descendant text beneath a visibility-hidden ancestor", async () => {
    const body = {
      firstChild: null as unknown,
      parentElement: null,
      tagName: "BODY",
    };
    const hiddenParent = {
      firstChild: null as unknown,
      nextSibling: null,
      nodeType: 1,
      parentElement: body,
      parentNode: body,
      tagName: "DIV",
    };
    const visibleChild = {
      firstChild: null as unknown,
      nextSibling: null,
      nodeType: 1,
      parentElement: hiddenParent,
      parentNode: hiddenParent,
      tagName: "SPAN",
    };
    const textNode = {
      nodeType: 3,
      nodeValue: "Visible descendant",
      nextSibling: null,
      parentElement: visibleChild,
      parentNode: visibleChild,
    };
    body.firstChild = hiddenParent;
    hiddenParent.firstChild = visibleChild;
    visibleChild.firstChild = textNode;
    const document = withSemanticIterator({
      title: "Visibility override",
      body,
      querySelectorAll: () => [],
    });
    const context = {
      document,
      location: { href: "http://127.0.0.1:3000/visibility" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: (element: unknown) => ({
        visibility: element === hiddenParent ? "hidden" : "visible",
        display: "block",
        opacity: "1",
      }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const parsed = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      text: string;
    };
    expect(parsed.text).toBe("Visible descendant");
  });

  it("tracks password identity before the first agent inspection", async () => {
    const secret = "revealed-before-first-snapshot";
    const input = {
      nodeType: 1,
      tagName: "INPUT",
      type: "password",
      value: "",
      disabled: false,
      checked: false,
      labels: [{ innerText: "Password" }],
      innerText: "",
      isConnected: true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 70, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === input,
      querySelectorAll: () => [],
    };
    let clickListener: ((event: Record<string, unknown>) => void) | undefined;
    let privacyInputListener: ((event: Record<string, unknown>) => void) | undefined;
    const activationListeners = new Map<string, (event: Record<string, unknown>) => void>();
    let nestedBoundaryListener: ((event: Record<string, unknown>) => void) | undefined;
    const document = withSemanticIterator({
      title: "Sign in",
      body: bodyWithText("Password"),
      documentElement: { nodeType: 1, tagName: "HTML", querySelectorAll: () => [input] },
      activeElement: null,
      addEventListener: vi.fn((name: string, listener: (event: Record<string, unknown>) => void) => {
        if (name === "click") clickListener = listener;
        if (name === "__inertia_agent_nested_boundary__") nestedBoundaryListener = listener;
      }),
      querySelectorAll: () => [input],
      elementFromPoint: () => input,
    });
    class MutationObserver {
      constructor(_callback: (records: unknown[]) => void) {}
      observe(): void {}
    }
    const context = {
      document,
      MutationObserver,
      location: { href: "http://127.0.0.1:3000/login" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
      addEventListener: vi.fn((name: string, listener: (event: Record<string, unknown>) => void) => {
        if (name === "input" && !privacyInputListener) privacyInputListener = listener;
        activationListeners.set(name, listener);
      }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await installAgentPagePrivacyGuard(contents as never);
    expect(document.addEventListener.mock.calls.map(([name]) => name))
      .not.toContain("input");
    expect(context.addEventListener.mock.calls.slice(0, 2).map(([name]) => name))
      .toEqual(["beforeinput", "input"]);
    input.value = secret;
    input.type = "text";
    document.title = secret;
    document.body.innerText = secret;
    const firstSnapshot = await semanticPageSnapshot(contents as never);
    expect(firstSnapshot).not.toContain(secret);
    const parsedFirstSnapshot = JSON.parse(firstSnapshot) as {
      elements: Array<{ ref: string }>;
    };
    expect(parsedFirstSnapshot).toMatchObject({
      title: "[redacted]",
      text: "[redacted]",
      elements: [{ name: "Password field", value: "[redacted]" }],
    });
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(true);
    const expectedRef = parsedFirstSnapshot.elements[0]!.ref;
    await setAgentPageInputGuard(contents as never, true, expectedRef);
    const expectedMouseDownPrevented = vi.fn();
    activationListeners.get("mousedown")?.({
      composedPath: () => [input],
      isTrusted: true,
      preventDefault: expectedMouseDownPrevented,
      stopImmediatePropagation: vi.fn(),
    });
    expect(expectedMouseDownPrevented).not.toHaveBeenCalled();
    const retargetedMouseUpPrevented = vi.fn();
    const retargetedMouseUpStopped = vi.fn();
    activationListeners.get("mouseup")?.({
      composedPath: () => [{ isConnected: true }],
      isTrusted: true,
      preventDefault: retargetedMouseUpPrevented,
      stopImmediatePropagation: retargetedMouseUpStopped,
    });
    expect(retargetedMouseUpPrevented).toHaveBeenCalledOnce();
    expect(retargetedMouseUpStopped).toHaveBeenCalledOnce();
    await expect(agentPageInputRefusal(contents as never)).resolves.toBe("retargeted");
    await setAgentPageInputGuard(contents as never, true);
    const fileInput = { tagName: "INPUT", type: "file" };
    const prevented = vi.fn();
    const stopped = vi.fn();
    clickListener?.({
      composedPath: () => [fileInput],
      preventDefault: prevented,
      stopImmediatePropagation: stopped,
    });
    expect(prevented).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    const keyPrevented = vi.fn();
    const keyStopped = vi.fn();
    activationListeners.get("keydown")?.({
      composedPath: () => [{
        disabled: false,
        getAttribute: (name: string) => name === "aria-disabled" ? "true" : null,
        matches: () => false,
      }],
      isTrusted: true,
      key: "Enter",
      preventDefault: keyPrevented,
      stopImmediatePropagation: keyStopped,
    });
    expect(keyPrevented).toHaveBeenCalledOnce();
    expect(keyStopped).toHaveBeenCalledOnce();
    for (const [name, key] of [["keypress", "Enter"], ["beforeinput", ""], ["input", ""], ["keyup", "Enter"]]) {
      const sequencePrevented = vi.fn();
      const sequenceStopped = vi.fn();
      activationListeners.get(name)?.({
        isTrusted: true,
        key,
        preventDefault: sequencePrevented,
        stopImmediatePropagation: sequenceStopped,
      });
      expect(sequencePrevented, name).toHaveBeenCalledOnce();
      expect(sequenceStopped, name).toHaveBeenCalledOnce();
    }
    const safeTarget = {
      disabled: false,
      getAttribute: () => null,
      matches: () => false,
    };
    const lateDisabledTarget = {
      disabled: false,
      getAttribute: (name: string) => name === "aria-disabled" ? "true" : null,
      matches: () => false,
    };
    const allowedKeydownPrevented = vi.fn();
    activationListeners.get("keydown")?.({
      composedPath: () => [safeTarget],
      isTrusted: true,
      key: "Enter",
      preventDefault: allowedKeydownPrevented,
      stopImmediatePropagation: vi.fn(),
    });
    expect(allowedKeydownPrevented).not.toHaveBeenCalled();
    const syntheticKeyupPrevented = vi.fn();
    activationListeners.get("keyup")?.({
      composedPath: () => [safeTarget],
      isTrusted: false,
      key: "Enter",
      preventDefault: syntheticKeyupPrevented,
      stopImmediatePropagation: vi.fn(),
    });
    expect(syntheticKeyupPrevented).not.toHaveBeenCalled();
    for (const [name, key] of [["keypress", "Enter"], ["beforeinput", ""], ["input", ""], ["keyup", "Enter"]]) {
      const sequencePrevented = vi.fn();
      const sequenceStopped = vi.fn();
      activationListeners.get(name)?.({
        composedPath: () => [lateDisabledTarget],
        isTrusted: true,
        key,
        preventDefault: sequencePrevented,
        stopImmediatePropagation: sequenceStopped,
      });
      expect(sequencePrevented, `late ${name}`).toHaveBeenCalledOnce();
      expect(sequenceStopped, `late ${name}`).toHaveBeenCalledOnce();
    }
    await setAgentPageInputGuard(contents as never, false);
    runInNewContext("globalThis.__inertiaAgentBrowser.passwordValues.clear()", context);
    input.type = "password";
    input.value = secret;
    privacyInputListener?.({ composedPath: () => [input] });
    input.value = "";
    input.type = "text";
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(true);
    runInNewContext("globalThis.__inertiaAgentBrowser.passwordValues.clear()", context);
    privacyInputListener?.({ composedPath: () => [{ tagName: "CREDENTIAL-HOST" }] });
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(true);
    runInNewContext("globalThis.__inertiaAgentBrowser.nestedContentObserved = false", context);
    nestedBoundaryListener?.({});
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(true);
  });

  it("masks password values in semantic evidence and interaction labels", async () => {
    const secret = "token-that-must-never-leave-the-page";
    const callbackSecret = "oauth-code-that-never-enters-a-password-field";
    let replacement: typeof input | null = null;
    const document = withSemanticIterator({
      title: `Account ${secret}`,
      body: bodyWithText(`Sign in\n${secret}\nKeep this account secure`),
      activeElement: null as unknown,
      querySelectorAll: (selector: string) => selector === "input"
        ? [replacement ?? input]
        : [replacement ?? input, mirror],
      elementFromPoint: (_x: number, y: number) => y < 80 ? input : mirror,
    });
    const focus = vi.fn(() => { document.activeElement = input; });
    const select = vi.fn();
    const inlineStyle = new Map<string, { priority: string; value: string }>();
    const style = {
      getPropertyPriority: (name: string) => inlineStyle.get(name)?.priority ?? "",
      getPropertyValue: (name: string) => inlineStyle.get(name)?.value ?? "",
      removeProperty: (name: string) => { inlineStyle.delete(name); },
      setProperty: (name: string, value: string, priority = "") => {
        inlineStyle.set(name, { priority, value });
      },
    };
    const input = {
      tagName: "INPUT",
      type: "password",
      value: secret,
      disabled: false,
      checked: false,
      labels: [{ innerText: secret }],
      innerText: "",
      isConnected: true,
      style,
      getAttribute: (name: string) => ["aria-label", "role"].includes(name)
        ? input.value
        : null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 70, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === input,
      focus,
      select,
    };
    const mirror = {
      tagName: "INPUT",
      type: "text",
      value: secret,
      disabled: false,
      checked: false,
      labels: [],
      innerText: secret,
      isConnected: true,
      getAttribute: (name: string) => ["aria-label", "role"].includes(name)
        ? input.value
        : null,
      getBoundingClientRect: () => ({
        x: 20, y: 80, left: 20, top: 80,
        right: 220, bottom: 120, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === mirror,
    };
    const context = {
      document,
      location: {
        href: `http://127.0.0.1:3000/login?code=${callbackSecret}#access_token=${callbackSecret}`,
      },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
      getComputedStyle: () => ({
        visibility: "visible",
        display: "block",
        opacity: "1",
      }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const serialized = await semanticPageSnapshot(contents as never);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(callbackSecret);
    expect(JSON.parse(serialized)).toMatchObject({
      title: "Account [redacted]",
      url: "http://127.0.0.1:3000",
      text: "Sign in [redacted] Keep this account secure",
      elements: [
        { role: "input", name: "Password field", value: "[redacted]" },
        { role: "input", name: "Password field", value: "[redacted]" },
      ],
    });

    await expect(locateAgentPageRef(contents as never, "e1", true, true))
      .resolves.toMatchObject({
        found: true,
        editable: true,
        label: "page element",
        x: 120,
        y: 50,
      });
    expect(focus).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    await expect(locateAgentPageRef(contents as never, "e2"))
      .resolves.toMatchObject({ found: true, label: "page element" });

    const changedSecret = "changed-password-after-the-snapshot";
    input.value = changedSecret;
    input.labels[0]!.innerText = changedSecret;
    mirror.innerText = changedSecret;
    await expect(locateAgentPageRef(contents as never, "e2"))
      .resolves.toMatchObject({ found: true, label: "page element" });

    input.value = secret;
    input.labels[0]!.innerText = secret;
    input.type = "text";
    mirror.innerText = secret;
    const revealedSnapshot = await semanticPageSnapshot(contents as never);
    expect(revealedSnapshot).not.toContain(secret);
    const revealed = JSON.parse(revealedSnapshot) as {
      elements: Array<{ role: string; name: string; value: string }>;
    };
    expect(revealed.elements[0]).toMatchObject({
      role: "input",
      name: "Password field",
      value: "[redacted]",
    });

    replacement = {
      ...input,
      type: "text",
      labels: [{ innerText: secret }],
      contains: (candidate: unknown) => candidate === replacement,
    };
    const replacementSnapshot = await semanticPageSnapshot(contents as never);
    expect(replacementSnapshot).not.toContain(secret);
    replacement.value = changedSecret;
    replacement.labels[0]!.innerText = changedSecret;
    mirror.value = changedSecret;
    mirror.innerText = changedSecret;
    const editedReplacementSnapshot = await semanticPageSnapshot(contents as never);
    expect(editedReplacementSnapshot).not.toContain(changedSecret);
  });

  it("includes every valid contenteditable form in semantic refs", async () => {
    const editors = ["", "plaintext-only"].map((mode, index) => {
      const editor = {
        nodeType: 1,
        tagName: "DIV",
        value: undefined,
        disabled: false,
        checked: undefined,
        firstChild: null as unknown,
        isContentEditable: true,
        getAttribute: (name: string) => name === "contenteditable" ? mode : null,
        getBoundingClientRect: () => ({
          x: 20, y: 30 + index * 50, left: 20, top: 30 + index * 50,
          right: 220, bottom: 70 + index * 50, width: 200, height: 40,
        }),
      };
      editor.firstChild = {
        nodeType: 3,
        nodeValue: mode || "rich text",
        parentElement: editor,
        parentNode: editor,
        nextSibling: null,
      };
      return editor;
    });
    const querySelectorAll = vi.fn(
      (selector: string) => selector === "input" ? [] : editors,
    );
    const context = {
      document: withSemanticIterator({
        title: "Editors",
        body: bodyWithText("rich text plaintext-only"),
        querySelectorAll,
      }),
      location: { href: "http://127.0.0.1:3000/editors" },
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const snapshot = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: Array<{ name: string }>;
    };
    expect(snapshot.elements.map(({ name }) => name)).toEqual([
      "rich text",
      "plaintext-only",
    ]);
  });

  it("recognizes controls disabled by an ancestor fieldset", async () => {
    const button = {
      tagName: "BUTTON",
      type: "button",
      value: "",
      disabled: false,
      checked: undefined,
      innerText: "Submit",
      isConnected: true,
      matches: (selector: string) => selector === ":disabled",
      getAttribute: () => null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 70, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === button,
    };
    const context = {
      document: withSemanticIterator({
        title: "Disabled controls",
        body: bodyWithText("Submit"),
        activeElement: null,
        querySelectorAll: (selector: string) => selector === "input" ? [] : [button],
        elementFromPoint: () => button,
      }),
      location: { href: "http://127.0.0.1:3000/disabled" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const snapshot = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: Array<{ disabled: boolean }>;
    };
    expect(snapshot.elements[0]?.disabled).toBe(true);
    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toMatchObject({ found: true, disabled: true });
  });

  it("inherits aria-disabled from ancestor containers", async () => {
    const container = {
      parentElement: null,
      getAttribute: (name: string) => name === "aria-disabled" ? "true" : null,
    };
    const button = {
      tagName: "BUTTON",
      type: "button",
      value: "",
      disabled: false,
      checked: undefined,
      innerText: "Managed action",
      isConnected: true,
      parentElement: container,
      matches: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 70, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === button,
    };
    const context = {
      document: withSemanticIterator({
        title: "ARIA disabled controls",
        body: bodyWithText("Managed action"),
        activeElement: button,
        querySelectorAll: (selector: string) => selector === "input" ? [] : [button],
        elementFromPoint: () => button,
      }),
      location: { href: "http://127.0.0.1:3000/aria-disabled" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const snapshot = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: Array<{ disabled: boolean }>;
    };
    expect(snapshot.elements[0]?.disabled).toBe(true);
    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toMatchObject({ found: true, disabled: true });
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBe("disabled");
  });

  it("excludes file inputs and blocks refs that change into file inputs", async () => {
    const input = {
      tagName: "INPUT",
      type: "file",
      value: "",
      disabled: false,
      readOnly: false,
      checked: false,
      labels: [{ innerText: "Upload private file" }],
      innerText: "",
      isConnected: true,
      matches: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 70, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === input,
    };
    const context = {
      document: withSemanticIterator({
        title: "Upload",
        body: bodyWithText("Upload private file"),
        activeElement: input,
        querySelectorAll: () => [input],
        elementFromPoint: () => input,
      }),
      location: { href: "http://127.0.0.1:3000/upload" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    const excluded = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: unknown[];
    };
    expect(excluded.elements).toEqual([]);
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBe("file");
    input.type = "text";
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBe(null);
    const actionable = JSON.parse(await semanticPageSnapshot(contents as never)) as {
      elements: Array<{ ref: string }>;
    };
    expect(actionable.elements).toEqual([expect.objectContaining({ ref: "e1" })]);
    input.type = "file";
    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toMatchObject({ found: true, blocked: true });
  });

  it("rejects editable refs whose focus handler redirects ownership", async () => {
    const redirected = {};
    const document = {
      activeElement: null as unknown,
      documentElement: {},
      createNodeIterator: () => ({ nextNode: () => null }),
      elementFromPoint: () => input,
    };
    const input = {
      tagName: "INPUT",
      type: "text",
      value: "",
      disabled: false,
      readOnly: false,
      isContentEditable: false,
      innerText: "",
      isConnected: true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 70, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === input,
      focus: vi.fn(() => { document.activeElement = redirected; }),
      select: vi.fn(),
    };
    const context = {
      __inertiaAgentBrowser: { refs: new Map([["e1", input]]) },
      document,
      innerWidth: 1_200,
      innerHeight: 800,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(locateAgentPageRef(contents as never, "e1", true, true))
      .resolves.toEqual({ found: false });
    expect(input.select).toHaveBeenCalledOnce();
  });

  it("rejects covered refs and targets the visible intersection of clipped refs", async () => {
    const focus = vi.fn();
    const element = {
      tagName: "BUTTON",
      type: "",
      value: "",
      disabled: false,
      innerText: "Continue",
      isConnected: true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({
        x: -190, y: 10, left: -190, top: 10,
        right: 10, bottom: 60, width: 200, height: 50,
      }),
      contains: (candidate: unknown) => candidate === element,
      focus,
    };
    const overlay = {};
    const context = {
      __inertiaAgentBrowser: { refs: new Map([["e1", element]]) },
      document: {
        documentElement: {},
        createNodeIterator: () => ({ nextNode: () => null }),
        elementFromPoint: vi.fn(() => overlay),
      },
      innerWidth: 1_200,
      innerHeight: 800,
      getComputedStyle: () => ({
        visibility: "visible",
        display: "block",
        opacity: "1",
      }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(locateAgentPageRef(contents as never, "e1", true))
      .resolves.toEqual({ found: false });
    expect(focus).not.toHaveBeenCalled();

    context.document.elementFromPoint.mockReturnValue(element);
    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toMatchObject({ found: true, x: 5, y: 35 });
    expect(context.document.elementFromPoint).toHaveBeenLastCalledWith(5, 35);
  });

  it("rejects nested actionable hits and refs hidden by ancestor opacity", async () => {
    const hiddenParent = { parentElement: null };
    const outer = {
      tagName: "DIV",
      type: "",
      value: "",
      disabled: false,
      readOnly: false,
      isContentEditable: false,
      innerText: "Outer action",
      isConnected: true,
      parentElement: null as unknown,
      getAttribute: (name: string) => name === "role" ? "button" : null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 90, width: 200, height: 60,
      }),
      contains: (candidate: unknown) => candidate === outer
        || candidate === presentation || candidate === inner,
    };
    const presentation = {
      parentElement: outer,
      matches: () => false,
      getAttribute: (name: string) => name === "role" ? "presentation" : null,
    };
    const inner = {
      parentElement: outer,
      matches: (selector: string) => selector.includes("button"),
      getAttribute: () => null,
    };
    const document = {
      documentElement: {},
      createNodeIterator: () => ({ nextNode: () => null }),
      elementFromPoint: vi.fn((): unknown => presentation),
    };
    const context = {
      __inertiaAgentBrowser: { refs: new Map([["e1", outer]]) },
      document,
      innerWidth: 1_200,
      innerHeight: 800,
      getComputedStyle: (element: unknown) => ({
        visibility: "visible",
        display: "block",
        opacity: element === hiddenParent ? "0" : "1",
      }),
      Set,
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toMatchObject({ found: true });
    document.elementFromPoint.mockReturnValue(inner);
    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toEqual({ found: false });
    outer.parentElement = hiddenParent;
    document.elementFromPoint.mockReturnValue(presentation);
    await expect(locateAgentPageRef(contents as never, "e1"))
      .resolves.toEqual({ found: false });
  });

  it("reports non-editable refs without focusing them", async () => {
    const focus = vi.fn();
    const button = {
      tagName: "BUTTON",
      type: "button",
      value: "",
      disabled: false,
      readOnly: false,
      isContentEditable: false,
      firstChild: null as unknown,
      isConnected: true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 70, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === button,
      focus,
    };
    button.firstChild = {
      nodeType: 3,
      nodeValue: "Continue",
      parentElement: button,
      parentNode: button,
      nextSibling: null,
    };
    const context = {
      __inertiaAgentBrowser: { refs: new Map([["e1", button]]) },
      document: {
        documentElement: {},
        createNodeIterator: () => ({ nextNode: () => null }),
        elementFromPoint: () => button,
      },
      innerWidth: 1_200,
      innerHeight: 800,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(locateAgentPageRef(contents as never, "e1", true, true))
      .resolves.toMatchObject({ found: true, editable: false, label: "Continue" });
    expect(focus).not.toHaveBeenCalled();
  });
});
