import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageActivationBlocked,
  agentPageHasSensitiveEvidence,
  agentPageHasSensitiveScreenshotEvidence,
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
  it("classifies bounded visible text and input values before screenshot capture", async () => {
    const input = {
      nodeType: 1,
      tagName: "INPUT",
      type: "text",
      value: "ordinary note",
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
    const ordinaryBodyText = "Build finished successfully. ".repeat(40);
    const body = bodyWithText(ordinaryBodyText);
    const context = {
      __inertiaAgentBrowser: {
        privacyGuardInstalled: true,
        nestedContentObserved: false,
        passwordNodes: new WeakSet(),
        passwordValues: new Set(),
        nodes: new WeakMap(), refs: new Map(), next: 1,
      },
      document: withSemanticIterator({
        title: "Local app", body, documentElement: {},
        querySelectorAll: () => [input],
      }),
      location: { href: "http://127.0.0.1:3000/" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200, innerHeight: 800, scrollX: 0, scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(agentPageHasSensitiveScreenshotEvidence(contents as never)).resolves.toBe(false);
    body.innerText = "API_KEY=sk-visible-token-that-must-not-enter-a-bitmap";
    await expect(agentPageHasSensitiveScreenshotEvidence(contents as never)).resolves.toBe(true);
    body.innerText = ordinaryBodyText;
    input.value = "databasepass=visible-input-secret";
    await expect(agentPageHasSensitiveScreenshotEvidence(contents as never)).resolves.toBe(true);
  });

  it("fails screenshot classification closed when visible evidence is truncated", async () => {
    const body = bodyWithText("x".repeat(30_000));
    const context = {
      __inertiaAgentBrowser: {
        privacyGuardInstalled: true,
        nestedContentObserved: false,
        passwordNodes: new WeakSet(),
        passwordValues: new Set(),
        nodes: new WeakMap(), refs: new Map(), next: 1,
      },
      document: withSemanticIterator({
        title: "Dense app", body, documentElement: {}, querySelectorAll: () => [],
      }),
      location: { href: "http://127.0.0.1:3000/" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200, innerHeight: 800, scrollX: 0, scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(agentPageHasSensitiveScreenshotEvidence(contents as never)).resolves.toBe(true);
  });

  it.each([
    ["canvas", { tagName: "CANVAS" }],
    ["image input", { tagName: "INPUT", type: "image" }],
    ["CSS background", { tagName: "DIV", backgroundImage: "url(private.png)" }],
    ["generated content", { tagName: "DIV", pseudoContent: '"private"' }],
  ])("refuses uninspectable %s pixels before screenshot capture", async (_name, candidate) => {
    const candidateStyle = candidate as {
      backgroundImage?: string;
      pseudoContent?: string;
    };
    const element = {
      nodeType: 1,
      firstChild: null,
      parentElement: null,
      hidden: false,
      type: "",
      getBoundingClientRect: () => ({
        x: 10, y: 10, left: 10, top: 10,
        right: 210, bottom: 110, width: 200, height: 100,
      }),
      ...candidate,
    };
    const context = {
      __inertiaAgentBrowser: {
        privacyGuardInstalled: true,
        nestedContentObserved: false,
        passwordNodes: new WeakSet(),
        passwordValues: new Set(),
      },
      document: withSemanticIterator({
        title: "Pixel app", body: bodyWithText("Ordinary page"), documentElement: {},
        querySelectorAll: () => [element],
      }),
      location: { href: "http://127.0.0.1:3000/" },
      URL,
      encodeURIComponent,
      innerWidth: 1_200, innerHeight: 800, scrollX: 0, scrollY: 0,
      getComputedStyle: (_element: unknown, pseudo?: string) => ({
        visibility: "visible", display: "block", opacity: "1",
        backgroundImage: candidateStyle.backgroundImage ?? "none",
        borderImageSource: "none", listStyleImage: "none", maskImage: "none",
        webkitMaskImage: "none",
        content: pseudo ? candidateStyle.pseudoContent ?? "none" : "normal",
      }),
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(agentPageHasSensitiveScreenshotEvidence(contents as never)).resolves.toBe(true);
  });

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

  it("signals an imperative shadow boundary only after native creation succeeds", () => {
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
      attachShadow(init: { mode?: string }): object {
        if (init.mode !== "closed") throw new TypeError("Invalid shadow root mode");
        return {};
      }
    }
    class FakeHTMLElement extends FakeElement {
      attachInternals(): object { return { shadowRoot: null }; }
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
    expect(() => runInNewContext("new Element().attachShadow({mode:'invalid'})", context))
      .toThrow("Invalid shadow root mode");
    expect(dispatched).toEqual([]);
    runInNewContext("new Element().attachShadow({mode:'closed'})", context);
    expect(dispatched).toEqual(["nested-boundary"]);
  });

  it("signals a non-empty password value assignment before page code can clear it", () => {
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
    class FakeNode extends FakeEventTarget {
      nodeValueStorage: string | null = null;
      get nodeValue(): string | null { return this.nodeValueStorage; }
      set nodeValue(value: string | null) {
        this.nodeValueStorage = value;
        const syncOwner = Reflect.get(this, "syncOwner");
        if (typeof syncOwner === "function") Reflect.apply(syncOwner, this, []);
      }
      get textContent(): string | null { return this.nodeValueStorage; }
      set textContent(value: string | null) {
        this.nodeValueStorage = value;
        const syncOwner = Reflect.get(this, "syncOwner");
        if (typeof syncOwner === "function") Reflect.apply(syncOwner, this, []);
      }
    }
    class FakeElement extends FakeNode {
      attachShadow(): object { return {}; }
      applyAttribute(_name: string, _value: string): void {}
      attachAttribute(attr: FakeAttr): null {
        attr.attach(this);
        this.applyAttribute(attr.name, attr.value);
        return null;
      }
      setAttribute(name: string, value: string): void {
        this.applyAttribute(name, String(value));
      }
      setAttributeNS(_namespace: string | null, name: string, value: string): void {
        this.applyAttribute(name, String(value));
      }
      setAttributeNode(attr: FakeAttr): null {
        return this.attachAttribute(attr);
      }
      setAttributeNodeNS(attr: FakeAttr): null {
        return this.attachAttribute(attr);
      }
    }
    class FakeAttr extends FakeNode {
      owner: FakeElement | null = null;
      constructor(readonly name: string) { super(); }
      get ownerElement(): FakeElement | null { return this.owner; }
      get value(): string { return this.nodeValueStorage ?? ""; }
      set value(value: string) {
        this.nodeValueStorage = String(value);
        this.syncOwner();
      }
      attach(owner: FakeElement): void { this.owner = owner; }
      syncOwner(): void {
        if (this.owner) this.owner.applyAttribute(this.name, this.value);
      }
    }
    class FakeNamedNodeMap {
      constructor(readonly owner: FakeElement) {}
      setNamedItem(attr: FakeAttr): null { return this.owner.attachAttribute(attr); }
      setNamedItemNS(attr: FakeAttr): null { return this.owner.attachAttribute(attr); }
    }
    class FakeHTMLElement extends FakeElement {
      attachInternals(): object { return { shadowRoot: null }; }
    }
    class FakeHTMLInputElement extends FakeHTMLElement {
      #type = "text";
      #value = "";
      #defaultValue = "";
      readonly attributes = new FakeNamedNodeMap(this);
      get type(): string { return this.#type; }
      set type(value: string) { this.#type = value; }
      get value(): string { return this.#value; }
      set value(value: string) { this.#value = String(value); }
      get defaultValue(): string { return this.#defaultValue; }
      set defaultValue(value: string) {
        this.#defaultValue = String(value);
        this.#value = this.#defaultValue;
      }
      setRangeText(value: string): void { this.#value = String(value); }
      applyAttribute(name: string, value: string): void {
        if (name === "type") this.#type = value;
        if (name === "value") {
          this.#defaultValue = value;
          this.#value = value;
        }
      }
    }
    const context = {
      document: new FakeEventTarget(),
      Element: FakeElement,
      HTMLElement: FakeHTMLElement,
      HTMLInputElement: FakeHTMLInputElement,
      NamedNodeMap: FakeNamedNodeMap,
      Attr: FakeAttr,
      Node: FakeNode,
      EventTarget: FakeEventTarget,
      Event: FakeEvent,
    };

    runInNewContext(
      `(${installPreviewAgentShadowBoundarySignal.toString()})("nested-boundary")`,
      context,
    );
    runInNewContext(`
      const ordinary = new HTMLInputElement();
      ordinary.value = "brief note";
      ordinary.setRangeText("ordinary text");
      const ordinaryAttrInput = new HTMLInputElement();
      const ordinaryAttr = new Attr("value");
      ordinaryAttrInput.setAttributeNode(ordinaryAttr);
      ordinaryAttr.textContent = "brief note";
      ordinaryAttr.textContent = "";
      const credential = new HTMLInputElement();
      credential.type = "password";
      credential.value = "hunter2";
      credential.value = "";
      const latePassword = new HTMLInputElement();
      latePassword.value = "secret";
      latePassword.type = "password";
      latePassword.value = "";
      const attributeCredential = new HTMLInputElement();
      attributeCredential.type = "password";
      attributeCredential.setAttribute("value", "hunter2");
      attributeCredential.setAttribute("value", "");
      const defaultCredential = new HTMLInputElement();
      defaultCredential.defaultValue = "private";
      defaultCredential.type = "password";
      defaultCredential.defaultValue = "";
      const namespacedCredential = new HTMLInputElement();
      namespacedCredential.type = "password";
      namespacedCredential.setAttributeNS(null, "value", "short");
      namespacedCredential.setAttributeNS(null, "value", "");
      const rangeCredential = new HTMLInputElement();
      rangeCredential.type = "password";
      rangeCredential.setRangeText("hunter2");
      rangeCredential.value = "";
      const attrValueCredential = new HTMLInputElement();
      attrValueCredential.type = "password";
      const valueAttr = new Attr("value");
      valueAttr.value = "short";
      attrValueCredential.setAttributeNode(valueAttr);
      valueAttr.value = "";
      const attrNodeValueCredential = new HTMLInputElement();
      attrNodeValueCredential.type = "password";
      const nodeValueAttr = new Attr("value");
      nodeValueAttr.nodeValue = "brief";
      attrNodeValueCredential.setAttributeNodeNS(nodeValueAttr);
      nodeValueAttr.nodeValue = "";
      const namedItemCredential = new HTMLInputElement();
      namedItemCredential.type = "password";
      const namedAttr = new Attr("value");
      namedAttr.value = "tiny";
      namedItemCredential.attributes.setNamedItem(namedAttr);
      namedAttr.value = "";
      const attachedValueCredential = new HTMLInputElement();
      attachedValueCredential.type = "password";
      const attachedValueAttr = new Attr("value");
      attachedValueCredential.setAttributeNode(attachedValueAttr);
      attachedValueAttr.value = "small";
      attachedValueAttr.value = "";
      const attachedNodeValueCredential = new HTMLInputElement();
      attachedNodeValueCredential.type = "password";
      const attachedNodeValueAttr = new Attr("value");
      attachedNodeValueCredential.setAttributeNode(attachedNodeValueAttr);
      attachedNodeValueAttr.nodeValue = "little";
      attachedNodeValueAttr.nodeValue = "";
      const attachedTextCredential = new HTMLInputElement();
      attachedTextCredential.type = "password";
      const attachedTextAttr = new Attr("value");
      attachedTextCredential.setAttributeNode(attachedTextAttr);
      attachedTextAttr.textContent = "concise";
      attachedTextAttr.textContent = "";
    `, context);

    expect(dispatched).toEqual(Array(12).fill("nested-boundary"));
    const descriptorRoutes = [
      `const input = new HTMLInputElement(); input.type = "password";
        Object.defineProperty(input, "value", {
          configurable: true, writable: true, value: "hunter2",
        }); delete input.value;`,
      `const input = new HTMLInputElement(); input.type = "password";
        Object.defineProperties(input, {
          value: { configurable: true, writable: true, value: "hunter2" },
        }); delete input.value;`,
      `const input = new HTMLInputElement(); input.type = "password";
        Reflect.defineProperty(input, "value", {
          configurable: true, writable: true, value: "hunter2",
        }); delete input.value;`,
      `const input = new HTMLInputElement();
        Object.defineProperty(input, "value", {
          configurable: true, writable: true, value: "hunter2",
        }); input.type = "password"; delete input.value;`,
      `const input = new HTMLInputElement(); input.type = "password";
        Object.prototype.__defineGetter__.call(input, "value", () => "hunter2");
        delete input.value;`,
    ];
    for (const [index, route] of descriptorRoutes.entries()) {
      runInNewContext(`{${route}}`, context);
      expect(dispatched, route).toHaveLength(13 + index);
    }
    runInNewContext(`{
      const input = new HTMLInputElement();
      Object.defineProperty(input, "value", {
        configurable: true, writable: true, value: "brief note",
      });
      delete input.value;
    }`, context);
    expect(dispatched).toHaveLength(17);
    const prototypeRoutes = [
      `const input = new HTMLInputElement(); input.type = "password";
        const nativePrototype = Object.getPrototypeOf(input);
        Object.setPrototypeOf(input, { value: "hunter2" });
        Object.setPrototypeOf(input, nativePrototype);`,
      `const input = new HTMLInputElement(); input.type = "password";
        const nativePrototype = Object.getPrototypeOf(input);
        Reflect.setPrototypeOf(input, { value: "hunter2" });
        Object.setPrototypeOf(input, nativePrototype);`,
      `const input = new HTMLInputElement(); input.type = "password";
        const nativePrototype = Object.getPrototypeOf(input);
        Object.getOwnPropertyDescriptor(Object.prototype, "__proto__").set
          .call(input, { value: "hunter2" });
        Object.setPrototypeOf(input, nativePrototype);`,
      `const input = new HTMLInputElement();
        const nativePrototype = Object.getPrototypeOf(input);
        Object.setPrototypeOf(input, { type: "password", value: "hunter2" });
        Object.setPrototypeOf(input, nativePrototype);`,
    ];
    for (const [index, route] of prototypeRoutes.entries()) {
      runInNewContext(`{${route}}`, context);
      expect(dispatched, route).toHaveLength(18 + index);
    }
    runInNewContext(`{
      const ordinary = {};
      Object.setPrototypeOf(ordinary, { value: "brief note" });
      Reflect.setPrototypeOf(ordinary, null);
    }`, context);
    expect(dispatched).toHaveLength(21);
  });

  it("signals private parser content before a detached host can disappear", () => {
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
        if (beforeClose.startsWith("<template") && beforeClose.includes(" shadowrootmode")) {
          return {};
        }
        return /<input\b(?=[^>]*\btype\s*=\s*['"]?password\b)(?=[^>]*\bvalue\s*=\s*(?:['"][^'"]+['"]|[^\s>]+))/iu
          .test(this.source) ? {} : null;
      }
    }
    class FakeElement extends FakeEventTarget {
      fragment = new FakeDocumentFragment();
      attachShadow(): object { return {}; }
      set innerHTML(source: string) { this.fragment.source = source; }
      set outerHTML(source: string) { this.fragment.source = source; }
      insertAdjacentHTML(_position: string, source: string): void { this.fragment.source = source; }
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
      parsedSource = "";
      static parseHTML(_html: string): object { return {}; }
      static parseHTMLUnsafe(_html: string): object { return {}; }
      get implementation(): FakeDOMImplementation { return new FakeDOMImplementation(); }
      createElement(): FakeHTMLTemplateElement { return new FakeHTMLTemplateElement(); }
      write(...parts: string[]): void { this.parsedSource = parts.join(""); }
      writeln(...parts: string[]): void { this.parsedSource = `${parts.join("")}\n`; }
    }
    class FakeShadowRoot {
      setHTML(_html: string): void {}
      setHTMLUnsafe(_html: string): void {}
    }
    class FakeRange {
      createContextualFragment(source: string): FakeDocumentFragment {
        const fragment = new FakeDocumentFragment();
        fragment.source = source;
        return fragment;
      }
    }
    class FakeDOMParser {
      parseFromString(_source: string, _type: string): object { return {}; }
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
      Range: FakeRange,
      DOMParser: FakeDOMParser,
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
      const passwordMarkup = '<input type="password" value="hunter2">';
      new Element().innerHTML = passwordMarkup;
      new Element().outerHTML = passwordMarkup;
      new Element().insertAdjacentHTML('beforeend', passwordMarkup);
      new Range().createContextualFragment(passwordMarkup);
      new DOMParser().parseFromString(passwordMarkup, 'text/html');
      new Element().setHTMLUnsafe(passwordMarkup);
      Document.parseHTMLUnsafe(passwordMarkup);
      new Document().write('<input type="password" ', 'value="hunter2">');
      new Document().writeln('<input type="password" ', 'value="hunter2">');
    `, context);

    expect(dispatched).toEqual(Array(15).fill("nested-boundary"));

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
      const ordinaryMarkup = '<input type="text" value="brief note">';
      new Element().innerHTML = ordinaryMarkup;
      new Element().outerHTML = ordinaryMarkup;
      new Element().insertAdjacentHTML('beforeend', ordinaryMarkup);
      new Range().createContextualFragment(ordinaryMarkup);
      new DOMParser().parseFromString(ordinaryMarkup, 'text/html');
      new Document().write('<p>', 'ordinary</p>');
      new Document().writeln('<input type="text" ', 'value="brief note">');
    `, context);
    expect(dispatched).toHaveLength(15);

    runInNewContext("new Element().setHTML('x'.repeat(4097))", context);
    expect(dispatched).toEqual(Array(16).fill("nested-boundary"));
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
        if (name === "__inertia_agent_nested_boundary__") nestedBoundaryListener = listener;
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
    expect(context.addEventListener.mock.calls.slice(0, 3).map(([name]) => name))
      .toEqual(["__inertia_agent_nested_boundary__", "beforeinput", "input"]);
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
    privacyInputListener?.({
      composedPath: () => [{ tagName: "CREDENTIAL-HOST" }],
      isTrusted: false,
    });
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(false);
    privacyInputListener?.({
      composedPath: () => [{ tagName: "CREDENTIAL-HOST" }],
      isTrusted: true,
    });
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
