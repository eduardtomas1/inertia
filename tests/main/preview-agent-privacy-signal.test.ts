import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { agentPageEvidencePrivacy, installAgentPagePrivacyGuard } from "../../src/main/preview-agent-page";
import { installPreviewAgentShadowBoundarySignal } from "../../src/shared/preview-agent-privacy-guard";
import {
  PREVIEW_AGENT_NAME_WORD_SOURCE,
  PREVIEW_AGENT_SENSITIVE_NAME_SOURCE,
} from "../../src/shared/preview-agent-sensitive-fields";

interface Signal { type: string; detail?: unknown }

function mainWorld() {
  const dispatched: Signal[] = [];
  class FakeEvent {
    constructor(readonly type: string) {}
  }
  class FakeCustomEvent extends FakeEvent {
    readonly detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      super(type);
      this.detail = init?.detail;
    }
  }
  class FakeEventTarget {
    dispatchEvent(event: FakeEvent & { detail?: unknown }): boolean {
      dispatched.push(event.detail === undefined ? { type: event.type } : { type: event.type, detail: event.detail });
      return true;
    }
  }
  class FakeNode extends FakeEventTarget {
    get nodeValue(): string | null { return null; }
    set nodeValue(_value: string | null) {}
    get textContent(): string | null { return null; }
    set textContent(_value: string | null) {}
  }
  class FakeElement extends FakeNode {
    readonly attributeValues = new Map<string, string>();
    attachShadow(): object { return {}; }
    getAttribute(name: string): string | null { return this.attributeValues.get(name) ?? null; }
    applyAttribute(name: string, value: string): void { this.attributeValues.set(name, value); }
    setAttribute(name: string, value: string): void { this.applyAttribute(name, String(value)); }
    setAttributeNS(_namespace: string | null, name: string, value: string): void { this.applyAttribute(name, String(value)); }
    setAttributeNode(): null { return null; }
    setAttributeNodeNS(): null { return null; }
  }
  class FakeAttr extends FakeNode {
    get ownerElement(): null { return null; }
    get value(): string { return ""; }
    set value(_value: string) {}
  }
  class FakeNamedNodeMap {
    setNamedItem(): null { return null; }
    setNamedItemNS(): null { return null; }
  }
  class FakeHTMLElement extends FakeElement {
    attachInternals(): object { return { shadowRoot: null }; }
  }
  class FakeHTMLInputElement extends FakeHTMLElement {
    #type = "text";
    #value = "";
    #defaultValue = "";
    get type(): string { return this.#type; }
    set type(value: string) { this.#type = String(value).toLowerCase(); }
    get value(): string { return this.#value; }
    set value(value: string) { this.#value = String(value); }
    get defaultValue(): string { return this.#defaultValue; }
    set defaultValue(value: string) { this.#defaultValue = String(value); }
    setRangeText(value: string): void { this.#value = String(value); }
    override applyAttribute(name: string, value: string): void {
      super.applyAttribute(name, value);
      if (name === "type") this.#type = value.toLowerCase();
    }
  }
  const context: Record<string, unknown> = {
    document: new FakeEventTarget(),
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    HTMLInputElement: FakeHTMLInputElement,
    NamedNodeMap: FakeNamedNodeMap,
    Attr: FakeAttr,
    Node: FakeNode,
    EventTarget: FakeEventTarget,
    Event: FakeEvent,
    CustomEvent: FakeCustomEvent,
  };
  runInNewContext(
    `(${installPreviewAgentShadowBoundarySignal.toString()})("nested-boundary", "credential-signal", ${JSON.stringify(PREVIEW_AGENT_SENSITIVE_NAME_SOURCE)}, ${JSON.stringify(PREVIEW_AGENT_NAME_WORD_SOURCE)})`,
    context,
  );
  return { dispatched, run: (code: string): unknown => runInNewContext(code, context) };
}

describe("Browser main-world credential signal", () => {
  it("builds its value signal from built-ins captured before page scripts", () => {
    const { dispatched, run } = mainWorld();
    run(`
      Array.prototype.toJSON = () => ["decoy"];
      Array.prototype.some = () => false;
      Array.prototype[Symbol.iterator] = function* () {};
      RegExp.prototype.exec = () => null;
      RegExp.prototype.test = () => false;
      String.prototype.toLowerCase = () => "text";
      Function.prototype.call = () => true;
      Function.prototype.apply = () => true;
      Reflect.apply = () => "text";
      JSON.stringify = () => '["decoy"]';
      Object.prototype.detail = '["decoy"]';
      const password = new HTMLInputElement();
      password.type = "password";
      password.value = "hunter2";
      const key = new HTMLInputElement();
      key.setAttribute("name", "api_key");
      key.value = "sk-sentinel";
    `);
    expect(dispatched).toEqual([
      { type: "credential-signal", detail: '["hunter2",""]' },
      { type: "credential-signal", detail: '["sk-sentinel",""]' },
    ]);
  });

  it("signals values by control type and bounded name words", () => {
    const { dispatched, run } = mainWorld();
    run(`
      const assign = (attributes, value) => {
        const input = new HTMLInputElement();
        for (const [name, attribute] of Object.entries(attributes)) input.setAttribute(name, attribute);
        input.value = value;
      };
      assign({ type: "number", name: "max_tokens" }, "4096");
      assign({ type: "checkbox", name: "show_password" }, "on");
      assign({ type: "submit", id: "password-submit" }, "Sign in");
      assign({ name: "token_type" }, "bearer");
      assign({ name: "authToken" }, "auth-sentinel");
      assign({ type: "hidden", name: "_token" }, "csrf-sentinel");
      assign({ type: "tel", "aria-label": "PIN" }, "4321");
    `);
    expect(dispatched).toEqual([
      { type: "credential-signal", detail: '["auth-sentinel",""]' },
      { type: "credential-signal", detail: '["csrf-sentinel",""]' },
      { type: "credential-signal", detail: '["4321",""]' },
    ]);
  });

  it("keeps a monitored page accessor working when inspection fails", () => {
    const { dispatched, run } = mainWorld();
    const result = run(`
      const input = new HTMLInputElement();
      input.type = "password";
      const calls = [];
      let current = "";
      Object.defineProperty(input, "value", {
        configurable: true,
        get() { return current; },
        set(value) { calls.push(value); current = value; },
      });
      const descriptor = Object.getOwnPropertyDescriptor(input, "value");
      const outcomes = [];
      try { descriptor.get.call({}); outcomes.push("get"); } catch { outcomes.push("get threw"); }
      try { descriptor.set.call({}, "x"); outcomes.push("set"); } catch { outcomes.push("set threw"); }
      ({ calls, outcomes });
    `);
    expect(result).toEqual({ calls: ["x"], outcomes: ["get", "set"] });
    expect(dispatched.slice(-2)).toEqual([{ type: "credential-signal" }, { type: "credential-signal" }]);
  });

  it("signals a shadowing getter, carries its last value and ignores React's own reads", () => {
    const { dispatched, run } = mainWorld();
    const wrappedOnce = run(`
      globalThis.react = new HTMLInputElement();
      react.type = "password";
      react.value = "typed";
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      Object.defineProperty(react, "value", {
        configurable: true,
        get() { return native.get.call(this); },
        set(value) { native.set.call(this, value); },
      });
      const wrapped = Object.getOwnPropertyDescriptor(react, "value").get;
      Object.defineProperty(react, "value", { enumerable: false });
      Object.getOwnPropertyDescriptor(react, "value").get === wrapped;
    `);
    expect(wrappedOnce).toBe(true);
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.every((signal) => signal.detail === '["typed",""]')).toBe(true);
    dispatched.length = 0;
    expect(run("react.value + react.value")).toBe("typedtyped");
    expect(dispatched).toEqual([]);
    run(`
      const shadow = new HTMLInputElement();
      Object.defineProperty(shadow, "value", { configurable: true, get: () => "hunter2", set() {} });
      shadow.value;
      Object.defineProperty(shadow, "value", { configurable: true, get: () => "", set() {} });
      shadow.type = "password";
      const long = new HTMLInputElement();
      long.type = "password";
      Object.defineProperty(long, "value", { configurable: true, get: () => "x".repeat(4097), set() {} });
      long.value;
    `);
    expect(dispatched).toEqual([
      { type: "credential-signal", detail: '["hunter2"]' },
      { type: "credential-signal" },
    ]);
  });

  it("withholds evidence for a value signal that carries no value", async () => {
    let credentialSignal: ((event: Record<string, unknown>) => void) | undefined;
    const state = {
      privacyGuardInstalled: false,
      refs: new Map(), nodes: new WeakMap(), next: 1,
      passwordNodes: new WeakSet(), passwordValues: new Set<string>(),
    } as Record<string, unknown>;
    class MutationObserver {
      observe(): void {}
    }
    const context = {
      __inertiaAgentBrowser: state,
      MutationObserver,
      document: { documentElement: null, addEventListener: vi.fn(), getElementsByTagName: () => [] },
      addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => {
        if (name === "__inertia_agent_credential_signal__") credentialSignal = listener;
      },
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, scripts: Array<{ code: string }>) =>
        runInNewContext(scripts[0]!.code, context)),
    };
    await installAgentPagePrivacyGuard(contents as never);
    credentialSignal?.({ detail: '["hunter2",""]' });
    expect(state.passwordValues).toEqual(new Set(["hunter2"]));
    await expect(agentPageEvidencePrivacy(contents as never, "semantic")).resolves.toEqual({ withheld: null });
    credentialSignal?.({ detail: '["",""]' });
    await expect(agentPageEvidencePrivacy(contents as never, "semantic"))
      .resolves.toEqual({ withheld: "credential-signal" });
  });
});
