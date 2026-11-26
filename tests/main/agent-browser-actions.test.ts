import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseAgentBrowserResult, type AgentBrowserCommand } from "../../src/shared/agent-browser";

const { electronState, pageTools } = await vi.hoisted(async () => {
  const support = await import("./support/preview-broker-harness");
  return {
    electronState: support.createPreviewBrokerElectronState(),
    pageTools: support.createPreviewBrokerPageTools(),
  };
});

vi.mock("electron", async () => (
  (await import("./support/preview-broker-harness")).createPreviewBrokerElectronMock(electronState)
));
vi.mock("../../src/main/preview-agent-page", async (importOriginal) => ({
  ...pageTools,
  PRIVACY_RUNTIME: (await importOriginal<typeof import("../../src/main/preview-agent-page")>()).PRIVACY_RUNTIME,
}));

import { PreviewBroker } from "../../src/main/preview-broker";
import { conversationId, createPreviewBrokerHarness, runIdentity } from "./support/preview-broker-harness";

type Contents = (typeof electronState.contents)[number] & {
  executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>): Promise<unknown>;
};

const button = {
  found: true, blocked: false, disabled: false, editable: false,
  sensitive: false, role: "button", label: "Card", x: 100, y: 200,
};
const column = { ...button, role: "list", label: "Done", x: 600, y: 300 };

async function loadedBroker(url = "http://127.0.0.1:3000/") {
  const contentsOffset = electronState.contents.length;
  const { broker } = createPreviewBrokerHarness(PreviewBroker);
  await broker.navigate({ ownerId: "primary", contextId: conversationId, url });
  return { broker, contents: electronState.contents[contentsOffset]! as Contents };
}

function detail(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { text: string }).text) as Record<string, unknown>;
}

function commands(contents: Contents, prefix: string): Array<[string, Record<string, unknown> | undefined]> {
  return contents.debugger.sendCommand.mock.calls
    .filter(([method]) => method.startsWith(prefix))
    .map(([method, params]) => [method, params]);
}

/** Answers the drag scripts the isolated world runs; everything else keeps the harness answer. */
function isolatedWorld(contents: Contents, answers: { dragStarted?: () => boolean; outside?: boolean } = {}) {
  const original = contents.executeJavaScriptInIsolatedWorld.bind(contents);
  const scripts: string[] = [];
  vi.spyOn(contents, "executeJavaScriptInIsolatedWorld").mockImplementation(async (world, code) => {
    const source = code[0]?.code ?? "";
    if (source.includes("addEventListener(\"dragstart\"")) { scripts.push("watch"); return true; }
    if (source.includes("agentDragStart;")) { scripts.push("started"); return answers.dragStarted?.() ?? false; }
    if (source.includes("agentDragWatchStop?.(), true")) { scripts.push("stop"); return true; }
    if (source.includes("state.agentDragCancelled = true")) { scripts.push(`cancel@${contents.sentInputs.length}`); return true; }
    if (source.includes("rect.bottom <= 0 || rect.right <= 0")) return answers.outside ?? false;
    if (source.includes("getComputedStyle(element);\n    return style.visibility")) { scripts.push("rendered"); return false; }
    return await original(world, code);
  });
  return scripts;
}

/** Answers element lookups per ref. */
function locateByRef(target: (ref: string) => unknown): void {
  pageTools.locateAgentPageRef.mockImplementation((async (_contents: unknown, ref: string) => target(ref)) as never);
}

beforeEach(() => {
  pageTools.locateAgentPageRef.mockReset();
  pageTools.locateAgentPageRef.mockResolvedValue({ ...button });
  pageTools.waitForAgentPageHover.mockReset();
  pageTools.waitForAgentPageHover.mockResolvedValue(undefined);
  pageTools.showAgentPageCursor.mockClear();
  pageTools.setAgentPageInputGuard.mockClear();
  pageTools.agentPageInputRefusal.mockReset();
  pageTools.agentPageInputRefusal.mockResolvedValue(null);
  pageTools.agentPageEvidencePrivacy.mockReset();
  pageTools.agentPageEvidencePrivacy.mockResolvedValue({ withheld: null });
});

