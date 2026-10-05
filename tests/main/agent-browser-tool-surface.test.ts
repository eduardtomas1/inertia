import { describe, expect, it, vi } from "vitest";

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
vi.mock("../../src/main/preview-agent-page", () => pageTools);

import { PreviewBroker } from "../../src/main/preview-broker";
import {
  conversationId,
  createPreviewBrokerHarness,
  runIdentity,
} from "./support/preview-broker-harness";

async function loadedHarness() {
  const contentsOffset = electronState.contents.length;
  const created = createPreviewBrokerHarness(PreviewBroker);
  await created.broker.navigate({
    ownerId: "primary",
    contextId: conversationId,
    url: "http://127.0.0.1:3000/",
  });
  return { ...created, contents: electronState.contents[contentsOffset]! };
}

describe("Browser tool surface", () => {
  it("tells the agent to take a new snapshot when a ref is stale", async () => {
    const { broker } = await loadedHarness();
    pageTools.locateAgentPageRef.mockResolvedValueOnce({ found: false });
    await expect(broker.perform(runIdentity, { action: "click", ref: "e9" })).resolves.toEqual({
      ok: false,
      code: "not-found",
      message: "That page element is stale. Take a new inertia_browser_snapshot for current refs.",
    });
  });

  it("presses modifier keys with trusted input and keeps modified Enter on the guarded activation path", async () => {
    const { broker, contents } = await loadedHarness();
    for (const key of ["Shift+Tab", "Shift+Enter", "Control+Enter", "Meta+Enter"] as const) {
      await expect(broker.perform(runIdentity, { action: "press", key }))
        .resolves.toMatchObject({ ok: true });
    }
    expect(contents.sentInputs).toEqual([
      { type: "keyDown", keyCode: "Tab", modifiers: ["shift"] },
      { type: "keyUp", keyCode: "Tab", modifiers: ["shift"] },
      { type: "keyDown", keyCode: "Enter", modifiers: ["shift"] },
      { type: "char", keyCode: "\r", modifiers: ["shift"] },
      { type: "keyUp", keyCode: "Enter", modifiers: ["shift"] },
      { type: "keyDown", keyCode: "Enter", modifiers: ["control"] },
      { type: "keyUp", keyCode: "Enter", modifiers: ["control"] },
      { type: "keyDown", keyCode: "Enter", modifiers: ["meta"] },
      { type: "keyUp", keyCode: "Enter", modifiers: ["meta"] },
    ]);
    expect(pageTools.agentPageActivationBlocked).toHaveBeenCalled();
  });

  it("goes back, forward and reloads only to local pages and waits for the load", async () => {
    const { broker, contents } = await loadedHarness();
    const history = contents.navigationHistory as typeof contents.navigationHistory & {
      canGoForward: ReturnType<typeof vi.fn>;
      goForward: ReturnType<typeof vi.fn>;
    };
    const entries = ["about:blank", "http://127.0.0.1:3000/first", "http://127.0.0.1:3000/"];
    history.getEntryAtIndex.mockImplementation((index: number) => ({ title: "", url: entries[index] ?? "" }));
    history.canGoBack.mockReturnValue(true);
    history.goBack.mockImplementationOnce(() => {
      contents.setURL(entries[1]!);
      contents.emit("did-start-loading");
      contents.emit("did-stop-loading");
    });
    await expect(broker.perform(runIdentity, { action: "history", direction: "back" }))
      .resolves.toMatchObject({ ok: true, state: { activity: { action: "navigate" } } });
    expect(history.goBack).toHaveBeenCalledOnce();

    history.getActiveIndex.mockReturnValue(1);
    await expect(broker.perform(runIdentity, { action: "history", direction: "back" })).resolves.toEqual({
      ok: false,
      code: "invalid",
      message: "There is no earlier local page in this tab's history. Navigate to a URL instead.",
    });
    expect(history.goBack).toHaveBeenCalledOnce();

    history.canGoForward.mockReturnValue(true);
    entries[2] = "https://example.com/";
    await expect(broker.perform(runIdentity, { action: "history", direction: "forward" }))
      .resolves.toMatchObject({ ok: false, code: "invalid" });
    expect(history.goForward).not.toHaveBeenCalled();

    const reload = vi.spyOn(contents as unknown as { reload(): void }, "reload").mockImplementationOnce(() => {
      contents.emit("did-start-loading");
      contents.emit("did-stop-loading");
    });
    await expect(broker.perform(runIdentity, { action: "history", direction: "reload" }))
      .resolves.toMatchObject({ ok: true });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("opens schemeless loopback addresses over http", async () => {
    const { broker, contents } = await loadedHarness();
    await expect(broker.perform(runIdentity, { action: "navigate", url: "localhost:5173/settings" }))
      .resolves.toMatchObject({ ok: true });
    expect(contents.getURL()).toBe("http://localhost:5173/settings");
    await expect(broker.perform(runIdentity, { action: "tab-open", url: "127.0.0.1:3000" }))
      .resolves.toMatchObject({ ok: true });
    expect(electronState.contents.at(-1)!.getURL()).toBe("http://127.0.0.1:3000/");
    await expect(broker.perform(runIdentity, { action: "navigate", url: "example.com:5173" }))
      .resolves.toMatchObject({ ok: false, code: "invalid" });
  });

  it("stops an agent command when the user clicks or types in the page and reports the user in control", async () => {
    const { broker, contents } = await loadedHarness();
    const waiting = broker.perform(runIdentity, {
      action: "wait", text: "never shown", state: "present", timeoutMs: 10_000,
    });
    await vi.waitFor(() => expect(pageTools.semanticPageSnapshot).toHaveBeenCalled());
    contents.emit("input-event", {}, { type: "mouseMove", x: 5, y: 5 });
    contents.emit("input-event", {}, { type: "mouseDown", x: 5, y: 5 });
    await expect(waiting).resolves.toEqual({
      ok: false,
      code: "interrupted",
      message: "The user is using this page; take a new snapshot before continuing.",
    });
    const tabs = await broker.perform(runIdentity, { action: "tabs" });
    expect(tabs).toMatchObject({ ok: true, state: { controller: "user" } });
    expect(JSON.parse((tabs as unknown as { text: string }).text)).toMatchObject({ controller: "user" });
    await expect(broker.perform(runIdentity, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true, state: { controller: "user" } });
    const after = await broker.perform(runIdentity, { action: "tabs" });
    expect(after).toMatchObject({ ok: true });
    expect((after as unknown as { state: Record<string, unknown> }).state).not.toHaveProperty("controller");

    await expect(broker.perform(runIdentity, { action: "click", ref: "e1" }))
      .resolves.toMatchObject({ ok: true });
    expect((await broker.perform(runIdentity, { action: "tabs" }) as unknown as { state: Record<string, unknown> }).state)
      .not.toHaveProperty("controller");
  });

  it("arms the confirmation answer only around the agent's own click and reports the page's dialogs", async () => {
    const { broker, contents } = await loadedHarness();
    const timeline: string[] = [];
    const page = contents as unknown as {
      executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>): Promise<unknown>;
    };
    const original = page.executeJavaScriptInIsolatedWorld.bind(page);
    vi.spyOn(page, "executeJavaScriptInIsolatedWorld").mockImplementation(async (world, scripts) => {
      const code = scripts[0]?.code ?? "";
      const armed = /__inertia_agent_dialog_answer__", \{ detail: "(accept|dismiss)"/u.exec(code)?.[1];
      if (armed) timeline.push(`arm:${armed}`);
      if (code.includes("__inertiaAgentDialogs")) {
        timeline.push("read");
        return [{ kind: "confirm", message: "Delete [redacted]?", answer: "accept" }];
      }
      return await original(world, scripts);
    });
    const sender = contents as unknown as { sendInputEvent(input: Record<string, unknown>): void };
    const sent = sender.sendInputEvent.bind(sender);
    vi.spyOn(sender, "sendInputEvent")
      .mockImplementation((input) => {
        if (input.type === "mouseDown") timeline.push("mouseDown");
        sent(input);
      });

    const accepted = await broker.perform(runIdentity, { action: "click", ref: "e1", dialog: "accept" });
    expect(JSON.parse((accepted as { text: string }).text)).toMatchObject({
      clicked: "e1",
      dialogs: [{ kind: "confirm", message: "Delete [redacted]?", answer: "accept" }],
    });
    expect(timeline).toEqual(["arm:accept", "mouseDown", "arm:dismiss", "read"]);

    timeline.length = 0;
    await expect(broker.perform(runIdentity, { action: "click", ref: "e1" })).resolves.toMatchObject({ ok: true });
    expect(timeline).toEqual(["mouseDown", "read"]);
    timeline.length = 0;
    const typed = await broker.perform(runIdentity, { action: "type", ref: "e1", text: "a", replace: true });
    expect(JSON.parse((typed as { text: string }).text)).toMatchObject({ typed: "e1", dialogs: [{ kind: "confirm" }] });
    timeline.length = 0;
    await expect(broker.perform(runIdentity, { action: "press", key: "Enter", dialog: "accept" }))
      .resolves.toMatchObject({ ok: true });
    expect(timeline).toEqual(["arm:accept", "arm:dismiss", "read"]);
  });

  it("lets a page leave even when its beforeunload handler asks to stay, and reports it", async () => {
    const { broker, contents } = await loadedHarness();
    const prevented = { preventDefault: vi.fn() };
    contents.emit("will-prevent-unload", prevented);
    expect(prevented.preventDefault).toHaveBeenCalledOnce();
    const clicked = await broker.perform(runIdentity, { action: "click", ref: "e1" });
    expect(JSON.parse((clicked as { text: string }).text)).toMatchObject({
      dialogs: [{ kind: "beforeunload", message: "", answer: "accept" }],
    });
  });

  it("reports the page's dialogs once in the next snapshot", async () => {
    const { broker, contents } = await loadedHarness();
    const send = contents.debugger.sendCommand.getMockImplementation()!;
    let reads = 0;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === "Runtime.evaluate" && String(params?.expression).includes("__inertiaAgentDialogs")) {
        reads += 1;
        return { result: { value: reads === 1 ? [{ kind: "alert", message: "Saved", answer: "accept" }] : [] } };
      }
      return await send(method, params);
    });
    await expect(broker.perform(runIdentity, { action: "snapshot" })).resolves.toMatchObject({ ok: true });
    expect(pageTools.semanticPageSnapshot).toHaveBeenLastCalledWith(contents, [], {
      dialogs: [{ kind: "alert", message: "Saved", answer: "accept" }],
    });
    await expect(broker.perform(runIdentity, { action: "snapshot" })).resolves.toMatchObject({ ok: true });
    expect(pageTools.semanticPageSnapshot).toHaveBeenLastCalledWith(contents, []);
    contents.debugger.sendCommand.mockImplementation(send);
  });

  function isolatedScripts(contents: object, offscreen: () => boolean) {
    const page = contents as unknown as {
      executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>): Promise<unknown>;
    };
    const codes: string[] = [];
    const original = page.executeJavaScriptInIsolatedWorld.bind(page);
    vi.spyOn(page, "executeJavaScriptInIsolatedWorld").mockImplementation(async (world, scripts) => {
      const code = scripts[0]?.code ?? "";
      if (code.includes("scrollIntoView")) {
        codes.push("scroll");
        return { found: true, viewport: { width: 1_280, height: 800, scrollX: 0, scrollY: 1_400 } };
      }
      if (code.includes("getBoundingClientRect")) {
        codes.push("outside");
        return offscreen();
      }
      return await original(world, scripts);
    });
    return codes;
  }

  it("scrolls an element into view by ref and returns the viewport", async () => {
    const { broker, contents } = await loadedHarness();
    const codes = isolatedScripts(contents, () => true);
    const result = await broker.perform(runIdentity, { action: "scroll", ref: "e7" });
    expect(JSON.parse((result as { text: string }).text)).toMatchObject({
      scrolled: "e7",
      viewport: { width: 1_280, height: 800, scrollX: 0, scrollY: 1_400 },
    });
    expect(codes).toEqual(["scroll"]);
    expect(contents.sentInputs).toEqual([]);
  });

  it("scrolls an off-screen ref into view before clicking or typing, then hit-tests it as usual", async () => {
    const { broker, contents } = await loadedHarness();
    let outside = true;
    const codes = isolatedScripts(contents, () => outside);
    pageTools.locateAgentPageRef.mockResolvedValueOnce({ found: false });
    await expect(broker.perform(runIdentity, { action: "click", ref: "e9" })).resolves.toMatchObject({ ok: true });
    expect(codes).toEqual(["outside", "scroll"]);
    expect(contents.sentInputs).toEqual(expect.arrayContaining([expect.objectContaining({ type: "mouseDown" })]));

    codes.length = 0;
    pageTools.locateAgentPageRef.mockResolvedValueOnce({ found: false });
    await expect(broker.perform(runIdentity, { action: "type", ref: "e9", text: "a", replace: true }))
      .resolves.toMatchObject({ ok: true });
    expect(codes).toEqual(["outside", "scroll"]);

    codes.length = 0;
    outside = false;
    pageTools.locateAgentPageRef.mockResolvedValueOnce({ found: false });
    await expect(broker.perform(runIdentity, { action: "click", ref: "e9" })).resolves.toMatchObject({
      ok: false, code: "not-found",
    });
    expect(codes).toEqual(["outside"]);
  });

  it("asks a supervised agent to scroll before it approves a click on an off-screen control", async () => {
    const { broker, contents } = await loadedHarness();
    const codes = isolatedScripts(contents, () => true);
    pageTools.locateAgentPageRef.mockResolvedValueOnce({ found: false });
    await expect(broker.perform(runIdentity, {
      action: "prepare-approval", command: { action: "click", ref: "e9" },
    })).resolves.toEqual({
      ok: false,
      code: "not-found",
      message: "That control is outside the visible part of the page. Scroll it into view with inertia_browser_scroll and its ref, then try again.",
    });
    expect(codes).toEqual(["outside"]);
  });
});
