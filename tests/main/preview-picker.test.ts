import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { Window } from "happy-dom";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildValidatedPreviewAnnotation,
  captureCroppedElementScreenshot,
  computePreviewCaptureRect,
  isPickablePreviewPage,
  PreviewPickerCoordinator,
  type PreviewPickerSessionView,
} from "../../src/main/preview-picker";
import {
  PREVIEW_PICKER_OVERLAY_ATTR,
  previewPickerStartScript,
  previewPickerStopScript,
} from "../../src/main/preview-picker-script";
import { AGENT_BROWSER_WORLD_ID } from "../../src/main/preview-agent-page";
import { assembleTurnRequest } from "../../src/server/runtime/turns/request-context";
import { SCREENSHOT_PNG_BASE64 } from "./support/preview-broker-harness";

function createIsolatedPickerEnvironment(html: string) {
  const win = new Window({ url: "http://127.0.0.1:5173/app" });
  win.document.body.innerHTML = html;
  Object.defineProperty(win, "innerWidth", { value: 1_000, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: 700, configurable: true });

  const sent: unknown[] = [];
  const shadows = new WeakMap<object, ShadowRoot>();
  const origAttachShadow = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function patchedAttachShadow(init: ShadowRootInit) {
    const root = origAttachShadow.call(this, init);
    shadows.set(this, root as unknown as ShadowRoot);
    return root;
  };

  const hitTargets: Element[] = [];
  (win.document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint =
    () => hitTargets.slice();

  const vmContext = {
    window: win,
    document: win.document,
    globalThis: {} as Record<string, unknown>,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    CSS: (win as unknown as { CSS?: unknown }).CSS,
    __inertiaPreviewPickerBridge: {
      send: (payload: unknown) => sent.push(payload),
    },
  };
  vmContext.globalThis = vmContext;

  const runScript = (code: string) => runInNewContext(code, vmContext);
  const getOverlayHost = () =>
    win.document.querySelector(`[${PREVIEW_PICKER_OVERLAY_ATTR}="host"]`) as unknown as Element | null;
  const getClosedShadow = () => {
    const host = getOverlayHost();
    return host ? shadows.get(host) ?? null : null;
  };

  return { win, sent, hitTargets, runScript, getOverlayHost, getClosedShadow, vmContext };
}

function trusted<T extends object>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true, configurable: true });
  return event;
}