describe("Browser clicks with a count and held keys", () => {
  it("double-clicks with two presses at one point, the second counting two", async () => {
    const { broker, contents } = await loadedBroker();
    const result = await broker.perform(runIdentity, { action: "click", ref: "e1", clickCount: 2 });
    expect(result).toMatchObject({
      ok: true,
      state: { activity: { action: "click", label: "Agent double-clicked a page element", x: 100, y: 200 } },
    });
    expect(parseAgentBrowserResult(result)).not.toBeNull();
    expect(detail(result)).toMatchObject({ clicked: "e1", clickCount: 2 });
    expect(contents.sentInputs.filter(({ type }) => type !== "mouseMove")).toEqual([
      { type: "mouseDown", x: 100, y: 200, button: "left", clickCount: 1 },
      { type: "mouseUp", x: 100, y: 200, button: "left", clickCount: 1 },
      { type: "mouseDown", x: 100, y: 200, button: "left", clickCount: 2 },
      { type: "mouseUp", x: 100, y: 200, button: "left", clickCount: 2 },
    ]);
    expect(pageTools.showAgentPageCursor).toHaveBeenCalledWith(contents, 100, 200, "Agent double-click");
    expect(pageTools.setAgentPageInputGuard).toHaveBeenCalledWith(contents, true, "e1", false, undefined);
  });

  it("triple-clicks holding modifiers on every press and release", async () => {
    const { broker, contents } = await loadedBroker();
    const result = await broker.perform(runIdentity, {
      action: "click", ref: "e1", clickCount: 3, modifiers: ["Control", "Shift"],
    });
    expect(detail(result)).toMatchObject({ clicked: "e1", clickCount: 3, modifiers: ["Control", "Shift"] });
    const presses = contents.sentInputs.filter(({ type }) => type !== "mouseMove");
    expect(presses.map(({ type, clickCount }) => `${String(type)}:${String(clickCount)}`))
      .toEqual(["mouseDown:1", "mouseUp:1", "mouseDown:2", "mouseUp:2", "mouseDown:3", "mouseUp:3"]);
    expect(presses.every(({ modifiers }) => JSON.stringify(modifiers) === "[\"control\",\"shift\"]")).toBe(true);
    expect(result).toMatchObject({ state: { activity: { label: "Agent triple-clicked a page element" } } });
  });

  it("keeps a plain click to one unmodified press", async () => {
    const { broker, contents } = await loadedBroker();
    const result = await broker.perform(runIdentity, { action: "click", ref: "e1" });
    expect(detail(result)).not.toHaveProperty("clickCount");
    expect(detail(result)).not.toHaveProperty("modifiers");
    expect(contents.sentInputs.filter(({ type }) => type !== "mouseMove")).toEqual([
      { type: "mouseDown", x: 100, y: 200, button: "left", clickCount: 1 },
      { type: "mouseUp", x: 100, y: 200, button: "left", clickCount: 1 },
    ]);
  });
});

describe("Browser key presses with held keys", () => {
  it("sends the allowlisted key with the held keys and names the chord", async () => {
    const { broker, contents } = await loadedBroker();
    const result = await broker.perform(runIdentity, { action: "press", key: "ArrowRight", modifiers: ["Alt", "Shift"] });
    expect(result).toMatchObject({ ok: true, state: { activity: { label: "Agent pressed Alt+Shift+ArrowRight" } } });
    expect(detail(result)).toMatchObject({ pressed: "Alt+Shift+ArrowRight" });
    // Electron names the arrows by their accelerator names.
    expect(contents.sentInputs).toEqual([
      { type: "keyDown", keyCode: "Right", modifiers: ["alt", "shift"] },
      { type: "keyUp", keyCode: "Right", modifiers: ["alt", "shift"] },
    ]);
    expect(result.ok && result.state.controller).toBeUndefined();
  });

  it.each([
    ["ArrowUp", "Up"], ["ArrowDown", "Down"], ["ArrowLeft", "Left"], ["ArrowRight", "Right"],
  ] as const)("sends %s as Electron's %s and keeps the page as the agent's", async (key, keyCode) => {
    const { broker, contents } = await loadedBroker();
    const result = await broker.perform(runIdentity, { action: "press", key });
    expect(result).toMatchObject({ ok: true, state: { activity: { label: `Agent pressed ${key}` } } });
    expect(result.ok && result.state.controller).toBeUndefined();
    expect(contents.sentInputs).toEqual([{ type: "keyDown", keyCode }, { type: "keyUp", keyCode }]);
  });

  it("merges a chord key's own modifier with the held ones", async () => {
    const { broker, contents } = await loadedBroker();
    const result = await broker.perform(runIdentity, { action: "press", key: "Shift+Tab", modifiers: ["Control"] });
    expect(detail(result)).toMatchObject({ pressed: "Control+Shift+Tab" });
    expect(contents.sentInputs).toEqual([
      { type: "keyDown", keyCode: "Tab", modifiers: ["control", "shift"] },
      { type: "keyUp", keyCode: "Tab", modifiers: ["control", "shift"] },
    ]);
  });

  it.each([
    ["Enter", ["Alt"], ["alt"], false],
    ["Space", ["Shift"], ["shift"], true],
  ] as const)("activates %s holding %j through the guarded path, typing a character only without a shortcut key", async (key, held, sent, char) => {
    const { broker, contents } = await loadedBroker();
    await expect(broker.perform(runIdentity, { action: "press", key, modifiers: [...held] })).resolves.toMatchObject({ ok: true });
    expect(pageTools.agentPageActivationBlocked).toHaveBeenCalled();
    const keyCode = key === "Space" ? " " : key;
    expect(contents.sentInputs).toEqual([
      { type: "keyDown", keyCode, modifiers: sent },
      ...(char ? [{ type: "char", keyCode: " ", modifiers: sent }] : []),
      { type: "keyUp", keyCode, modifiers: sent },
    ]);
  });
});

