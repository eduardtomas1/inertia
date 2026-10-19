import { describe, expect, it, vi } from "vitest";

import type {
  AppControlCommand,
  AppControlElementInfo,
  AppControlIdentity,
  AppControlResult,
} from "../../src/node/runtime-app-control-protocol";
import { AccessibilityWindowTransport } from "../../src/server/runtime/app-under-test/accessibility-window-transport";
import { clickAction, keyAction } from "../../src/server/runtime/app-under-test/accessibility-window-support";
import type { RuntimeAppControlBroker } from "../../src/server/runtime/app-under-test/app-control-broker-client";
import type { AppUnderTestEvidenceInput } from "../../src/server/runtime/app-under-test/window-transport";

const launchId = "44444444-4444-4444-8444-444444444444";
const conversationId = "11111111-1111-4111-8111-111111111111";
const turn = { runId: "22222222-2222-4222-8222-222222222222", turnId: "33333333-3333-4333-8333-333333333333" };
const WINDOW = "a".repeat(32);
const ROOT = "c".repeat(32);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 30 }, () => 0)]);

function control(token: string, overrides: Partial<AppControlElementInfo> = {}): AppControlElementInfo {
  return {
    token, role: "push_button", name: "Save", value: null, enabled: true, focused: false, checked: null, expanded: null,
    editable: false, sensitive: false, offscreen: false, rect: { x: 1, y: 1, width: 10, height: 10 }, actions: ["press"], ...overrides,
  };
}

function fakeApp(options: { watched?: () => boolean; pollMs?: number } = {}) {
  const state = {
    windows: [{ token: WINDOW, pid: 101, title: "Main\u0007 window", active: true, denied: false, bounds: { x: 0, y: 0, width: 640, height: 480 } }] as Array<Record<string, unknown>>,
    rootKey: ROOT,
    text: "Welcome",
    elements: [
      control("1".repeat(32)),
      control("2".repeat(32), { role: "text_field", name: "Notes", value: "draft", editable: true, actions: [] }),
      control("3".repeat(32), { role: "password_text", name: "Password", value: "[redacted]", editable: true, sensitive: true, actions: [] }),
      control("4".repeat(32), { role: "check_box", name: "Remember", checked: "off", actions: ["toggle"] }),
    ],
    focused: null as AppControlElementInfo | null,
    unlabelled: false,
    sensitiveFilled: false,
    failure: null as AppControlResult | null,
    windowClosed: false,
  };
  const calls: Array<{ identity: AppControlIdentity; command: AppControlCommand }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const broker: RuntimeAppControlBroker = {
    perform: vi.fn(async (identity: AppControlIdentity, command: AppControlCommand): Promise<AppControlResult> => {
      calls.push({ identity, command });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      if (state.failure && command.command !== "windows") return state.failure;
      switch (command.command) {
        case "windows":
          return state.failure ?? { ok: true, value: { kind: "windows", windows: state.windows as never, omitted: 0 } };
        case "snapshot":
          return { ok: true, value: {
            kind: "snapshot", rootKey: state.rootKey, title: "Main window", bounds: { x: 0, y: 0, width: 640, height: 480 }, text: state.text,
            elements: state.elements, omittedTextChars: 0, omittedElements: 0, readLimitReached: false, unlabelled: state.unlabelled, sensitiveFilled: state.sensitiveFilled,
          } };
        case "inspect":
          return { ok: true, value: {
            kind: "inspect", rootKey: state.rootKey,
            element: command.element === null ? state.focused : state.elements.find(({ token }) => token === command.element) ?? null,
          } };
        case "perform":
          return { ok: true, value: { kind: "perform", rootKey: state.windowClosed ? null : state.rootKey, windowClosed: state.windowClosed } };
        case "screenshot":
          return { ok: true, value: { kind: "screenshot", png, width: 320, height: 240, mayIncludeOverlappingWindows: true } };
        default:
          return { ok: false, code: "invalid", reason: null, dispatched: false };
      }
    }),
  };
  const evidence = vi.fn((_entry: AppUnderTestEvidenceInput) => "55555555-5555-4555-8555-555555555555");
  const windowsChanged = vi.fn();
  const transport = new AccessibilityWindowTransport(
    {
      launchId, conversationId, pid: 100, processStartedAt: 1_760_000_000_000, evidence, windowsChanged,
      ...(options.watched ? { watched: options.watched } : {}),
    },
    broker,
    { pollMs: options.pollMs ?? 60_000, waitPollMs: 5, platform: "linux" },
  );
  const performs = () => calls.filter(({ command }) => command.command === "perform").map(({ command }) => command);
  return { state, calls, broker, transport, evidence, windowsChanged, performs, maxInFlight: () => maxInFlight };
}