describe("isolated-world preview picker script", () => {
  it("mounts an open shadow root overlay, highlights on hover, swallows clicks, and delivers selection", async () => {
    const env = createIsolatedPickerEnvironment('<main><button id="cta" class="primary">Buy now</button></main>');
    const button = env.win.document.getElementById("cta")!;
    button.getBoundingClientRect = () => ({
      left: 100, top: 120, right: 220, bottom: 160, width: 120, height: 40, x: 100, y: 120, toJSON: () => ({}),
    }) as never;
    const pageClick = vi.fn();
    button.addEventListener("click", pageClick);
    button.addEventListener("pointerdown", pageClick);
    env.hitTargets.push(button as unknown as Element);

    expect(env.runScript(previewPickerStartScript())).toBe(true);
    const host = env.getOverlayHost();
    expect(host).not.toBeNull();
    const shadow = env.getClosedShadow()!;
    expect(shadow).not.toBeNull();
    expect((host as unknown as { shadowRoot: unknown }).shadowRoot).toBe(shadow);

    env.win.dispatchEvent(new env.win.Event("pointermove", { bubbles: true, cancelable: true }) as never);
    const badge = shadow.querySelector(".badge") as HTMLElement;
    expect(badge.textContent).toBe("button#cta.primary");

    const pointerDown = trusted(new env.win.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 140, clientY: 135 }));
    button.dispatchEvent(pointerDown);
    const click = trusted(new env.win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, clientX: 140, clientY: 135 }));
    button.dispatchEvent(click);
    expect(pageClick).not.toHaveBeenCalled();
    expect(shadow.querySelector("textarea")).toBeNull();
    expect(shadow.querySelector("input")).toBeNull();

    await vi.waitFor(() => expect(env.sent).toHaveLength(1));
    const selected = env.sent[0] as { type: string; generation: number; payload: Record<string, unknown> };
    expect(selected.type).toBe("selected");
    expect(selected.generation).toBe(0);
    expect(selected.payload.selector).toBe("#cta");
    expect(selected.payload.role).toBe("button");
    expect(selected.payload.name).toBe("Buy now");
    expect(selected.payload.label).toBe("button#cta.primary");
    expect(selected.payload.bounds).toEqual({ x: 100, y: 120, width: 120, height: 40 });
    expect(env.getOverlayHost()).toBeNull();
  });

  it("ignores untrusted synthetic page events trying to hijack or cancel the picker", () => {
    const env = createIsolatedPickerEnvironment('<button id="target">Target</button>');
    const button = env.win.document.getElementById("target")!;
    button.getBoundingClientRect = () => ({
      left: 10, top: 20, right: 90, bottom: 52, width: 80, height: 32, x: 10, y: 20, toJSON: () => ({}),
    }) as never;
    env.hitTargets.push(button as unknown as Element);

    env.runScript(previewPickerStartScript({ generation: 7 }));
    button.dispatchEvent(new env.win.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 30 }));
    button.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 30 }));
    env.win.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
    expect(env.sent).toEqual([]);
    expect(env.getOverlayHost()).not.toBeNull();
  });

  it("cancels on Escape and immediately selects an element for context-menu initial point", async () => {
    const env = createIsolatedPickerEnvironment('<button id="edit">Edit</button>');
    const button = env.win.document.getElementById("edit")!;
    button.getBoundingClientRect = () => ({
      left: 50, top: 60, right: 130, bottom: 92, width: 80, height: 32, x: 50, y: 60, toJSON: () => ({}),
    }) as never;
    env.hitTargets.push(button as unknown as Element);

    env.runScript(previewPickerStartScript({ generation: 3 }));
    env.win.dispatchEvent(trusted(new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never));
    expect(env.sent).toEqual([{ type: "cancelled", generation: 3 }]);
    expect(env.getOverlayHost()).toBeNull();

    env.sent.length = 0;
    env.runScript(previewPickerStartScript({ point: { x: 70, y: 75 }, generation: 4 }));
    await vi.waitFor(() => expect(env.sent).toHaveLength(1));
    expect(env.sent[0]).toMatchObject({ type: "selected", generation: 4, payload: { selector: "#edit" } });
    expect(env.getOverlayHost()).toBeNull();
  });

  it("tears down cleanly without notifying main only when stop generation matches", () => {
    const env = createIsolatedPickerEnvironment("<div>Hi</div>");
    env.runScript(previewPickerStartScript({ generation: 5 }));
    expect(env.getOverlayHost()).not.toBeNull();
    expect(env.runScript(previewPickerStopScript(4))).toBe(false);
    expect(env.getOverlayHost()).not.toBeNull();
    expect(env.runScript(previewPickerStopScript(5))).toBe(true);
    expect(env.getOverlayHost()).toBeNull();
    expect(env.sent).toEqual([]);
  });
});

type PickerEnvironment = ReturnType<typeof createIsolatedPickerEnvironment>;

function stubElementsFromPoint(scope: object, hits: () => Element[]): void {
  (scope as { elementsFromPoint: () => Element[] }).elementsFromPoint = hits;
}

async function submitPick(env: PickerEnvironment, ...hits: Element[]) {
  env.hitTargets.splice(0, env.hitTargets.length, ...hits);
  env.runScript(previewPickerStartScript({ point: { x: 10, y: 10 }, generation: 1 }));
  await vi.waitFor(() => expect(env.sent).toHaveLength(1));
  const selected = env.sent.pop() as { type: string; generation: number; payload: { label: string; selector: string; role: string; name: string } };
  expect(selected.type).toBe("selected");
  expect(selected.generation).toBe(1);
  return { target: selected.payload.label, ...selected.payload };
}