describe("Browser horizontal scroll", () => {
  it("scrolls right with a Chromium wheel delta pointing left", async () => {
    const { broker, contents } = await loadedBroker();
    const result = await broker.perform(runIdentity, { action: "scroll", deltaX: 250 });
    expect(result).toMatchObject({ ok: true, state: { activity: { action: "scroll", label: "Agent scrolled right" } } });
    expect(detail(result)).toMatchObject({ scrolled: { deltaX: 250 } });
    expect(contents.sentInputs).toEqual([{ type: "mouseWheel", x: 640, y: 400, deltaX: -250, deltaY: 0 }]);
  });

  it("scrolls on both axes in one wheel event", async () => {
    const { broker, contents } = await loadedBroker();
    const result = await broker.perform(runIdentity, { action: "scroll", deltaX: -100, deltaY: 300 });
    expect(result).toMatchObject({ state: { activity: { label: "Agent scrolled down and left" } } });
    expect(detail(result)).toMatchObject({ scrolled: { deltaX: -100, deltaY: 300 } });
    expect(contents.sentInputs).toEqual([{ type: "mouseWheel", x: 640, y: 400, deltaX: 100, deltaY: -300 }]);
  });

  it("keeps the numeric result and an upward delta for a vertical scroll", async () => {
    const { broker, contents } = await loadedBroker();
    const result = await broker.perform(runIdentity, { action: "scroll", deltaY: -200 });
    expect(detail(result)).toMatchObject({ scrolled: -200 });
    expect(result).toMatchObject({ state: { activity: { label: "Agent scrolled up" } } });
    expect(contents.sentInputs).toEqual([{ type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 200 }]);
  });
});