const signal = () => new AbortController().signal;

async function ready(app: ReturnType<typeof fakeApp>): Promise<string> {
  expect(await app.transport.waitForWindow(signal(), 1_000)).toBe(true);
  return app.transport.windows()[0]!.windowId;
}

describe("accessibility window transport", () => {
  it("lists the launch's native windows with minted ids and sanitized titles, counting protected ones", async () => {
    const app = fakeApp();
    app.state.windows.push({ token: null, pid: 102, title: "", active: false, denied: true, bounds: null });
    const windowId = await ready(app);
    expect(app.transport.windows()).toEqual([{ windowId, launchId, title: "Main window", origin: null, active: true, loading: false }]);
    expect(windowId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(windowId).not.toContain(WINDOW);
    expect(app.transport.status()).toEqual({ unavailable: null, protectedApps: 1, access: null });
    expect(app.windowsChanged).toHaveBeenCalled();
    // The background read carries the launch identity without a turn.
    expect(app.calls[0]!.identity).toEqual({ conversationId, runId: null, turnId: null, launchId, pid: 100, processStartedAt: 1_760_000_000_000 });
    app.transport.close();
  });

  it("stops waiting for a window at a permission gate and names the next step", async () => {
    const app = fakeApp();
    app.state.failure = { ok: false, code: "accessibility-unavailable", reason: "empty-tree", dispatched: false };
    expect(await app.transport.waitForWindow(signal(), 1_000)).toBe(false);
    expect(app.transport.status().unavailable).toContain("ACCESSIBILITY_ENABLED=1 or --force-renderer-accessibility");
    app.transport.close();
  });

  it("reports a gate's fixed category, republishes when it starts and ends, and ignores a Screen Recording denial", async () => {
    const app = fakeApp();
    app.state.failure = { ok: false, code: "permission-denied", reason: null, dispatched: false };
    expect(await app.transport.waitForWindow(signal(), 1_000)).toBe(false);
    expect(app.transport.status()).toMatchObject({ access: "permission", unavailable: expect.stringContaining("denied accessibility access") });
    const changes = app.windowsChanged.mock.calls.length;
    expect(changes).toBeGreaterThan(0);
    app.state.failure = { ok: false, code: "helper-permission-denied", reason: null, dispatched: false };
    await app.transport.refreshWindows(signal());
    expect(app.transport.status().access).toBe("helper-permission");
    app.state.failure = null;
    await app.transport.refreshWindows(signal());
    expect(app.transport.status()).toMatchObject({ access: null, unavailable: null });
    const windowId = app.transport.windows()[0]!.windowId;
    app.state.failure = { ok: false, code: "permission-denied", reason: "screen-recording", dispatched: false };
    expect(await app.transport.perform({ action: "screenshot", windowId }, { signal: signal(), turn })).toMatchObject({ ok: false, code: "unavailable" });
    // Screen Recording blocks screenshots only: the windows stay readable and the launch is not gated.
    expect(app.transport.status()).toMatchObject({ access: null, unavailable: null });
    app.transport.close();
  });

  it("polls windows in the background only while the chat is watched, and resumes when it is again", async () => {
    // The fake broker answers on setImmediate, which stays real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let watched = false;
      const app = fakeApp({ watched: () => watched, pollMs: 2_000 });
      const windowReads = () => app.calls.filter(({ command }) => command.command === "windows").length;
      // Advances fake time, then lets the fake broker's real setImmediate answers settle.
      const tick = async (ms: number): Promise<void> => {
        await vi.advanceTimersByTimeAsync(ms);
        for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
      };
      // Nobody watches: no read at start and none later.
      await tick(10_000);
      expect(windowReads()).toBe(0);
      app.transport.watchChanged();
      await tick(0);
      expect(windowReads()).toBe(0);

      // A subscriber or a turn appears: one read at once, then one every poll interval.
      watched = true;
      app.transport.watchChanged();
      await tick(0);
      expect(windowReads()).toBe(1);
      app.transport.watchChanged();
      await tick(2_000);
      await tick(2_000);
      expect(windowReads()).toBe(3);

      // Both go away: the next tick neither reads nor reschedules.
      watched = false;
      await tick(2_000);
      await tick(20_000);
      expect(windowReads()).toBe(3);
      watched = true;
      app.transport.watchChanged();
      await tick(0);
      expect(windowReads()).toBe(4);
      // An explicit stop cancels the scheduled read at once.
      watched = false;
      app.transport.watchChanged();
      await tick(20_000);
      expect(windowReads()).toBe(4);

      // An explicit list (the agent's inertia_app_windows) still reads while unwatched.
      await app.transport.refreshWindows(signal());
      expect(windowReads()).toBe(5);
      app.transport.close();
      watched = true;
      app.transport.watchChanged();
      await tick(10_000);
      expect(windowReads()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds refs to the window's document and starts a new document when the root changes", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    app.state.unlabelled = true;
    const first = (await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn })) as { ok: true; value: Record<string, unknown> };
    expect(first.ok).toBe(true);
    expect(first.value).toMatchObject({
      title: "Main window",
      text: "Welcome",
      viewport: { width: 640, height: 480 },
      notInspected: ["unlabelled-regions"],
      elements: [
        { ref: "e1", role: "push_button", name: "Save", enabled: true, editable: false },
        { ref: "e2", role: "text_field", name: "Notes", value: "draft", editable: true },
        { ref: "e3", role: "password_text", name: "Password", value: "[redacted]" },
        { ref: "e4", role: "check_box", checked: "off" },
      ],
    });
    expect(first.value).not.toHaveProperty("url");
    const again = (await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn })) as { ok: true; value: { elements: Array<{ ref: string }> } };
    expect(again.value.elements.map(({ ref }) => ref)).toEqual(["e1", "e2", "e3", "e4"]);
    const before = await app.transport.inspect({ action: "click", windowId, ref: "e1" }, signal(), turn);
    expect(before).toMatchObject({ ok: true, inspection: { windowNumber: 1, documentSequence: 1, target: { role: "push_button", label: "Save", sensitive: false }, dialog: null } });
    app.state.rootKey = "d".repeat(32);
    // A ref from the replaced document is stale, and the new document's refs never reuse its numbers.
    await expect(app.transport.inspect({ action: "click", windowId, ref: "e1" }, signal(), turn)).resolves.toMatchObject({ ok: false, code: "not-found" });
    const next = (await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn })) as { ok: true; value: { elements: Array<{ ref: string }> } };
    expect(next.value.elements.map(({ ref }) => ref)).toEqual(["e5", "e6", "e7", "e8"]);
    await expect(app.transport.inspect({ action: "click", windowId, ref: "e1" }, signal(), turn)).resolves.toMatchObject({ ok: false, code: "not-found" });
    await expect(app.transport.inspect({ action: "click", windowId, ref: "e5" }, signal(), turn))
      .resolves.toMatchObject({ ok: true, inspection: { documentSequence: 2 } });
    // Back to the first root: still a new document, still new numbers.
    app.state.rootKey = ROOT;
    const third = (await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn })) as { ok: true; value: { elements: Array<{ ref: string }> } };
    expect(third.value.elements.map(({ ref }) => ref)).toEqual(["e9", "e10", "e11", "e12"]);
    await expect(app.transport.inspect({ action: "click", windowId, ref: "e5" }, signal(), turn)).resolves.toMatchObject({ ok: false, code: "not-found" });
    expect(app.calls.filter(({ command }) => command.command !== "windows").every(({ identity }) => identity.runId === turn.runId && identity.turnId === turn.turnId)).toBe(true);
    app.transport.close();
  });

  it("never mints a ref while waiting: only a snapshot hands refs to the agent", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn });
    app.state.elements.push(control("5".repeat(32), { name: "Appeared" }));
    await expect(app.transport.perform({ action: "wait", windowId, text: "appeared", state: "visible", timeoutMs: 1_000 }, { signal: signal(), turn }))
      .resolves.toMatchObject({ ok: true, value: { matched: true } });
    // The control the wait saw has no ref until a snapshot shows it to the agent.
    await expect(app.transport.inspect({ action: "click", windowId, ref: "e5" }, signal(), turn)).resolves.toMatchObject({ ok: false, code: "not-found" });
    const snapshot = (await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn })) as { ok: true; value: { elements: Array<{ ref: string; name: string }> } };
    expect(snapshot.value.elements.at(-1)).toMatchObject({ ref: "e5", name: "Appeared" });
    app.transport.close();
  });

  it("reads windows for the asking turn when the agent lists them or waits for a launch, and turnless only in the background", async () => {
    const app = fakeApp();
    expect(await app.transport.waitForWindow(signal(), 1_000, turn)).toBe(true);
    await app.transport.refreshWindows(signal(), turn);
    await app.transport.refreshWindows(signal());
    const reads = app.calls.filter(({ command }) => command.command === "windows").map(({ identity }) => [identity.runId, identity.turnId]);
    expect(reads.slice(-3)).toEqual([[turn.runId, turn.turnId], [turn.runId, turn.turnId], [null, null]]);
    app.transport.close();
  });

  it("withholds screenshots of every window of the launch once any window was typed a secret", async () => {
    const app = fakeApp();
    app.state.windows.push({ token: "b".repeat(32), pid: 101, title: "Second", active: false, denied: false, bounds: { x: 0, y: 0, width: 320, height: 200 } });
    await ready(app);
    const [first, second] = app.transport.windows();
    await app.transport.perform({ action: "snapshot", windowId: first!.windowId }, { signal: signal(), turn });
    await app.transport.perform({ action: "type", windowId: first!.windowId, ref: "e3", text: "hunter22", replace: true }, { signal: signal(), turn });
    await expect(app.transport.perform({ action: "screenshot", windowId: second!.windowId }, { signal: signal(), turn }))
      .resolves.toMatchObject({ ok: false, code: "sensitive", message: expect.stringContaining("this app holds a value Inertia hid") });
    expect(app.calls.some(({ command }) => command.command === "screenshot")).toBe(false);
    app.transport.close();
  });

  it("words an empty tree, a disabled bus, a tree too large and a worker that cannot start, and backs polling off at a start failure", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    for (const [failure, text, access] of [
      [{ ok: false, code: "accessibility-unavailable", reason: "empty-tree", dispatched: false }, "ACCESSIBILITY_ENABLED=1 or --force-renderer-accessibility", "accessibility-tree"],
      [{ ok: false, code: "accessibility-unavailable", reason: null, dispatched: false }, "Accessibility support is turned off", "accessibility-bus"],
      [{ ok: false, code: "unavailable", reason: "tree-too-large", dispatched: false }, "process tree is too large to check", null],
      [{ ok: false, code: "native-failure", reason: "start-failed", dispatched: false }, "App control could not start; restart Inertia or check Settings → Devices & integrations → App control", "start-failed"],
    ] as const) {
      app.state.failure = failure as AppControlResult;
      await expect(app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn }))
        .resolves.toMatchObject({ ok: false, code: "unavailable", message: expect.stringContaining(text) });
      expect(app.transport.status().access).toBe(access ?? app.transport.status().access);
    }
    app.transport.close();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const polled = fakeApp({ pollMs: 2_000 });
      polled.state.failure = { ok: false, code: "native-failure", reason: "start-failed", dispatched: false };
      const windowReads = () => polled.calls.filter(({ command }) => command.command === "windows").length;
      const tick = async (ms: number): Promise<void> => {
        await vi.advanceTimersByTimeAsync(ms);
        for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
      };
      await tick(0);
      expect(windowReads()).toBe(1);
      expect(polled.transport.status()).toMatchObject({ access: "start-failed", unavailable: expect.stringContaining("could not start") });
      // The gated interval: no read at the normal two seconds, one at ten.
      await tick(9_999);
      expect(windowReads()).toBe(1);
      await tick(1);
      expect(windowReads()).toBe(2);
      polled.transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps click by role, type to setValue or typeText, Enter to the focused control and scroll to scrollIntoView", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn });
    expect(await app.transport.perform({ action: "click", windowId, ref: "e1" }, { signal: signal(), turn })).toMatchObject({ ok: true, value: { clicked: "e1", origin: null } });
    await app.transport.perform({ action: "click", windowId, ref: "e4" }, { signal: signal(), turn });
    await app.transport.perform({ action: "type", windowId, ref: "e2", text: "hello", replace: true }, { signal: signal(), turn });
    await app.transport.perform({ action: "type", windowId, ref: "e2", text: "!", replace: false }, { signal: signal(), turn });
    app.state.focused = app.state.elements[0]!;
    expect(await app.transport.perform({ action: "press", windowId, key: "Enter" }, { signal: signal(), turn })).toMatchObject({ ok: true, value: { pressed: "Enter" } });
    await app.transport.perform({ action: "scroll", windowId, ref: "e2" }, { signal: signal(), turn });
    expect(app.performs()).toEqual([
      { command: "perform", window: WINDOW, element: "1".repeat(32), action: "press", text: null, expect: null },
      { command: "perform", window: WINDOW, element: "4".repeat(32), action: "toggle", text: null, expect: null },
      { command: "perform", window: WINDOW, element: "2".repeat(32), action: "setValue", text: "hello", expect: null },
      { command: "perform", window: WINDOW, element: "2".repeat(32), action: "typeText", text: "!", expect: null },
      { command: "perform", window: WINDOW, element: "1".repeat(32), action: "press", text: null, expect: null },
      { command: "perform", window: WINDOW, element: "2".repeat(32), action: "scrollIntoView", text: null, expect: null },
    ]);
    app.transport.close();
  });

  it("refuses keys and pixel scrolling the accessibility API cannot express", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    for (const key of ["Escape", "Tab", "ArrowDown", "Control+Enter"] as const) {
      await expect(app.transport.perform({ action: "press", windowId, key }, { signal: signal(), turn })).resolves.toMatchObject({ ok: false, code: "invalid", dispatched: false });
    }
    await expect(app.transport.perform({ action: "scroll", windowId, deltaY: 200 }, { signal: signal(), turn }))
      .resolves.toMatchObject({ ok: false, code: "invalid", message: expect.stringContaining("by pixels is not supported") });
    app.state.focused = null;
    await expect(app.transport.perform({ action: "press", windowId, key: "Space" }, { signal: signal(), turn })).resolves.toMatchObject({ ok: false, code: "invalid" });
    expect(app.performs()).toEqual([]);
    expect(keyAction("Enter")).toBe("press");
    expect(keyAction("Escape")).toBeNull();
    expect(clickAction({ role: "list_item", checked: null, expanded: null, actions: [] })).toBe("select");
    expect(clickAction({ role: "tree_item", checked: null, expanded: false, actions: ["press"] })).toBe("press");
    expect(clickAction({ role: "disclosure", checked: null, expanded: false, actions: ["expand"] })).toBe("expand");
    app.transport.close();
  });

  it("remembers text typed into a sensitive control and redacts it from later text, names, titles and logs", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn });
    const inspected = await app.transport.inspect({ action: "type", windowId, ref: "e3", text: "hunter22", replace: true }, signal(), turn);
    expect(inspected).toMatchObject({ ok: true, inspection: { target: { role: "password_text", label: "Sensitive field", sensitive: true } } });
    await app.transport.perform({ action: "type", windowId, ref: "e3", text: "hunter22", replace: true }, { signal: signal(), turn });
    app.state.text = "Logged in as hunter22";
    app.state.elements[1] = { ...app.state.elements[1]!, name: "Echo hunter22", value: "hunter22" };
    app.state.windows[0] = { ...app.state.windows[0]!, title: "hunter22 - Main" };
    const snapshot = await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn });
    expect(JSON.stringify(snapshot)).not.toContain("hunter22");
    expect(JSON.stringify(snapshot)).toContain("[redacted]");
    await app.transport.refreshWindows(signal());
    expect(app.transport.windows()[0]!.title).not.toContain("hunter22");
    expect(app.transport.redactLog("token=hunter22 ok", false)).toBe("token=[redacted] ok");
    // A remembered value withholds screenshots of the window.
    await expect(app.transport.perform({ action: "screenshot", windowId }, { signal: signal(), turn })).resolves.toMatchObject({ ok: false, code: "sensitive" });
    expect(app.calls.some(({ command }) => command.command === "screenshot")).toBe(false);
    app.transport.close();
  });

  it("keeps a screenshot as local evidence and reports possible overlap", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    await expect(app.transport.perform({ action: "screenshot", windowId }, { signal: signal(), turn })).resolves.toEqual({
      ok: true,
      value: { captured: true, evidenceId: "55555555-5555-4555-8555-555555555555", width: 640, height: 480, mayIncludeOverlappingWindows: true },
    });
    expect(app.evidence).toHaveBeenCalledWith({ kind: "screenshot", png, width: 320, height: 240 });
    app.state.failure = { ok: false, code: "sensitive", reason: null, dispatched: false };
    await expect(app.transport.perform({ action: "screenshot", windowId }, { signal: signal(), turn })).resolves.toMatchObject({ ok: false, code: "sensitive" });
    app.transport.close();
  });

  it("refuses an approved action when the target changed after the approval, sending nothing", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn });
    const inspected = await app.transport.inspect({ action: "click", windowId, ref: "e1" }, signal(), turn);
    if (!inspected.ok) throw new Error("inspection failed");
    app.state.elements[0] = { ...app.state.elements[0]!, name: "Delete everything" };
    const expected = { documentSequence: inspected.inspection.documentSequence, target: inspected.inspection.target, dialog: null };
    await expect(app.transport.perform({ action: "click", windowId, ref: "e1" }, { signal: signal(), turn, expected }))
      .resolves.toMatchObject({ ok: false, code: "not-found", dispatched: false });
    expect(app.performs()).toEqual([]);
    app.state.elements[0] = { ...app.state.elements[0]!, name: "Save" };
    await app.transport.perform({ action: "click", windowId, ref: "e1" }, { signal: signal(), turn, expected });
    // The approved action carries the inspected root and control for main to check again.
    expect(app.performs()).toEqual([{ command: "perform", window: WINDOW, element: "1".repeat(32), action: "press", text: null, expect: { rootKey: ROOT, role: "push_button", name: "Save" } }]);
    app.transport.close();
  });

  it("maps typed failures to fixed wording and reports a window that closed after the action", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    await app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn });
    app.state.windowClosed = true;
    await expect(app.transport.perform({ action: "click", windowId, ref: "e1" }, { signal: signal(), turn })).resolves.toMatchObject({
      ok: true, value: { clicked: "e1", windowClosed: true },
    });
    expect(app.transport.windows()).toEqual([]);
    const other = fakeApp();
    const otherId = await ready(other);
    for (const [failure, code, text] of [
      [{ ok: false, code: "permission-denied", reason: null, dispatched: false }, "unavailable", "system denied accessibility access"],
      [{ ok: false, code: "elevated", reason: null, dispatched: false }, "unavailable", "higher privileges"],
      [{ ok: false, code: "denied", reason: null, dispatched: false }, "invalid", "never reads or controls"],
      [{ ok: false, code: "native-failure", reason: null, dispatched: true }, "unavailable", "system accessibility call failed"],
      [{ ok: false, code: "timeout", reason: null, dispatched: true }, "timeout", "may have reached the app"],
      [{ ok: false, code: "unsupported", reason: "wayland", dispatched: false }, "unavailable", "Wayland"],
    ] as const) {
      other.state.failure = failure as AppControlResult;
      const result = await other.transport.perform({ action: "snapshot", windowId: otherId }, { signal: signal(), turn });
      expect(result).toMatchObject({ ok: false, code, message: expect.stringContaining(text), dispatched: failure.dispatched });
    }
    other.transport.close();
    app.transport.close();
  });

  it("runs one native command at a time per launch and waits for text by polling", async () => {
    const app = fakeApp();
    const windowId = await ready(app);
    const results = await Promise.all([
      app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn }),
      app.transport.perform({ action: "screenshot", windowId }, { signal: signal(), turn }),
      app.transport.refreshWindows(signal()),
    ]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(app.maxInFlight()).toBe(1);
    setTimeout(() => { app.state.text = "Saved!"; }, 20);
    await expect(app.transport.perform({ action: "wait", windowId, text: "saved", state: "visible", timeoutMs: 2_000 }, { signal: signal(), turn }))
      .resolves.toMatchObject({ ok: true, value: { matched: true } });
    await expect(app.transport.perform({ action: "wait", windowId, text: "never", state: "visible", timeoutMs: 100 }, { signal: signal(), turn }))
      .resolves.toMatchObject({ ok: true, value: { matched: false } });
    app.transport.close();
    await expect(app.transport.perform({ action: "snapshot", windowId }, { signal: signal(), turn })).resolves.toMatchObject({ ok: false, code: "unavailable" });
  });
});
