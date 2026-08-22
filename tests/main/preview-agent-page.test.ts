import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageActivationBlocked,
  agentPageHasSensitiveEvidence,
  installAgentPagePrivacyGuard,
  locateAgentPageRef,
  semanticPageSnapshot,
  serializeAgentPageSnapshot,
  setAgentPageInputGuard,
} from "../../src/main/preview-agent-page";
import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../../src/shared/agent-browser";
import { installPreviewAgentShadowBoundarySignal } from "../../src/shared/preview-agent-privacy-guard";

describe("agent browser semantic snapshots", () => {
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
    const context = {
      document: {
        title: "Long local page",
        body: { innerText: "b".repeat(12_001) },
        querySelectorAll: () => [],
      },
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
    let inputListener: ((event: Record<string, unknown>) => void) | undefined;
    let nestedBoundaryListener: ((event: Record<string, unknown>) => void) | undefined;
    const document = {
      title: "Sign in",
      body: { innerText: "Password" },
      documentElement: { nodeType: 1, tagName: "HTML", querySelectorAll: () => [input] },
      activeElement: null,
      addEventListener: vi.fn((name: string, listener: (event: Record<string, unknown>) => void) => {
        if (name === "click") clickListener = listener;
        if (name === "input") inputListener = listener;
        if (name === "__inertia_agent_nested_boundary__") nestedBoundaryListener = listener;
      }),
      querySelectorAll: () => [input],
      elementFromPoint: () => input,
    };
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
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await installAgentPagePrivacyGuard(contents as never);
    input.value = secret;
    input.type = "text";
    document.title = secret;
    document.body.innerText = secret;
    const firstSnapshot = await semanticPageSnapshot(contents as never);
    expect(firstSnapshot).not.toContain(secret);
    expect(JSON.parse(firstSnapshot)).toMatchObject({
      title: "[redacted]",
      text: "[redacted]",
      elements: [{ name: "Password field", value: "[redacted]" }],
    });
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(true);
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
    await setAgentPageInputGuard(contents as never, false);
    runInNewContext("globalThis.__inertiaAgentBrowser.passwordValues.clear()", context);
    inputListener?.({ composedPath: () => [{ tagName: "CREDENTIAL-HOST" }] });
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(true);
    runInNewContext("globalThis.__inertiaAgentBrowser.nestedContentObserved = false", context);
    nestedBoundaryListener?.({});
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(true);
  });

  it("masks password values in semantic evidence and interaction labels", async () => {
    const secret = "token-that-must-never-leave-the-page";
    const callbackSecret = "oauth-code-that-never-enters-a-password-field";
    let replacement: typeof input | null = null;
    const document = {
      title: `Account ${secret}`,
      body: { innerText: `Sign in\n${secret}\nKeep this account secure` },
      activeElement: null as unknown,
      querySelectorAll: (selector: string) => selector === "input"
        ? [replacement ?? input]
        : [replacement ?? input, mirror],
      elementFromPoint: (_x: number, y: number) => y < 80 ? input : mirror,
    };
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
        { role: "[redacted]", name: "[redacted]", value: "[redacted]" },
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
    const editors = ["", "plaintext-only"].map((mode, index) => ({
      tagName: "DIV",
      value: undefined,
      disabled: false,
      checked: undefined,
      innerText: mode || "rich text",
      isContentEditable: true,
      getAttribute: (name: string) => name === "contenteditable" ? mode : null,
      getBoundingClientRect: () => ({
        x: 20, y: 30 + index * 50, left: 20, top: 30 + index * 50,
        right: 220, bottom: 70 + index * 50, width: 200, height: 40,
      }),
    }));
    const querySelectorAll = vi.fn(
      (selector: string) => selector === "input" ? [] : editors,
    );
    const context = {
      document: {
        title: "Editors",
        body: { innerText: "rich text plaintext-only" },
        querySelectorAll,
      },
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
    expect(querySelectorAll).toHaveBeenCalledWith(expect.stringContaining("[contenteditable]"));
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
      document: {
        title: "Disabled controls",
        body: { innerText: "Submit" },
        activeElement: null,
        querySelectorAll: (selector: string) => selector === "input" ? [] : [button],
        elementFromPoint: () => button,
      },
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
      document: {
        title: "Upload",
        body: { innerText: "Upload private file" },
        activeElement: input,
        querySelectorAll: () => [input],
        elementFromPoint: () => input,
      },
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
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBe(true);
    input.type = "text";
    await expect(agentPageActivationBlocked(contents as never)).resolves.toBe(false);
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
      document: { elementFromPoint: vi.fn(() => overlay) },
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
    const document = { elementFromPoint: vi.fn((): unknown => presentation) };
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
      innerText: "Continue",
      isConnected: true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({
        x: 20, y: 30, left: 20, top: 30,
        right: 220, bottom: 70, width: 200, height: 40,
      }),
      contains: (candidate: unknown) => candidate === button,
      focus,
    };
    const context = {
      __inertiaAgentBrowser: { refs: new Map([["e1", button]]) },
      document: { elementFromPoint: () => button },
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