describe("Browser drag", () => {
  const drag: AgentBrowserCommand = { action: "drag", ref: "e1", targetRef: "e2" };

  beforeEach(() => {
    locateByRef((ref) => (ref === "e2" ? { ...column } : { ...button }));
    pageTools.agentPageDropPoint.mockReset();
    pageTools.agentPageDropPoint.mockImplementation(async (_contents, ref) => (ref === "e2" ? { x: 600, y: 300 } : null));
  });

  it("drags with the pointer: press on the element, five moves, release on the target", async () => {
    const { broker, contents } = await loadedBroker();
    const scripts = isolatedWorld(contents);
    const result = await broker.perform(runIdentity, drag);
    expect(result).toMatchObject({
      ok: true,
      state: { activity: { action: "drag", label: "Agent dragged a page element", x: 600, y: 300 } },
    });
    expect(parseAgentBrowserResult(result)).not.toBeNull();
    expect(detail(result)).toMatchObject({
      dragged: "e1", onto: "e2", native: false,
      element: { role: "button", label: "Card" }, target: { role: "list", label: "Done" },
    });
    const held = ["leftbuttondown"];
    expect(contents.sentInputs).toEqual([
      { type: "mouseMove", x: 100, y: 200 },
      { type: "mouseDown", x: 100, y: 200, button: "left", clickCount: 1, modifiers: held },
      { type: "mouseMove", x: 200, y: 220, button: "left", modifiers: held },
      { type: "mouseMove", x: 300, y: 240, button: "left", modifiers: held },
      { type: "mouseMove", x: 400, y: 260, button: "left", modifiers: held },
      { type: "mouseMove", x: 500, y: 280, button: "left", modifiers: held },
      { type: "mouseMove", x: 600, y: 300, button: "left", modifiers: held },
      { type: "mouseUp", x: 600, y: 300, button: "left", clickCount: 1 },
    ]);
    expect(commands(contents, "Input.")).toEqual([
      ["Input.setInterceptDrags", { enabled: true }],
      ["Input.setInterceptDrags", { enabled: false }],
    ]);
    expect(scripts).toEqual(["watch", "started", "started", "started", "started", "started", "stop"]);
    expect(pageTools.setAgentPageInputGuard).toHaveBeenCalledWith(contents, true, "e1", true, "e2");
    expect(pageTools.setAgentPageInputGuard).toHaveBeenLastCalledWith(contents, false);
    expect(pageTools.showAgentPageCursor).toHaveBeenCalledWith(contents, 100, 200, "Agent drag");
  });

  it("finishes a native HTML drag with the page's own data and never a file", async () => {
    const { broker, contents } = await loadedBroker();
    let checks = 0;
    isolatedWorld(contents, {
      dragStarted: () => {
        checks += 1;
        if (checks !== 2) return false;
        contents.debugger.emitMessage("Input.dragIntercepted", {
          data: {
            items: [{ mimeType: "text/plain", data: "card-7" }, { mimeType: 7, data: "dropped" }],
            files: ["/Users/someone/secret.txt"],
            filenames: ["secret.txt"],
            dragOperationsMask: 1,
          },
        });
        return true;
      },
    });
    const result = await broker.perform(runIdentity, drag);
    expect(detail(result)).toMatchObject({ dragged: "e1", onto: "e2", native: true });
    const data = { items: [{ mimeType: "text/plain", data: "card-7" }], dragOperationsMask: 1 };
    expect(commands(contents, "Input.")).toEqual([
      ["Input.setInterceptDrags", { enabled: true }],
      ["Input.dispatchDragEvent", { type: "dragEnter", x: 300, y: 240, data }],
      ["Input.dispatchDragEvent", { type: "dragOver", x: 400, y: 260, data }],
      ["Input.dispatchDragEvent", { type: "dragOver", x: 500, y: 280, data }],
      ["Input.dispatchDragEvent", { type: "dragOver", x: 600, y: 300, data }],
      ["Input.dispatchDragEvent", { type: "drop", x: 600, y: 300, data }],
      ["Input.setInterceptDrags", { enabled: false }],
    ]);
    expect(contents.sentInputs.map(({ type }) => type)).toEqual(["mouseMove", "mouseDown", "mouseMove", "mouseMove"]);
  });

  it("re-aims a pointer release at a drop target the page moved during the drag", async () => {
    const { broker, contents } = await loadedBroker();
    isolatedWorld(contents);
    pageTools.agentPageDropPoint.mockResolvedValue({ x: 640, y: 320 });
    const result = await broker.perform(runIdentity, drag);
    expect(result).toMatchObject({ ok: true, state: { activity: { x: 640, y: 320 } } });
    expect(contents.sentInputs.slice(-2)).toEqual([
      { type: "mouseMove", x: 640, y: 320, button: "left", modifiers: ["leftbuttondown"] },
      { type: "mouseUp", x: 640, y: 320, button: "left", clickCount: 1 },
    ]);
  });

  it("gives the element back instead of dropping it when the target left during a pointer drag", async () => {
    const { broker, contents } = await loadedBroker();
    const scripts = isolatedWorld(contents);
    pageTools.agentPageDropPoint.mockResolvedValue(null);
    const result = await broker.perform(runIdentity, drag);
    expect(result).toMatchObject({ ok: false, code: "not-found", message: expect.stringContaining("nothing was dropped") });
    expect(contents.sentInputs.at(-1)).toEqual({ type: "mouseUp", x: 100, y: 200, button: "left", clickCount: 1 });
    expect(contents.sentInputs.some((input) => input.type === "mouseUp" && input.x === 600)).toBe(false);
    expect(scripts.slice(-2)).toEqual([`cancel@${contents.sentInputs.length - 1}`, "stop"]);
  });

  it("tells the page a drag that fails midway was given back before releasing the button", async () => {
    const { broker, contents } = await loadedBroker();
    const scripts = isolatedWorld(contents, { dragStarted: () => { throw new Error("The page went away."); } });
    await expect(broker.perform(runIdentity, drag)).resolves.toMatchObject({ ok: false });
    expect(contents.sentInputs.at(-1)).toEqual({ type: "mouseUp", x: 200, y: 220, button: "left", clickCount: 1 });
    expect(scripts.slice(-2)).toEqual([`cancel@${contents.sentInputs.length - 1}`, "stop"]);
  });

  it("cancels a native drag without a drop when the target no longer passes its check", async () => {
    const { broker, contents } = await loadedBroker();
    let lookups = 0;
    locateByRef((ref) => {
      if (ref !== "e2") return { ...button };
      lookups += 1;
      // Located, revalidated and found again after the hover; replaced while the page took the drag.
      return lookups <= 3 ? { ...column } : { found: false };
    });
    isolatedWorld(contents, {
      dragStarted: () => {
        contents.debugger.emitMessage("Input.dragIntercepted", { data: { items: [], dragOperationsMask: 1 } });
        return true;
      },
    });
    const result = await broker.perform(runIdentity, drag);
    expect(result).toMatchObject({ ok: false, code: "not-found", message: expect.stringContaining("nothing was dropped") });
    const drops = commands(contents, "Input.").filter(([, params]) => (params as { type?: string } | undefined)?.type === "drop");
    expect(drops).toEqual([]);
    expect(commands(contents, "Input.").slice(-2)).toEqual([
      ["Input.dispatchDragEvent", { type: "dragCancel", x: 600, y: 300, data: { items: [], dragOperationsMask: 1 } }],
      ["Input.setInterceptDrags", { enabled: false }],
    ]);
  });

  it("cancels an intercepted drag and gives drags back to the user when the drop fails", async () => {
    const { broker, contents } = await loadedBroker();
    isolatedWorld(contents, {
      dragStarted: () => {
        contents.debugger.emitMessage("Input.dragIntercepted", { data: { items: [], dragOperationsMask: 1 } });
        return true;
      },
    });
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === "Input.dispatchDragEvent" && params?.type === "drop") throw new Error("The drop failed.");
      return await original(method, params);
    });
    await expect(broker.perform(runIdentity, drag)).resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(commands(contents, "Input.").slice(-2)).toEqual([
      ["Input.dispatchDragEvent", { type: "dragCancel", x: 600, y: 300, data: { items: [], dragOperationsMask: 1 } }],
      ["Input.setInterceptDrags", { enabled: false }],
    ]);
  });

  it("releases at once and reports the change when the press lands on another element", async () => {
    const { broker, contents } = await loadedBroker();
    isolatedWorld(contents);
    pageTools.agentPageInputRefusal.mockResolvedValueOnce("retargeted");
    await expect(broker.perform(runIdentity, drag)).resolves.toEqual({
      ok: false,
      code: "not-found",
      message: "The dragged element or its drop target changed under the pointer. Take a new inertia_browser_snapshot for current refs.",
    });
    expect(contents.sentInputs.map(({ type, x }) => `${String(type)}@${String(x)}`))
      .toEqual(["mouseMove@100", "mouseDown@100", "mouseUp@100"]);
    expect(commands(contents, "Input.").at(-1)).toEqual(["Input.setInterceptDrags", { enabled: false }]);
  });

  it("refuses without input when either element is out of view", async () => {
    const { broker, contents } = await loadedBroker();
    isolatedWorld(contents, { outside: true });
    locateByRef((ref) => (ref === "e2" ? { found: false } : { ...button }));
    await expect(broker.perform(runIdentity, drag)).resolves.toEqual({
      ok: false,
      code: "not-found",
      message: "A drag needs both elements in view at once. Scroll with inertia_browser_scroll, or set a larger viewport with inertia_browser_resize, then take a new snapshot and try again.",
    });
    expect(contents.sentInputs).toEqual([]);
    expect(commands(contents, "Input.")).toEqual([]);
  });

  it.each([
    ["a blocked target", "e2", { ...column, blocked: true }, "invalid", "That page element cannot be controlled by the Browser agent."],
    ["a disabled source", "e1", { ...button, disabled: true }, "invalid", "That page element is disabled."],
    ["a stale target", "e2", { found: false }, "not-found", "That page element is stale. Take a new inertia_browser_snapshot for current refs."],
  ])("refuses %s without input", async (_name, ref, target, code, message) => {
    const { broker, contents } = await loadedBroker();
    isolatedWorld(contents);
    locateByRef((candidate) => (candidate === ref ? target : candidate === "e2" ? { ...column } : { ...button }));
    await expect(broker.perform(runIdentity, drag)).resolves.toEqual({ ok: false, code, message });
    expect(contents.sentInputs).toEqual([]);
  });

  it("refuses a drag in a blank tab", async () => {
    const { broker } = createPreviewBrokerHarness(PreviewBroker);
    await expect(broker.perform(runIdentity, drag))
      .resolves.toMatchObject({ ok: false, code: "not-found", message: expect.stringContaining("This tab is blank") });
  });
});