describe("isolated-world preview picker element description", () => {
  it("uses a unique id directly and escapes special characters", async () => {
    const env = createIsolatedPickerEnvironment('<main><button id="save:item.1" class="btn primary">Save</button></main>');
    const button = env.win.document.getElementById("save:item.1")! as unknown as Element;
    const { selector } = await submitPick(env, button);
    expect(selector).toBe("#save\\:item\\.1");
    expect(env.win.document.querySelectorAll(selector)).toHaveLength(1);
    expect(env.win.document.querySelector(selector)).toBe(button);
  });

  it("falls back to nth-child when ids are duplicated or siblings match", async () => {
    const env = createIsolatedPickerEnvironment(`
      <section>
        <ul class="items">
          <li class="row"><button class="action">First</button></li>
          <li class="row"><button class="action">Second</button></li>
          <li class="row"><button class="action">Third</button></li>
        </ul>
      </section>
    `);
    const second = env.win.document.querySelectorAll("button.action")[1]! as unknown as Element;
    const { selector } = await submitPick(env, second);
    expect(selector).toContain(":nth-child(2)");
    expect(env.win.document.querySelectorAll(selector)).toHaveLength(1);
    expect(env.win.document.querySelector(selector)).toBe(second);

    const dup = createIsolatedPickerEnvironment('<div><span id="dup">A</span><span id="dup">B</span></div>');
    const spans = dup.win.document.querySelectorAll("span");
    const duplicate = await submitPick(dup, spans[1]! as unknown as Element);
    expect(duplicate.selector).not.toBe("#dup");
    expect(duplicate.selector).toContain(":nth-child(2)");
    expect(dup.win.document.querySelectorAll(duplicate.selector)).toHaveLength(1);
    expect(dup.win.document.querySelector(duplicate.selector)).toBe(spans[1]);
  });

  it("builds shadow-piercing selectors across nested open shadow roots", async () => {
    const env = createIsolatedPickerEnvironment('<div id="app"></div>');
    const document = env.win.document;
    const outerHost = document.createElement("outer-card");
    outerHost.id = "card-1";
    document.getElementById("app")!.appendChild(outerHost);
    const outerRoot = outerHost.attachShadow({ mode: "open" });
    const innerHost = document.createElement("inner-toolbar");
    innerHost.className = "toolbar";
    outerRoot.appendChild(innerHost);
    const innerRoot = innerHost.attachShadow({ mode: "open" });
    const target = document.createElement("button");
    target.className = "confirm";
    target.textContent = "Confirm";
    innerRoot.appendChild(target);
    stubElementsFromPoint(outerRoot, () => [innerHost as unknown as Element]);
    stubElementsFromPoint(innerRoot, () => [target as unknown as Element]);

    const { selector, role, name } = await submitPick(env, outerHost as unknown as Element);
    expect(selector).toBe("#card-1 >>> inner-toolbar.toolbar >>> button.confirm");
    expect(role).toBe("button");
    expect(name).toBe("Confirm");
  });

  it("descends into open shadow roots while keeping closed shadow roots opaque and excluding the overlay", () => {
    const env = createIsolatedPickerEnvironment("<div></div>");
    const document = env.win.document;
    const widget = document.createElement("my-widget");
    document.body.appendChild(widget);
    const openShadow = widget.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Inside";
    const closedHost = document.createElement("closed-box");
    openShadow.append(button, closedHost);
    const closedShadow = closedHost.attachShadow({ mode: "closed" });
    const secret = document.createElement("span");
    secret.textContent = "Secret";
    closedShadow.appendChild(secret);
    stubElementsFromPoint(closedShadow, () => [secret as unknown as Element]);
    for (const element of [button, closedHost]) {
      element.getBoundingClientRect = () => ({
        left: 4, top: 30, right: 84, bottom: 60, width: 80, height: 30, x: 4, y: 30, toJSON: () => ({}),
      }) as never;
    }

    let openHits: Element[] = [button as unknown as Element, widget as unknown as Element];
    stubElementsFromPoint(openShadow, () => openHits);
    env.runScript(previewPickerStartScript());
    const overlay = env.getOverlayHost()!;
    env.hitTargets.splice(0, env.hitTargets.length, overlay, widget as unknown as Element);
    const badge = env.getClosedShadow()!.querySelector(".badge") as HTMLElement;
    env.win.dispatchEvent(new env.win.Event("pointermove", { bubbles: true, cancelable: true }) as never);
    expect(badge.textContent).toBe("button");

    openHits = [closedHost as unknown as Element, widget as unknown as Element];
    env.win.dispatchEvent(new env.win.Event("pointermove", { bubbles: true, cancelable: true }) as never);
    expect(badge.textContent).toBe("closed-box");
  });

  it("extracts short labels and accessible role and name without leaking password values", async () => {
    const html = `
      <button id="submit" class="primary lg extra">Publish changes</button>
      <label for="pw">Password</label>
      <input id="pw" type="password" value="super-secret" />
    `;
    const env = createIsolatedPickerEnvironment(html);
    const button = await submitPick(env, env.win.document.getElementById("submit")! as unknown as Element);
    expect(button.target).toBe("button#submit.primary.lg");
    expect({ role: button.role, name: button.name }).toEqual({ role: "button", name: "Publish changes" });

    const passwordEnv = createIsolatedPickerEnvironment(html);
    const password = await submitPick(passwordEnv, passwordEnv.win.document.getElementById("pw")! as unknown as Element);
    expect(password.role).toBe("textbox");
    expect(password.name).not.toContain("super-secret");
  });
});

