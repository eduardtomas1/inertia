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
  connectionId,
  conversationId,
  createPreviewBrokerHarness,
  runIdentity,
} from "./support/preview-broker-harness";

const harness = () => createPreviewBrokerHarness(PreviewBroker);

describe("conversation-owned Browser sessions", () => {
  it("keeps a chat's pages when its panel closes and shows them again when it returns", async () => {
    const { broker, children, window } = harness();
    const contentsOffset = electronState.contents.length;
    const sessionOffset = electronState.sessions.length;
    const owner = { ownerId: "primary", contextId: conversationId, connectionId };
    const otherConversationId = "44444444-4444-4444-8444-444444444444";
    const otherConnectionId = "55555555-5555-4555-8555-555555555555";
    const bounds = { x: 10, y: 20, width: 900, height: 600 };
    broker.connect(owner);
    broker.setBounds({ ...owner, bounds });
    await broker.navigate({ ...owner, url: "http://127.0.0.1:3000/kept" });
    const contents = electronState.contents[contentsOffset]!;

    broker.closeRequest(owner);
    const other = { ownerId: "primary", contextId: otherConversationId, connectionId: otherConnectionId };
    expect(broker.connect(other).tabs).toEqual([]);
    broker.setBounds({ ...other, bounds });
    expect(contents.isDestroyed()).toBe(false);
    expect(electronState.sessions[sessionOffset]!.clearStorageData).not.toHaveBeenCalled();
    expect(children).toHaveLength(2);

    await expect(broker.perform(runIdentity, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true, text: expect.stringContaining("Local app") });
    window.webContents.send.mockClear();
    await expect(broker.perform(runIdentity, {
      action: "navigate",
      url: "http://127.0.0.1:3000/background",
    })).resolves.toMatchObject({ ok: true });
    expect(window.webContents.send).not.toHaveBeenCalledWith(
      "preview-state",
      expect.objectContaining({ contextId: conversationId }),
    );

    broker.closeRequest(other);
    const returned = broker.connect(owner);
    expect(returned.url).toBe("http://127.0.0.1:3000/background");
    broker.setBounds({ ...owner, bounds });
    const view = children.find((child) => child.webContents === contents as never)!;
    expect(Reflect.get(view, "visible")).toBe(true);
    expect(Reflect.get(view, "bounds")).toEqual(bounds);
  });

  it("hides every Browser without closing its pages when the renderer reloads", async () => {
    const { broker, children } = harness();
    const contentsOffset = electronState.contents.length;
    const owner = { ownerId: "primary", contextId: conversationId, connectionId };
    const bounds = { x: 10, y: 20, width: 900, height: 600 };
    broker.connect(owner);
    broker.setBounds({ ...owner, bounds });
    await broker.navigate({ ...owner, url: "http://127.0.0.1:3000/reloaded" });

    broker.releaseSurfaces();
    expect(Reflect.get(children[0]!, "visible")).toBe(false);
    expect(electronState.contents[contentsOffset]!.isDestroyed()).toBe(false);
    expect(broker.setBounds({ ...owner, bounds })).toBe(false);
    await expect(broker.perform(runIdentity, { action: "tabs" })).resolves.toMatchObject({
      ok: true,
      state: { tabs: [{ url: "http://127.0.0.1:3000" }] },
    });

    expect(broker.connect({ ...owner, recoverMissingLease: true }).url)
      .toBe("http://127.0.0.1:3000/reloaded");
    expect(broker.setBounds({ ...owner, bounds })).toBe(true);
    expect(Reflect.get(children[0]!, "visible")).toBe(true);
  });

  it("gives a chat without a visible panel a real page size and keeps its page awake while the agent acts", async () => {
    vi.useFakeTimers();
    try {
      const { broker, children } = harness();
      const contentsOffset = electronState.contents.length;
      await expect(broker.perform(runIdentity, {
        action: "navigate",
        url: "http://127.0.0.1:3000/headless",
      })).resolves.toMatchObject({ ok: true });
      const contents = electronState.contents[contentsOffset]! as unknown as { throttling: boolean[] };
      expect(children).toHaveLength(1);
      expect(Reflect.get(children[0]!, "bounds")).toEqual({ x: 0, y: 0, width: 1_280, height: 800 });
      expect(Reflect.get(children[0]!, "visible")).toBe(false);
      expect(contents.throttling).toEqual([false]);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(broker.perform(runIdentity, { action: "tabs" }))
        .resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(contents.throttling).toEqual([false, false]);
      await vi.advanceTimersByTimeAsync(1);
      expect(contents.throttling).toEqual([false, false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores background throttling after a cancelled or timed-out command but not while the next one runs", async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness();
      const contentsOffset = electronState.contents.length;
      await broker.perform(runIdentity, { action: "tabs" });
      const contents = electronState.contents[contentsOffset]! as unknown as { throttling: boolean[] };
      await vi.advanceTimersByTimeAsync(2_000);
      expect(contents.throttling).toEqual([false, true]);

      electronState.loadOverrides.push(async () => await new Promise<void>(() => undefined));
      const controller = new AbortController();
      const cancelled = broker.perform(runIdentity, {
        action: "navigate",
        url: "http://127.0.0.1:3000/cancelled",
      }, controller.signal);
      let finishNext = (): void => undefined;
      electronState.loadOverrides.push(async () => {
        await new Promise<void>((resolve) => { finishNext = resolve; });
      });
      const next = broker.perform(runIdentity, {
        action: "navigate",
        url: "http://127.0.0.1:3000/next",
      });
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await expect(cancelled).resolves.toMatchObject({ ok: false, code: "cancelled" });
      await vi.advanceTimersByTimeAsync(10);
      expect(electronState.loadOverrides).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(contents.throttling.at(-1)).toBe(false);

      finishNext();
      await expect(next).resolves.toMatchObject({ ok: true });
      expect(contents.throttling.at(-1)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(contents.throttling.at(-1)).toBe(true);

      pageTools.semanticPageSnapshot.mockImplementationOnce(async () => await new Promise<string>(() => undefined));
      const stalled = broker.perform(runIdentity, { action: "snapshot" });
      await vi.advanceTimersByTimeAsync(14_000);
      expect(contents.throttling.at(-1)).toBe(false);
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(stalled).resolves.toMatchObject({ ok: false, code: "timeout" });
      expect(contents.throttling.at(-1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the least recently used hidden Browser once five chats hold one", async () => {
    let now = 1_000;
    const window = harness().window;
    const broker = new PreviewBroker({
      getWindow: () => window as never,
      openExternal: vi.fn(async () => undefined),
      stateChannel: "preview-state",
      now: () => now,
    });
    const contentsOffset = electronState.contents.length;
    const identities = [1, 2, 3, 4, 5].map((index) => ({
      ...runIdentity,
      conversationId: `6666666${index}-6666-4666-8666-666666666666`,
    }));
    for (const identity of identities) {
      now += 1_000;
      await expect(broker.perform(identity, { action: "tabs" }))
        .resolves.toMatchObject({ ok: true });
    }
    const created = electronState.contents.slice(contentsOffset);
    expect(created).toHaveLength(5);
    expect(created.map((contents) => contents.isDestroyed()))
      .toEqual([true, false, false, false, false]);

    const shown = { ownerId: "primary", contextId: identities[2]!.conversationId, connectionId };
    broker.connect(shown);
    broker.setBounds({ ...shown, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    now += 1_000;
    await expect(broker.perform({
      ...runIdentity,
      conversationId: "66666669-6666-4666-8666-666666666666",
    }, { action: "tabs" })).resolves.toMatchObject({ ok: true });
    expect(electronState.contents.slice(contentsOffset).map((contents) => contents.isDestroyed()))
      .toEqual([true, false, false, false, false, false]);
    const leastRecent = {
      ownerId: "primary",
      contextId: identities[1]!.conversationId,
      connectionId: "55555555-5555-4555-8555-555555555555",
    };
    expect(broker.connect(leastRecent).tabs).toHaveLength(1);
    expect(electronState.contents.slice(contentsOffset).map((contents) => contents.isDestroyed()))
      .toEqual([true, false, false, false, false, false]);
    broker.closeRequest(leastRecent);
    expect(electronState.contents.slice(contentsOffset).map((contents) => contents.isDestroyed()))
      .toEqual([true, false, false, true, false, false]);

    vi.useFakeTimers();
    try {
      now += 31 * 60_000;
      const owner = { ownerId: "primary", contextId: identities[4]!.conversationId, connectionId };
      broker.connect(owner);
      broker.setBounds({ ...owner, bounds: { x: 0, y: 0, width: 800, height: 600 } });
      broker.closeRequest(owner);
      expect(electronState.contents.slice(contentsOffset).map((contents) => contents.isDestroyed()))
        .toEqual([true, true, true, true, false, true]);
    } finally {
      vi.useRealTimers();
    }
    broker.close();
  });

  it("closes a hidden Browser thirty minutes after its last use even when another chat hides one meanwhile", async () => {
    vi.useFakeTimers();
    try {
      const window = harness().window;
      const broker = new PreviewBroker({
        getWindow: () => window as never,
        openExternal: vi.fn(async () => undefined),
        stateChannel: "preview-state",
      });
      const contentsOffset = electronState.contents.length;
      const first = { ...runIdentity, conversationId: "77777771-7777-4777-8777-777777777777" };
      const second = { ...runIdentity, conversationId: "77777772-7777-4777-8777-777777777777" };
      await expect(broker.perform(first, { action: "tabs" })).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      await expect(broker.perform(second, { action: "tabs" })).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(electronState.contents.slice(contentsOffset).map((contents) => contents.isDestroyed()))
        .toEqual([true, false]);

      broker.close();
      expect(electronState.contents.slice(contentsOffset).map((contents) => contents.isDestroyed()))
        .toEqual([true, true]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to four hidden Browsers once the agents that kept a fifth open finish", async () => {
    let now = 1_000;
    const window = harness().window;
    const broker = new PreviewBroker({
      getWindow: () => window as never,
      openExternal: vi.fn(async () => undefined),
      stateChannel: "preview-state",
      now: () => now,
    });
    const contentsOffset = electronState.contents.length;
    const finishLoads: Array<() => void> = [];
    const navigations = [1, 2, 3, 4].map((index) => {
      now += 1_000;
      electronState.loadOverrides.push(async () => {
        await new Promise<void>((resolve) => { finishLoads.push(resolve); });
      });
      return broker.perform({
        ...runIdentity,
        conversationId: `8888888${index}-8888-4888-8888-888888888888`,
      }, { action: "navigate", url: "http://127.0.0.1:3000/busy" });
    });
    await vi.waitFor(() => expect(finishLoads).toHaveLength(4));
    now += 1_000;
    await expect(broker.perform({
      ...runIdentity,
      conversationId: "88888885-8888-4888-8888-888888888888",
    }, { action: "tabs" })).resolves.toMatchObject({ ok: true });
    const created = electronState.contents.slice(contentsOffset);
    expect(created.map((contents) => contents.isDestroyed()))
      .toEqual([false, false, false, false, false]);

    now += 1_000;
    for (const finish of finishLoads) finish();
    await expect(Promise.all(navigations)).resolves.toMatchObject([
      { ok: true }, { ok: true }, { ok: true }, { ok: true },
    ]);
    expect(created.map((contents) => contents.isDestroyed()))
      .toEqual([false, false, false, false, true]);
    broker.close();
  });

  it("answers a snapshot of a blank tab with the next step instead of an error", async () => {
    const { broker } = harness();
    const snapshot = await broker.perform(runIdentity, { action: "snapshot" });
    expect(snapshot).toMatchObject({ ok: true, state: { tabs: [{ url: "" }] } });
    if (!snapshot.ok) return;
    expect(JSON.parse(snapshot.text)).toEqual({
      blank: true,
      nextStep: expect.stringContaining("navigate tool"),
    });
    expect(pageTools.semanticPageSnapshot).not.toHaveBeenCalled();

    for (const command of [
      { action: "click", ref: "e1" },
      { action: "type", ref: "e1", text: "hello", replace: true },
      { action: "press", key: "Enter" },
      { action: "scroll", deltaY: 200 },
      { action: "screenshot" },
    ] as const) {
      await expect(broker.perform(runIdentity, command), command.action).resolves.toMatchObject({
        ok: false,
        code: "not-found",
        message: expect.stringContaining("This tab is blank"),
      });
    }
    const waited = await broker.perform(runIdentity, {
      action: "wait", text: "Ready", state: "present", timeoutMs: 5_000,
    });
    expect(waited).toMatchObject({ ok: true });
    expect(JSON.parse((waited as { text: string }).text)).toMatchObject({
      matched: false,
      nextStep: expect.stringContaining("This tab is blank"),
    });

    await expect(broker.perform(runIdentity, {
      action: "prepare-approval",
      command: { action: "click", ref: "e1" },
    })).resolves.toMatchObject({
      ok: false,
      code: "not-found",
      message: expect.stringContaining("This tab is blank"),
    });
    await expect(broker.perform(runIdentity, {
      action: "prepare-approval",
      command: { action: "scroll", deltaY: 200 },
    })).resolves.toMatchObject({
      ok: false,
      code: "not-found",
      message: expect.stringContaining("This tab is blank"),
    });
    const stillBlank = await broker.perform(runIdentity, { action: "snapshot" });
    expect(JSON.parse((stillBlank as { text: string }).text)).toMatchObject({ blank: true });
    expect(pageTools.semanticPageSnapshot).not.toHaveBeenCalled();
  });

  it("explains a failed navigation and names the recovery", async () => {
    const { broker, recordOperationFailure } = harness();
    const navigate = async (message: string) => {
      electronState.loadOverrides.push(async () => { throw new Error(message); });
      return await broker.perform(runIdentity, {
        action: "navigate",
        url: "http://127.0.0.1:3000/private/path?token=never-echo",
      });
    };

    const refused = await navigate("ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:3000/private/path?token=never-echo'");
    expect(refused).toEqual({
      ok: false,
      code: "unavailable",
      message: "Nothing answered at that address (connection refused). Start the development server or check its port, then navigate again.",
    });
    expect(recordOperationFailure.mock.calls).toEqual([[{ phase: "page-load", category: "failed" }]]);
    await expect(navigate("ERR_UNSAFE_PORT (-312) loading"))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining("different port") });
    await expect(navigate("ERR_CERT_AUTHORITY_INVALID (-202) loading"))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining("certificate is not trusted") });
    const unknown = await navigate("ERR_SOMETHING_NEW (-999) loading 'http://127.0.0.1:3000/private/path?token=never-echo'");
    expect(unknown).toMatchObject({
      ok: false,
      code: "unavailable",
      message: "The page could not be loaded (ERR_SOMETHING_NEW). Check that the development server is running, then navigate again.",
    });
    expect(JSON.stringify([refused, unknown])).not.toContain("never-echo");

    await expect(navigate("ERR_ABORTED (-3) loading")).resolves.toEqual({
      ok: false,
      code: "unavailable",
      message: expect.stringContaining("cancelled before a page loaded"),
    });

    electronState.loadOverrides.push(async () => { throw new Error("ERR_ABORTED (-3) loading"); });
    const replaced = await broker.perform(runIdentity, {
      action: "navigate",
      url: "http://127.0.0.1:3000/redirects-itself",
    });
    expect(replaced).toMatchObject({ ok: true });
    expect(JSON.parse((replaced as { text: string }).text)).toMatchObject({
      note: expect.stringContaining("replaced this navigation"),
    });
  });

  it("reports a slow page as still loading without stopping it", async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness();
      const contentsOffset = electronState.contents.length;
      let finishLoad = (): void => undefined;
      electronState.loadOverrides.push(async () => {
        await new Promise<void>((resolve) => { finishLoad = resolve; });
      });
      const navigation = broker.perform(runIdentity, {
        action: "navigate",
        url: "http://127.0.0.1:3000/slow-first-compile",
      });
      await vi.advanceTimersByTimeAsync(41_999);
      let settled = false;
      void navigation.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await navigation;
      expect(result).toMatchObject({ ok: true, state: { tabs: [{ loading: true }] } });
      if (result.ok) {
        expect(JSON.parse(result.text)).toMatchObject({
          note: expect.stringContaining("still loading"),
        });
      }
      const contents = electronState.contents[contentsOffset]!;
      expect(contents.stop).not.toHaveBeenCalled();

      const waiting = broker.perform(runIdentity, {
        action: "wait", state: "present", timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(800);
      finishLoad();
      await vi.advanceTimersByTimeAsync(400);
      const waited = await waiting;
      expect(waited).toMatchObject({ ok: true, state: { tabs: [{ loading: false }] } });
      if (waited.ok) expect(JSON.parse(waited.text)).toMatchObject({ matched: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for visible text or a control name to appear or disappear", async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness();
      await broker.navigate({
        ownerId: "primary",
        contextId: conversationId,
        url: "http://127.0.0.1:3000/",
      });
      const pageWith = (text: string, name = "Run") => JSON.stringify({
        title: "Local app", text, elements: [{ ref: "e1", name, value: "" }],
      });
      pageTools.semanticPageSnapshot
        .mockResolvedValueOnce(pageWith("Loading"))
        .mockResolvedValueOnce(pageWith("Loading"))
        .mockResolvedValueOnce(pageWith("Report   READY"));
      const appear = broker.perform(runIdentity, {
        action: "wait", text: "report ready", state: "present", timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(800);
      const appeared = await appear;
      expect(appeared).toMatchObject({ ok: true });
      if (appeared.ok) {
        expect(JSON.parse(appeared.text)).toMatchObject({ matched: true, waitedMs: 800 });
        expect(appeared.text).not.toContain("Report");
      }

      pageTools.semanticPageSnapshot.mockResolvedValueOnce(pageWith("", "Save draft"));
      const named = await broker.perform(runIdentity, {
        action: "wait", text: "save draft", state: "present", timeoutMs: 5_000,
      });
      expect(named).toMatchObject({ ok: true });
      expect(JSON.parse((named as { text: string }).text)).toMatchObject({ matched: true, waitedMs: 0 });

      pageTools.semanticPageSnapshot
        .mockResolvedValueOnce(pageWith("Saving…"))
        .mockResolvedValueOnce(pageWith("Saved"));
      const vanish = broker.perform(runIdentity, {
        action: "wait", text: "Saving", state: "absent", timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(400);
      const vanished = await vanish;
      expect(vanished).toMatchObject({ ok: true });
      expect(JSON.parse((vanished as { text: string }).text)).toMatchObject({ matched: true });

      const contents = electronState.contents.at(-1)!;
      const lifecycleCalls = contents.debugger.sendCommand.mock.calls
        .filter(([method]) => method === "Page.setWebLifecycleState").length;
      pageTools.semanticPageSnapshot
        .mockRejectedValueOnce(new Error("The Browser page changed while it was frozen for evidence capture."))
        .mockResolvedValueOnce(pageWith("Reloaded"));
      const reloading = broker.perform(runIdentity, {
        action: "wait", text: "Reloaded", state: "present", timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(400);
      const reloaded = await reloading;
      expect(reloaded).toMatchObject({ ok: true });
      expect(JSON.parse((reloaded as { text: string }).text)).toMatchObject({ matched: true });
      expect(contents.debugger.sendCommand.mock.calls
        .filter(([method]) => method === "Page.setWebLifecycleState")).toHaveLength(lifecycleCalls);

      pageTools.semanticPageSnapshot.mockResolvedValue(pageWith("Loading"));
      const never = broker.perform(runIdentity, {
        action: "wait", text: "Report ready", state: "present", timeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const missed = await never;
      expect(missed).toMatchObject({ ok: true });
      if (missed.ok) {
        expect(JSON.parse(missed.text)).toMatchObject({
          matched: false,
          nextStep: expect.stringContaining("Take a snapshot"),
        });
      }

      pageTools.agentPageEvidencePrivacy.mockResolvedValueOnce({ withheld: "password" });
      await expect(broker.perform(runIdentity, {
        action: "wait", text: "Welcome", state: "present", timeoutMs: 1_000,
      })).resolves.toMatchObject({ ok: false, code: "sensitive" });
    } finally {
      pageTools.semanticPageSnapshot.mockReset();
      pageTools.semanticPageSnapshot.mockImplementation(
        async () => JSON.stringify({ title: "Local app", elements: [] }),
      );
      vi.useRealTimers();
    }
  });

  it("stops waiting in line after thirty seconds and says nothing was sent", async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness();
      const contentsOffset = electronState.contents.length;
      electronState.loadOverrides.push(async () => await new Promise<void>(() => undefined));
      const slow = broker.perform(runIdentity, {
        action: "navigate",
        url: "http://127.0.0.1:3000/never-finishes",
      });
      await vi.advanceTimersByTimeAsync(1);
      const queued = broker.perform(runIdentity, { action: "click", ref: "e1" });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(queued).resolves.toEqual({
        ok: false,
        code: "timeout",
        message: "Inertia Browser is still busy with an earlier action in this chat. Nothing was sent to the page for this call; try again shortly.",
      });
      expect(electronState.contents[contentsOffset]!.sentInputs).toEqual([]);
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(slow).resolves.toMatchObject({ ok: true });
      await expect(broker.perform(runIdentity, { action: "tabs" })).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when a timed-out action had already reached the page", async () => {
    const { broker, children } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    vi.useFakeTimers();
    try {
      pageTools.agentPageInputRefusal.mockImplementationOnce(
        async () => await new Promise<never>(() => undefined),
      );
      const click = broker.perform(runIdentity, { action: "click", ref: "e1" });
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(click).resolves.toMatchObject({
        ok: false,
        code: "timeout",
        message: expect.stringContaining("Input may already have reached the page, so its effect is unknown"),
      });
      expect(children[0]!.webContents.sentInputs).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "mouseDown" }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("names a crashed page and an error page, and reattaches a detached security debugger", async () => {
    const { broker } = harness();
    const contentsOffset = electronState.contents.length;
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    const contents = electronState.contents[contentsOffset]!;
    await expect(broker.perform(runIdentity, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true });
    expect(contents.debugger.attach).toHaveBeenCalledOnce();

    contents.crashed = true;
    await expect(broker.perform(runIdentity, { action: "snapshot" })).resolves.toEqual({
      ok: false,
      code: "unavailable",
      message: "This tab's page crashed. Navigate to the page again to reload it.",
    });
    contents.crashed = false;

    contents.debugger.attached = false;
    await expect(broker.perform(runIdentity, { action: "snapshot" })).resolves.toEqual({
      ok: false,
      code: "unavailable",
      message: "Inertia could not confirm its private inspection context for this page. Navigate to the page again to reload it, then continue.",
    });
    expect(contents.debugger.attach).toHaveBeenCalledTimes(2);
    await expect(broker.perform(runIdentity, {
      action: "navigate",
      url: "http://127.0.0.1:3000/",
    })).resolves.toMatchObject({ ok: true });
    await expect(broker.perform(runIdentity, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true });

    pageTools.semanticPageSnapshot.mockResolvedValueOnce(
      JSON.stringify({ title: "", elements: [], errorPage: true }),
    );
    await expect(broker.perform(runIdentity, { action: "snapshot" })).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
      message: expect.stringContaining("browser error page"),
    });
  });

  it("keeps an agent interaction valid when the panel only moves or is covered", async () => {
    const { broker, children } = harness();
    const owner = { ownerId: "primary", contextId: conversationId, connectionId };
    broker.connect(owner);
    broker.setBounds({ ...owner, bounds: { x: 10, y: 20, width: 600, height: 400 } });
    await broker.navigate({ ...owner, url: "http://127.0.0.1:3000/" });

    for (const change of [
      { x: 90, y: 70, width: 600, height: 400 },
      null,
    ]) {
      let cursorStarted = (): void => undefined;
      let releaseCursor = (): void => undefined;
      const started = new Promise<void>((resolve) => { cursorStarted = resolve; });
      const blocked = new Promise<void>((resolve) => { releaseCursor = resolve; });
      pageTools.showAgentPageCursor.mockImplementationOnce(async () => {
        cursorStarted();
        await blocked;
      });
      const click = broker.perform(conversationId, { action: "click", ref: "e1" });
      await started;
      broker.setBounds({ ...owner, bounds: change });
      releaseCursor();
      await expect(click).resolves.toMatchObject({ ok: true });
    }
    expect(Reflect.get(children[0]!, "bounds")).toEqual({ x: 90, y: 70, width: 600, height: 400 });
    expect(Reflect.get(children[0]!, "visible")).toBe(false);
    broker.setBounds({ ...owner, bounds: { x: 90, y: 70, width: 600, height: 400 } });
    expect(Reflect.get(children[0]!, "visible")).toBe(true);
  });

  it("names the exact reason page content is withheld", async () => {
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/login",
    });
    pageTools.agentPageEvidencePrivacy.mockResolvedValueOnce({ withheld: "hidden-input" });
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({
        ok: false,
        code: "sensitive",
        message: expect.stringContaining("inside a closed shadow root"),
      });
    pageTools.agentPageEvidencePrivacy.mockResolvedValueOnce({ withheld: "credential-signal" });
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({
        ok: false,
        code: "sensitive",
        message: expect.stringContaining("a script changed a password field"),
      });
    pageTools.agentPageEvidencePrivacy.mockResolvedValueOnce({ withheld: "document-too-large" });
    const tooLarge = await broker.perform(conversationId, { action: "snapshot" });
    expect(tooLarge).toMatchObject({
      ok: false,
      code: "sensitive",
      message: expect.stringContaining("more than 4,000 inputs"),
    });
    expect(tooLarge.ok ? "" : tooLarge.message).not.toMatch(/password field|Navigate to the page again/u);
    expect(tooLarge.ok ? "" : tooLarge.message).toMatch(/smaller page/u);
  });

  it("inspects pages with frames and shadow roots and reports them as not inspected", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/nested",
    });
    const contents = electronState.contents[contentsOffset]!;
    pageTools.semanticPageSnapshot.mockClear();
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true });
    expect(pageTools.semanticPageSnapshot).toHaveBeenLastCalledWith(contents, []);

    contents.debugger.emitMessage("Page.frameAttached", {
      frameId: "embedded-frame",
      parentFrameId: "main",
    });
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true });
    expect(pageTools.semanticPageSnapshot).toHaveBeenLastCalledWith(contents, ["frames"]);

    contents.debugger.emitMessage("DOM.shadowRootPushed", {
      root: { nodeId: 21, shadowRootType: "user-agent" },
    });
    contents.debugger.emitMessage("DOM.shadowRootPushed", {
      root: { nodeId: 22, shadowRootType: "closed" },
    });
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true });
    expect(pageTools.semanticPageSnapshot)
      .toHaveBeenLastCalledWith(contents, ["frames", "shadow-roots"]);
    await expect(broker.perform(conversationId, { action: "screenshot" }))
      .resolves.toMatchObject({ ok: true });
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith("Page.getFrameTree");
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith("DOMSnapshot.captureSnapshot", expect.anything());

    contents.debugger.emitMessage("Page.frameNavigated", {
      frame: { id: "replacement-main", url: "http://127.0.0.1:3000/clean" },
    });
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true });
    expect(pageTools.semanticPageSnapshot).toHaveBeenLastCalledWith(contents, []);
  });
});