describe("Browser waits on the path and on a ref", () => {
  const wait = (fields: Record<string, unknown>) => ({ action: "wait", state: "present", timeoutMs: 250, ...fields }) as AgentBrowserCommand;

  it("matches the whole path with one-segment wildcards and never reads the page for it", async () => {
    const { broker } = await loadedBroker("http://127.0.0.1:3000/orders/42?token=secret");
    pageTools.semanticPageSnapshot.mockClear();
    expect(detail(await broker.perform(runIdentity, wait({ path: "/orders/*" })))).toMatchObject({ matched: true });
    expect(detail(await broker.perform(runIdentity, wait({ path: "/login", state: "absent" })))).toMatchObject({ matched: true });
    const missed = detail(await broker.perform(runIdentity, wait({ path: "/orders" })));
    expect(missed).toMatchObject({ matched: false });
    expect(JSON.stringify(missed)).not.toContain("/orders/42");
    expect(JSON.stringify(missed)).not.toContain("secret");
    expect(pageTools.semanticPageSnapshot).not.toHaveBeenCalled();
  });

  it("waits for a ref to stop being rendered after a guarded page read", async () => {
    const { broker, contents } = await loadedBroker();
    pageTools.semanticPageSnapshot.mockClear();
    const scripts = isolatedWorld(contents);
    expect(detail(await broker.perform(runIdentity, wait({ ref: "e3", state: "absent" })))).toMatchObject({ matched: true });
    expect(pageTools.semanticPageSnapshot).toHaveBeenCalled();
    expect(scripts).toEqual(["rendered"]);
    expect(detail(await broker.perform(runIdentity, wait({ ref: "e3" })))).toMatchObject({ matched: false });
  });

  it("requires every condition: text, path and ref together", async () => {
    const { broker, contents } = await loadedBroker("http://127.0.0.1:3000/done");
    isolatedWorld(contents);
    pageTools.semanticPageSnapshot.mockResolvedValue(JSON.stringify({ title: "Local app", text: "All saved", elements: [] }));
    expect(detail(await broker.perform(runIdentity, wait({ text: "saved", path: "/done", ref: "e3", state: "present" }))))
      .toMatchObject({ matched: false });
    expect(detail(await broker.perform(runIdentity, wait({ text: "Missing", path: "/elsewhere", ref: "e3", state: "absent" }))))
      .toMatchObject({ matched: true });
    expect(detail(await broker.perform(runIdentity, wait({ text: "saved", path: "/done" }))))
      .toMatchObject({ matched: true });
  });

  it("withholds a ref condition on a page whose evidence is withheld, as a snapshot would", async () => {
    const { broker, contents } = await loadedBroker();
    const scripts = isolatedWorld(contents);
    pageTools.agentPageEvidencePrivacy.mockResolvedValue({ withheld: "hidden-input" });
    await expect(broker.perform(runIdentity, wait({ ref: "e3", state: "absent" })))
      .resolves.toMatchObject({ ok: false, code: "sensitive" });
    expect(scripts).toEqual([]);
  });
});