describe("main-process preview picker coordinator and provider assembly", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("computes clamped capture rects with margin and rejects offscreen elements", () => {
    expect(computePreviewCaptureRect({ x: 100, y: 80, width: 120, height: 40 }, { width: 800, height: 600 })).toEqual({
      x: 84, y: 64, width: 152, height: 72,
    });
    expect(computePreviewCaptureRect({ x: 4, y: 4, width: 50, height: 30 }, { width: 800, height: 600 })).toEqual({
      x: 0, y: 0, width: 70, height: 50,
    });
    expect(computePreviewCaptureRect({ x: 900, y: 10, width: 50, height: 30 }, { width: 800, height: 600 })).toBeNull();
  });

  it("refuses privileged pages and non-preview partitions", () => {
    expect(isPickablePreviewPage("inertia-preview-abc", "http://localhost:3000/")).toBe(true);
    expect(isPickablePreviewPage("persist:default", "http://localhost:3000/")).toBe(false);
    expect(isPickablePreviewPage("inertia-preview-abc", "inertia://bundle/index.html")).toBe(false);
    expect(isPickablePreviewPage("inertia-preview-abc", "file:///etc/hosts")).toBe(false);
    expect(isPickablePreviewPage("inertia-preview-abc", "https://example.com/")).toBe(false);
    expect(() => buildValidatedPreviewAnnotation({
      selector: "#a", role: "button", name: "Go", bounds: { x: 0, y: 0, width: 10, height: 10 }, html: "<button/>", comment: "hi",
    }, "https://example.com/")).toThrow();
  });

  it("runs in AGENT_BROWSER_WORLD_ID, refuses while agent is busy, captures cropped PNG, and delivers to owning conversation", async () => {
    const pngBytes = Buffer.from(SCREENSHOT_PNG_BASE64, "base64");
    const executeJavaScriptInIsolatedWorld = vi.fn(async () => true);
    const capturePage = vi.fn(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 152, height: 72 }),
      toPNG: () => pngBytes,
      resize: vi.fn(),
    }));
    const contents = {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:4173/settings",
      executeJavaScriptInIsolatedWorld,
      capturePage,
    } as unknown as WebContents;

    const sentToMainWindow: Array<[string, unknown]> = [];
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn((channel: string, payload: unknown) => sentToMainWindow.push([channel, payload])),
      },
    };

    const setPreviewAnnotation = vi.fn((id: string, annotation: unknown) => ({
      id,
      name: "preview-annotation.png",
      path: id,
      mimeType: "image/png" as const,
      size: pngBytes.byteLength,
      previewAnnotation: annotation,
    }));
    const coordinator = new PreviewPickerCoordinator({
      publish: vi.fn(),
      annotations: {
        window: () => mainWindow as never,
        document: () => ({ owner: mainWindow.webContents as never, processId: 1, frameId: 2, frameToken: "tok" }),
        registry: () => ({
          import: vi.fn(async () => [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "preview-annotation.png", path: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", mimeType: "image/png", size: pngBytes.byteLength }]),
          setPreviewAnnotation,
        }) as never,
        imports: {
          begin: vi.fn(() => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
          importSelection: vi.fn(async (_doc, _batch, run) => await run(new AbortController().signal)),
          cancel: vi.fn(async () => undefined),
        } as never,
        channel: "inertia:preview-annotation-ready",
      },
      privacy: {
        checkEvidencePrivacy: vi.fn(async () => ({ withheld: null })),
        checkScreenshotPrivacy: vi.fn(async () => "clear" as const),
      },
    });

    const session: PreviewPickerSessionView = {
      contextId: "11111111-1111-4111-8111-111111111111",
      partition: "inertia-preview-test",
      activeTabId: "tab-1",
      busy: 1,
      viewportScale: 1,
      pickerActive: false,
      pickerSelection: null,
      activeTab: { id: "tab-1", documentSequence: 1, contents },
    };

    await expect(coordinator.start(session)).rejects.toThrow("agent is controlling");

    (session as { busy: number }).busy = 0;
    await coordinator.start(session);
    expect(session.pickerActive).toBe(true);
    expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      AGENT_BROWSER_WORLD_ID,
      [expect.objectContaining({ code: expect.any(String) })],
      true,
    );

    coordinator.handleGuestEvent(contents, {
      type: "selected",
      generation: 1,
      payload: {
        selector: "button#save",
        role: "button",
        name: "Save",
        tagName: "button",
        label: "button#save",
        bounds: { x: 100, y: 80, width: 120, height: 40 },
        html: '<button id="save" onclick="evil()"><script>bad()</script>Save</button>',
        viewportWidth: 800,
        viewportHeight: 600,
      },
    }, session);

    await vi.waitFor(() => expect(session.pickerSelection).toEqual({ label: "button#save", selector: "button#save" }));
    expect(capturePage).toHaveBeenCalledWith({ x: 84, y: 64, width: 152, height: 72 });
    expect(sentToMainWindow).toHaveLength(0);

    expect(await coordinator.submit(session, "Make it wider")).toBe(true);
    expect(session.pickerActive).toBe(false);
    expect(session.pickerSelection).toBeNull();
    expect(setPreviewAnnotation).toHaveBeenCalledOnce();
    const [channel, delivery] = sentToMainWindow[0]!;
    expect(channel).toBe("inertia:preview-annotation-ready");
    expect(delivery).toMatchObject({
      conversationId: "11111111-1111-4111-8111-111111111111",
      selection: {
        batchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        attachments: [
          expect.objectContaining({
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            mimeType: "image/png",
            previewAnnotation: expect.objectContaining({
              pageUrl: "http://127.0.0.1:4173/settings",
              selector: "button#save",
              role: "button",
              name: "Save",
              comment: "Make it wider",
              html: '<button id="save">Save</button>',
            }),
          }),
        ],
      },
    });
  });

  it("refuses element annotation when the page shows a password or sensitive screenshot", async () => {
    const sentToMainWindow: Array<[string, unknown]> = [];
    const capturePage = vi.fn();
    const contents = {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:4173/login",
      executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
      capturePage,
    } as unknown as WebContents;
    const coordinator = new PreviewPickerCoordinator({
      publish: vi.fn(),
      annotations: {
        window: () => ({
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, send: (ch: string, payload: unknown) => sentToMainWindow.push([ch, payload]) },
        }) as never,
        document: () => ({ owner: contents, processId: 1, frameId: 1, frameToken: "frame" }) as never,
        registry: () => ({ import: vi.fn(), setPreviewAnnotation: vi.fn() }) as never,
        imports: { begin: vi.fn(), importSelection: vi.fn(), cancel: vi.fn() } as never,
        channel: "inertia:preview-annotation-ready",
      },
      privacy: {
        checkEvidencePrivacy: vi.fn(async () => ({ withheld: "password" as const })),
        checkScreenshotPrivacy: vi.fn(async () => "sensitive" as const),
      },
    });
    const session: PreviewPickerSessionView = {
      contextId: "11111111-1111-4111-8111-111111111111",
      partition: "inertia-preview-test",
      activeTabId: "tab-1",
      busy: 0,
      viewportScale: 1,
      pickerActive: false,
      pickerSelection: null,
      activeTab: { id: "tab-1", documentSequence: 1, contents },
    };

    await coordinator.start(session);
    coordinator.handleGuestEvent(contents, {
      type: "selected",
      generation: 1,
      payload: {
        selector: "input#pw",
        role: "textbox",
        name: "Password",
        tagName: "input",
        bounds: { x: 10, y: 10, width: 120, height: 32 },
        html: '<input id="pw" type="text" value="hunter2">',
        viewportWidth: 800,
        viewportHeight: 600,
      },
    }, session);

    await vi.waitFor(() => expect(sentToMainWindow).toHaveLength(1));
    expect(capturePage).not.toHaveBeenCalled();
    expect(session.pickerSelection).toBeNull();
    expect(session.pickerActive).toBe(false);
    expect(sentToMainWindow[0]?.[1]).toMatchObject({
      conversationId: session.contextId,
      error: expect.stringMatching(/password|secret/iu),
    });
  });

  it("refuses element annotation when screenshot privacy checks are unreadable before or after capture", async () => {
    const pngBytes = Buffer.from(SCREENSHOT_PNG_BASE64, "base64");
    const sentToMainWindow: Array<[string, unknown]> = [];
    const capturePage = vi.fn(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 120, height: 40 }),
      toPNG: () => pngBytes,
      resize: vi.fn(),
    }));
    const contents = {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:4173/embed",
      executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
      capturePage,
    } as unknown as WebContents;
    const checkScreenshotPrivacy = vi.fn<() => Promise<"clear" | "sensitive" | "unreadable">>()
      .mockResolvedValueOnce("unreadable")
      .mockResolvedValueOnce("clear")
      .mockResolvedValueOnce("unreadable");
    const coordinator = new PreviewPickerCoordinator({
      publish: vi.fn(),
      annotations: {
        window: () => ({
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, send: (ch: string, payload: unknown) => sentToMainWindow.push([ch, payload]) },
        }) as never,
        document: () => ({ owner: contents, processId: 1, frameId: 1, frameToken: "frame" }) as never,
        registry: () => ({ import: vi.fn(), setPreviewAnnotation: vi.fn() }) as never,
        imports: { begin: vi.fn(), importSelection: vi.fn(), cancel: vi.fn() } as never,
        channel: "inertia:preview-annotation-ready",
      },
      privacy: {
        checkEvidencePrivacy: vi.fn(async () => ({ withheld: null })),
        checkScreenshotPrivacy,
      },
    });
    const session: PreviewPickerSessionView = {
      contextId: "11111111-1111-4111-8111-111111111111",
      partition: "inertia-preview-test",
      activeTabId: "tab-1",
      busy: 0,
      viewportScale: 1,
      pickerActive: false,
      pickerSelection: null,
      activeTab: { id: "tab-1", documentSequence: 1, contents },
    };

    const payload = {
      selector: "div#frame-wrap",
      role: "generic",
      name: "Embedded",
      tagName: "div",
      bounds: { x: 10, y: 10, width: 120, height: 40 },
      html: '<div id="frame-wrap">Embedded</div>',
      viewportWidth: 800,
      viewportHeight: 600,
    };

    await coordinator.start(session);
    coordinator.handleGuestEvent(contents, { type: "selected", generation: 1, payload }, session);
    await vi.waitFor(() => expect(sentToMainWindow).toHaveLength(1));
    expect(capturePage).not.toHaveBeenCalled();
    expect(session.pickerSelection).toBeNull();
    expect(sentToMainWindow[0]?.[1]).toMatchObject({
      conversationId: session.contextId,
      error: expect.stringMatching(/frames or shadow roots/iu),
    });

    await coordinator.start(session);
    coordinator.handleGuestEvent(contents, { type: "selected", generation: 2, payload }, session);
    await vi.waitFor(() => expect(sentToMainWindow).toHaveLength(2));
    expect(capturePage).toHaveBeenCalledTimes(1);
    expect(session.pickerSelection).toBeNull();
    expect(session.pickerActive).toBe(false);
    expect(sentToMainWindow[1]?.[1]).toMatchObject({
      conversationId: session.contextId,
      error: expect.stringMatching(/frames or shadow roots/iu),
    });
  });

  it("captures cropped screenshots and passes both untrusted-content block and image attachment to the provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inertia-picker-test-"));
    tempDirs.push(dir);
    const pngPath = join(dir, "crop.png");
    const pngBytes = Buffer.from(SCREENSHOT_PNG_BASE64, "base64");
    writeFileSync(pngPath, pngBytes);

    const shot = await captureCroppedElementScreenshot({
      capturePage: vi.fn(async () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 4, height: 3 }),
        toPNG: () => pngBytes,
        resize: vi.fn(),
      })),
    } as unknown as WebContents, { x: 20, y: 20, width: 40, height: 20 }, { width: 400, height: 300 });
    expect(shot.equals(pngBytes)).toBe(true);

    const { annotation } = buildValidatedPreviewAnnotation({
      selector: "#hero >>> button.cta",
      role: "button",
      name: "Start",
      bounds: { x: 20, y: 20, width: 40, height: 20 },
      html: '<button class="cta" onclick="x()">Start</button>',
      comment: "Round the corners",
      viewportWidth: 400,
      viewportHeight: 300,
    }, "http://localhost:3000/");

    const assembled = assembleTurnRequest({
      cwd: dir,
      visibleContent: "Please inspect the attached page annotation.",
      attachments: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "preview-annotation.png",
        path: pngPath,
        mimeType: "image/png",
        size: pngBytes.byteLength,
        previewAnnotation: annotation,
      }],
    });
    expect(assembled.imagePaths).toHaveLength(1);
    expect(assembled.executionPrompt).toContain("<<<BEGIN_UNTRUSTED_PAGE_ANNOTATION>>>");
    expect(assembled.executionPrompt).toContain("Round the corners");
    expect(assembled.executionPrompt).toContain("#hero >>> button.cta");
    expect(assembled.executionPrompt).not.toContain("onclick");
  });

  it("cancels an active pick when cancel() is invoked (e.g., when agent control starts)", async () => {
    const executeJavaScriptInIsolatedWorld = vi.fn<
      (worldId: number, scripts: Array<{ code: string }>, userGesture?: boolean) => Promise<boolean>
    >(async () => true);
    const contents = {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:4173/app",
      executeJavaScriptInIsolatedWorld,
      capturePage: vi.fn(),
    } as unknown as WebContents;
    const publish = vi.fn();
    const coordinator = new PreviewPickerCoordinator({ publish });
    const session: PreviewPickerSessionView = {
      contextId: "11111111-1111-4111-8111-111111111111",
      partition: "inertia-preview-test",
      activeTabId: "tab-1",
      busy: 0,
      viewportScale: 1,
      pickerActive: false,
      pickerSelection: null,
      activeTab: { id: "tab-1", documentSequence: 1, contents },
    };

    await coordinator.start(session);
    expect(session.pickerActive).toBe(true);
    expect(coordinator.isActive(session.contextId)).toBe(true);

    coordinator.cancel(session);
    expect(session.pickerActive).toBe(false);
    expect(coordinator.isActive(session.contextId)).toBe(false);
    expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    expect(executeJavaScriptInIsolatedWorld.mock.calls[1]?.[1]?.[0]?.code).toContain("__inertiaPreviewPicker");
  });

  it("tears down a stale overlay if cancel() ran while startPreviewPickerInPage was in flight", async () => {
    let resolveStart!: (value: boolean) => void;
    const executeJavaScriptInIsolatedWorld = vi.fn<
      (worldId: number, scripts: Array<{ code: string }>, userGesture?: boolean) => Promise<boolean>
    >()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveStart = resolve; }))
      .mockResolvedValue(true);
    const contents = {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:4173/app",
      executeJavaScriptInIsolatedWorld,
      capturePage: vi.fn(),
    } as unknown as WebContents;
    const coordinator = new PreviewPickerCoordinator({ publish: vi.fn() });
    const session: PreviewPickerSessionView = {
      contextId: "11111111-1111-4111-8111-111111111111",
      partition: "inertia-preview-test",
      activeTabId: "tab-1",
      busy: 0,
      viewportScale: 1,
      pickerActive: false,
      pickerSelection: null,
      activeTab: { id: "tab-1", documentSequence: 1, contents },
    };

    const starting = coordinator.start(session);
    coordinator.cancel(session);
    resolveStart(true);
    expect(await starting).toBe(false);
    expect(session.pickerActive).toBe(false);
    expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(3);
    expect(executeJavaScriptInIsolatedWorld.mock.calls[2]?.[1]?.[0]?.code).toContain("expectedGeneration = 1");
  });

  it("strips query and fragment from pageUrl before storing annotations", () => {
    const built = buildValidatedPreviewAnnotation(
      {
        selector: "#save",
        role: "button",
        name: "Save",
        bounds: { x: 0, y: 0, width: 20, height: 10 },
        html: "<button id='save'>Save</button>",
        comment: "Fix spacing",
      },
      "http://127.0.0.1:4173/settings/profile?token=ghp_123456789012345678901234567890123456#access_token=abc",
    );
    expect(built.annotation.pageUrl).toBe("http://127.0.0.1:4173/settings/profile");
  });
});
