import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  locateAgentPageRef,
  semanticPageSnapshot,
  serializeAgentPageSnapshot,
} from "../../src/main/preview-agent-page";
import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../../src/shared/agent-browser";

describe("agent browser semantic snapshots", () => {
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

  it("masks password values in semantic evidence and interaction labels", async () => {
    const secret = "token-that-must-never-leave-the-page";
    const callbackSecret = "oauth-code-that-never-enters-a-password-field";
    const document = {
      title: `Account ${secret}`,
      body: { innerText: `Sign in\n${secret}\nKeep this account secure` },
      activeElement: null as unknown,
      querySelectorAll: (selector: string) => selector === "input"
        ? [input]
        : [input, mirror],
      elementFromPoint: (_x: number, y: number) => y < 80 ? input : mirror,
    };
    const focus = vi.fn(() => { document.activeElement = input; });
    const select = vi.fn();
    const input = {
      tagName: "INPUT",
      type: "password",
      value: secret,
      disabled: false,
      checked: false,
      labels: [{ innerText: secret }],
      innerText: "",
      isConnected: true,
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
        label: "Password field",
        x: 120,
        y: 50,
      });
    expect(focus).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    await expect(locateAgentPageRef(contents as never, "e2"))
      .resolves.toMatchObject({ found: true, label: "[redacted]" });

    const changedSecret = "changed-password-after-the-snapshot";
    input.value = changedSecret;
    input.labels[0]!.innerText = changedSecret;
    mirror.innerText = changedSecret;
    await expect(locateAgentPageRef(contents as never, "e2"))
      .resolves.toMatchObject({ found: true, label: "[redacted]" });

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
