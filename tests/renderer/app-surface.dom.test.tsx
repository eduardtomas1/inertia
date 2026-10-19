import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppSurface, type AppSurfaceProps } from "../../src/renderer/src/components/AppSurface";
import type {
  AppUnderTestEvidenceWithThumbnail,
  AppUnderTestLaunch,
  AppUnderTestLogLine,
  AppUnderTestWindow,
} from "../../src/shared/app-under-test";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const LAUNCH = "22222222-2222-4222-8222-222222222222";
const SECOND_LAUNCH = "33333333-3333-4333-8333-333333333333";
const ACTION = "44444444-4444-4444-8444-444444444444";
const WINDOW = "55555555-5555-4555-8555-555555555555";
const EVIDENCE = "66666666-6666-4666-8666-666666666666";
const THUMBNAIL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function launch(overrides: Partial<AppUnderTestLaunch> = {}): AppUnderTestLaunch {
  return {
    launchId: LAUNCH,
    conversationId: CONVERSATION,
    kind: "electron",
    actionId: null,
    label: "Electron app",
    startedBy: "agent",
    state: "running",
    pid: 4242,
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    readyAt: null,
    exitedAt: null,
    exitCode: null,
    signal: null,
    stopRequested: false,
    cdp: true,
    transport: "cdp",
    windowCount: 0,
    windows: [],
    cleanupConfirmed: null,
    failure: null,
    ...overrides,
  };
}

function line(cursor: number, text: string, stream: AppUnderTestLogLine["stream"] = "stdout"): AppUnderTestLogLine {
  return { cursor, stream, text };
}

interface RuntimeState {
  launches: AppUnderTestLaunch[];
  evidence: AppUnderTestEvidenceWithThumbnail[];
  logs: Record<string, AppUnderTestLogLine[]>;
}

function fakeRuntime(initial: Partial<RuntimeState> = {}) {
  const state: RuntimeState = { launches: [], evidence: [], logs: {}, ...initial };
  const listeners = new Set<(event: ServerEvent) => void>();
  let stopResult: Promise<void> = Promise.resolve();
  const ok = (command: ClientCommand, result: unknown): ServerEvent => ({
    type: "request.result",
    requestId: command.requestId,
    result,
  } as ServerEvent);
  const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> => {
    switch (command.type) {
      case "app-under-test.launches.list":
        return ok(command, { kind: "app-under-test.launches", conversationId: CONVERSATION, launches: state.launches });
      case "app-under-test.evidence.list":
        return ok(command, { kind: "app-under-test.evidence", conversationId: CONVERSATION, evidence: state.evidence });
      case "app-under-test.logs.read": {
        const lines = state.logs[command.payload.launchId] ?? [];
        return ok(command, {
          kind: "app-under-test.logs",
          conversationId: CONVERSATION,
          launchId: command.payload.launchId,
          lines,
          nextCursor: lines.at(-1)?.cursor ?? 0,
          truncated: false,
          dropped: 0,
        });
      }
      case "app-under-test.launch": {
        const started = launch({
          launchId: SECOND_LAUNCH,
          kind: command.payload.kind,
          actionId: command.payload.actionId ?? null,
          label: command.payload.kind === "action" ? "Dev server" : "Electron app",
          startedBy: "user",
          state: "starting",
          startedAt: new Date().toISOString(),
        });
        state.launches = [...state.launches, started];
        return ok(command, { kind: "app-under-test.launch", conversationId: CONVERSATION, launch: started });
      }
      case "app-under-test.stop": {
        await stopResult;
        const current = state.launches.find(({ launchId }) => launchId === command.payload.launchId)!;
        // Electron answers SIGTERM with exit code 143.
        const stopped = {
          ...current, state: "exited" as const, exitedAt: new Date().toISOString(), exitCode: 143, stopRequested: true, cleanupConfirmed: true,
        };
        state.launches = state.launches.map((entry) => entry.launchId === stopped.launchId ? stopped : entry);
        return ok(command, { kind: "app-under-test.launch", conversationId: CONVERSATION, launch: stopped });
      }
      default:
        throw new Error(`Unexpected command ${command.type}`);
    }
  });
  return {
    state,
    sendCommand,
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit: (event: ServerEvent) => act(() => {
      for (const listener of listeners) listener(event);
    }),
    holdStop: () => {
      let release!: () => void;
      stopResult = new Promise((resolve) => { release = resolve; });
      return () => release();
    },
    commands: <Type extends ClientCommand["type"]>(type: Type) => sendCommand.mock.calls
      .map(([command]) => command)
      .filter((command): command is Extract<ClientCommand, { type: Type }> => command.type === type),
  };
}

function setup(runtime = fakeRuntime(), props: Partial<AppSurfaceProps> = {}) {
  const all: AppSurfaceProps = {
    conversationId: CONVERSATION,
    status: "online",
    actions: [],
    sendCommand: runtime.sendCommand,
    subscribe: runtime.subscribe,
    ...props,
  };
  const view = render(<AppSurface {...all} />);
  return { ...view, runtime, props: all };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("App surface", () => {
  it("explains the surface, says the agent uses the same tools, and loads the chat's session", async () => {
    const { runtime } = setup();
    expect(await screen.findByText("Run the app you are building")).toBeVisible();
    expect(screen.getByText(/The agent uses the same App\s+tools/u)).toBeVisible();
    expect(screen.getByRole("region", { name: "App" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch Electron app" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Launch action…" })).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "App log" })).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("No windows open.")).toBeVisible();
    expect(screen.getByText(/No evidence yet/u)).toBeVisible();
    expect(runtime.commands("app-under-test.launches.list")[0]).toMatchObject({ payload: { conversationId: CONVERSATION } });
    expect(runtime.commands("app-under-test.evidence.list")[0]).toMatchObject({ payload: { conversationId: CONVERSATION } });
    expect(runtime.commands("app-under-test.logs.read")).toHaveLength(0);
  });

  it("launches the Electron app or a reviewed action with only a kind and an action id", async () => {
    const { runtime } = setup(fakeRuntime(), { actions: [{ id: ACTION, name: "Dev server" }] });
    await screen.findByText("Run the app you are building");
    fireEvent.click(screen.getByRole("button", { name: "Launch Electron app" }));
    await waitFor(() => expect(runtime.commands("app-under-test.launch")).toHaveLength(1));
    expect(runtime.commands("app-under-test.launch")[0]!.payload).toEqual({ conversationId: CONVERSATION, kind: "electron" });
    expect(await screen.findByRole("list", { name: "App launches" })).toHaveTextContent("Starting");

    const trigger = screen.getByRole("button", { name: "Launch action…" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Project actions" });
    const item = within(menu).getByRole("menuitem", { name: "Dev server" });
    await waitFor(() => expect(item).toHaveFocus());
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Dev server" }));
    await waitFor(() => expect(runtime.commands("app-under-test.launch")).toHaveLength(2));
    expect(runtime.commands("app-under-test.launch")[1]!.payload).toEqual({ conversationId: CONVERSATION, kind: "action", actionId: ACTION });
  });

  it("disables launching at the per-chat bound and while offline", async () => {
    const runtime = fakeRuntime({ launches: [launch(), launch({ launchId: SECOND_LAUNCH, startedAt: new Date().toISOString() })] });
    const view = setup(runtime);
    expect(await screen.findByText(/already runs 2 launches/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Launch Electron app" })).toBeDisabled();
    view.rerender(<AppSurface {...view.props} status="offline" />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
  });

  it("shows each launch's kind, state, pid, uptime and exit status", async () => {
    setup(fakeRuntime({ launches: [
      launch({ launchId: SECOND_LAUNCH, state: "exited", label: "Dev server", kind: "action", startedAt: "2026-10-19T10:00:00.000Z",
        exitedAt: "2026-10-19T10:02:05.000Z", exitCode: 1, pid: 77, cleanupConfirmed: false, failure: "The app exited before it was ready." }),
      launch(),
    ] }));
    const list = await screen.findByRole("list", { name: "App launches" });
    const [running, exited] = within(list).getAllByRole("listitem");
    expect(running).toHaveTextContent("Running");
    expect(running).toHaveTextContent("Electron app");
    expect(running).toHaveTextContent("PID4242");
    expect(running).toHaveTextContent(/Uptime1m 0[5-9]s/u);
    expect(within(running!).getByRole("button", { name: "Stop Electron app" })).toBeEnabled();
    expect(exited).toHaveTextContent("Exited");
    expect(exited).toHaveTextContent("Action");
    expect(exited).toHaveTextContent("Ran for2m 05s");
    expect(exited).toHaveTextContent("ResultExit code 1");
    expect(exited).not.toHaveTextContent("Stopped");
    expect(exited).toHaveTextContent("The app exited before it was ready.");
    expect(exited).toHaveTextContent("could not confirm that every process");
    expect(within(exited!).queryByRole("button")).not.toBeInTheDocument();
  });

  it("stops an agent launch at once and returns focus to the launcher", async () => {
    const runtime = fakeRuntime({ launches: [launch()] });
    setup(runtime);
    const stop = await screen.findByRole("button", { name: "Stop Electron app" });
    stop.focus();
    fireEvent.click(stop);
    await waitFor(() => expect(runtime.commands("app-under-test.stop")).toHaveLength(1));
    expect(runtime.commands("app-under-test.stop")[0]!.payload).toEqual({ conversationId: CONVERSATION, launchId: LAUNCH });
    await waitFor(() => expect(screen.getByRole("button", { name: "Launch Electron app" })).toHaveFocus());
    const row = within(screen.getByRole("list", { name: "App launches" })).getByRole("listitem");
    // A requested stop reads as a stop, never as a crash with a doubled "Exit" label.
    expect(row).toHaveTextContent("ResultStopped · exit code 143");
    expect(row).not.toHaveTextContent(/Exit code 143|Exit\s*Exit/u);
  });

  it("asks before stopping a launch the user started, with Escape keeping it running", async () => {
    const runtime = fakeRuntime({ launches: [launch({ startedBy: "user" })] });
    setup(runtime);
    const release = runtime.holdStop();
    fireEvent.click(await screen.findByRole("button", { name: "Stop Electron app" }));
    const confirm = screen.getByRole("group", { name: "Confirm stopping Electron app" });
    expect(within(confirm).getByRole("button", { name: "Stop the app" })).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: /Confirm stopping/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop Electron app" })).toHaveFocus();
    expect(runtime.commands("app-under-test.stop")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Stop Electron app" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop the app" }));
    expect(await screen.findByRole("button", { name: "Stop Electron app" })).toHaveTextContent("Stopping…");
    expect(runtime.commands("app-under-test.stop")).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Launch Electron app" })).toHaveFocus());
  });

  it("reads the newest tail of a live launch, follows new lines, and marks skipped lines", async () => {
    const runtime = fakeRuntime({
      launches: [launch()],
      logs: { [LAUNCH]: [line(4, "ready"), line(5, "warning: slow", "stderr")] },
    });
    setup(runtime);
    const log = await screen.findByRole("log", { name: "Log for Electron app" });
    await waitFor(() => expect(log).toHaveTextContent("stdoutready"));
    expect(runtime.commands("app-under-test.logs.read")[0]!.payload).toEqual({ conversationId: CONVERSATION, launchId: LAUNCH, limit: 200 });
    expect(log).toHaveTextContent("Earlier lines are not shown");
    expect(log).toHaveTextContent("stderrwarning: slow");

    // Overlapping and live lines merge by cursor without duplicates.
    runtime.emit({ type: "app-under-test.logs.appended", conversationId: CONVERSATION, launchId: LAUNCH,
      lines: [line(5, "warning: slow", "stderr"), line(6, "window opened", "console")], dropped: 0 });
    runtime.emit({ type: "app-under-test.logs.appended", conversationId: CONVERSATION, launchId: LAUNCH,
      lines: [line(10, "Uncaught TypeError", "exception")], dropped: 3 });
    expect(within(log).getAllByText("warning: slow")).toHaveLength(1);
    expect(log).toHaveTextContent("consolewindow opened");
    expect(within(log).getByText("3 lines skipped")).toBeVisible();
    expect(log).toHaveTextContent("exceptionUncaught TypeError");
    // Another chat's lines never land here.
    runtime.emit({ type: "app-under-test.logs.appended", conversationId: "99999999-9999-4999-8999-999999999999", launchId: LAUNCH,
      lines: [line(11, "foreign")], dropped: 0 });
    expect(log).not.toHaveTextContent("foreign");
  });

  it("stops following when scrolled up and jumps back to the latest line", async () => {
    const runtime = fakeRuntime({ launches: [launch()], logs: { [LAUNCH]: [line(1, "one"), line(2, "two")] } });
    setup(runtime);
    const log = await screen.findByRole("log", { name: "Log for Electron app" });
    await waitFor(() => expect(log).toHaveTextContent("two"));
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 300 });
    runtime.emit({ type: "app-under-test.logs.appended", conversationId: CONVERSATION, launchId: LAUNCH, lines: [line(3, "three")], dropped: 0 });
    expect(log.scrollTop).toBe(900);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();

    log.scrollTop = 100;
    fireEvent.scroll(log);
    const jump = await screen.findByRole("button", { name: "Jump to latest" });
    runtime.emit({ type: "app-under-test.logs.appended", conversationId: CONVERSATION, launchId: LAUNCH, lines: [line(4, "four")], dropped: 0 });
    expect(log.scrollTop).toBe(100);

    fireEvent.click(jump);
    expect(log.scrollTop).toBe(900);
    expect(log).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });

  it("announces a bounded summary of new lines instead of every line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtime = fakeRuntime({ launches: [launch()], logs: { [LAUNCH]: [line(1, "boot")] } });
    setup(runtime);
    const log = await screen.findByRole("log", { name: "Log for Electron app" });
    await waitFor(() => expect(log).toHaveTextContent("boot"));
    const announcer = log.querySelector(".visually-hidden")!;
    expect(log.querySelector("ol")).toHaveAttribute("aria-live", "off");
    runtime.emit({ type: "app-under-test.logs.appended", conversationId: CONVERSATION, launchId: LAUNCH,
      lines: Array.from({ length: 40 }, (_, index) => line(index + 2, `line ${index + 2} ${"x".repeat(300)}`)), dropped: 0 });
    expect(announcer).toHaveTextContent("");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(announcer.textContent).toMatch(/^40 new log lines\. Latest stdout: line 41 x+…$/u);
    expect(announcer.textContent!.length).toBeLessThan(180);
  });

  it("filters shown lines and copies the shown lines", async () => {
    const copyText = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", { configurable: true, value: { copyText } });
    const runtime = fakeRuntime({ launches: [launch()], logs: { [LAUNCH]: [line(1, "started"), line(2, "ERROR boom", "stderr"), line(3, "error again")] } });
    setup(runtime);
    const log = await screen.findByRole("log", { name: "Log for Electron app" });
    await waitFor(() => expect(log).toHaveTextContent("started"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter log lines" }), { target: { value: "error" } });
    expect(log).not.toHaveTextContent("started");
    expect(log).toHaveTextContent("ERROR boom");
    expect(screen.getByRole("status")).toHaveTextContent("2 of 3 lines match");
    fireEvent.click(screen.getByRole("button", { name: "Copy lines" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("[stderr] ERROR boom\n[stdout] error again"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter log lines" }), { target: { value: "nothing" } });
    expect(log).toHaveTextContent("No lines match the filter.");
    Reflect.deleteProperty(window, "inertia");
  });

  it("switches the log to another launch and reads an exited launch's retained tail", async () => {
    const runtime = fakeRuntime({
      launches: [
        launch({ launchId: SECOND_LAUNCH, state: "exited", label: "Dev server", startedAt: "2026-10-19T10:00:00.000Z", exitedAt: "2026-10-19T10:01:00.000Z", exitCode: 0 }),
        launch(),
      ],
      logs: { [LAUNCH]: [line(1, "electron says hi")], [SECOND_LAUNCH]: [line(1, "listening on 5173")] },
    });
    setup(runtime);
    const log = await screen.findByRole("log", { name: "Log for Electron app" });
    await waitFor(() => expect(log).toHaveTextContent("electron says hi"));
    expect(runtime.commands("app-under-test.logs.read").map((command) => command.payload)).toEqual([
      { conversationId: CONVERSATION, launchId: LAUNCH, limit: 200 },
    ]);
    fireEvent.change(screen.getByRole("combobox", { name: "Show logs for" }), { target: { value: SECOND_LAUNCH } });
    const other = await screen.findByRole("log", { name: "Log for Dev server" });
    await waitFor(() => expect(other).toHaveTextContent("listening on 5173"));
  });

  it("lists windows as plain text with their origin and state", async () => {
    const settings: AppUnderTestWindow = { windowId: WINDOW, launchId: LAUNCH, title: "<img src=x onerror=alert(1)> Settings", origin: "file://", active: true, loading: false };
    // The app was already running when the surface opened: its record carries the window.
    const runtime = fakeRuntime({ launches: [launch({ windowCount: 1, windows: [settings] })] });
    setup(runtime);
    expect(await screen.findByRole("list", { name: "App windows" })).toHaveTextContent("Settings");
    const windows: AppUnderTestWindow[] = [
      settings,
      { windowId: EVIDENCE, launchId: LAUNCH, title: "", origin: null, active: false, loading: true },
    ];
    runtime.emit({ type: "app-under-test.windows.updated", conversationId: CONVERSATION, launchId: LAUNCH, windows });
    const list = screen.getByRole("list", { name: "App windows" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("<img src=x onerror=alert(1)> Settings");
    expect(first!.querySelector("img")).toBeNull();
    expect(first).toHaveTextContent("file://");
    expect(first).toHaveTextContent("Active");
    expect(second).toHaveTextContent("Untitled window");
    expect(second).toHaveTextContent("No origin");
    expect(second).toHaveTextContent("Loading");
    // A launch update carries the windows current when it was sent.
    runtime.emit({ type: "app-under-test.launch.updated", conversationId: CONVERSATION, launch: launch({ windowCount: 1, windows: [settings] }) });
    expect(within(screen.getByRole("list", { name: "App windows" })).getAllByRole("listitem")).toHaveLength(1);
    runtime.emit({ type: "app-under-test.launch.updated", conversationId: CONVERSATION, launch: launch({ state: "exited", exitCode: 0, exitedAt: new Date().toISOString() }) });
    expect(screen.queryByRole("list", { name: "App windows" })).not.toBeInTheDocument();
  });

  it("names each launch's window transport", async () => {
    setup(fakeRuntime({ launches: [
      launch({ launchId: SECOND_LAUNCH, kind: "action", actionId: ACTION, label: "Native app", cdp: false, transport: "accessibility",
        protectedApps: 0, windowAccess: null }),
      launch({ launchId: WINDOW, kind: "action", actionId: ACTION, label: "Dev server", cdp: false, transport: null, state: "exited", exitCode: 0,
        exitedAt: new Date().toISOString() }),
      launch(),
    ] }));
    const list = await screen.findByRole("list", { name: "App launches" });
    const [electron, plain, native] = within(list).getAllByRole("listitem");
    expect(electron).toHaveTextContent("TransportDebugging pipe");
    expect(native).toHaveTextContent("TransportAccessibility");
    expect(plain).toHaveTextContent("TransportNone yet");
  });

  it("shows protected apps as a muted count and a permission gate with a keyboard-reachable link to App control", async () => {
    const onOpenAppControlSettings = vi.fn();
    const nativeWindow: AppUnderTestWindow = { windowId: WINDOW, launchId: LAUNCH, title: "Editor", origin: null, active: true, loading: false };
    const native = launch({
      kind: "action", actionId: ACTION, label: "Native app", cdp: false, transport: "accessibility",
      windowCount: 1, windows: [nativeWindow], protectedApps: 2, windowAccess: null,
    });
    const runtime = fakeRuntime({ launches: [native] });
    setup(runtime, { onOpenAppControlSettings });
    expect(await screen.findByText("2 protected apps are not inspectable")).toBeVisible();
    expect(screen.getByRole("list", { name: "App windows" })).toHaveTextContent("Editor");
    expect(screen.queryByRole("button", { name: "Open App control settings" })).not.toBeInTheDocument();

    runtime.emit({ type: "app-under-test.launch.updated", conversationId: CONVERSATION, launch: {
      ...native, windowCount: 0, windows: [], protectedApps: 1, windowAccess: "permission",
    } });
    expect(screen.getByText("1 protected app is not inspectable")).toBeVisible();
    const notice = screen.getByText(/not allowed to use accessibility/u).closest("[role='status']") as HTMLElement;
    expect(notice).toBeVisible();
    const link = within(notice).getByRole("button", { name: "Open App control settings" });
    link.focus();
    expect(link).toHaveFocus();
    fireEvent.click(link);
    expect(onOpenAppControlSettings).toHaveBeenCalledOnce();

    // An elevated app needs no settings change, and an ended gate removes the notice.
    runtime.emit({ type: "app-under-test.launch.updated", conversationId: CONVERSATION, launch: {
      ...native, windowCount: 0, windows: [], protectedApps: 0, windowAccess: "elevated",
    } });
    expect(screen.getByText(/higher privileges than Inertia/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open App control settings" })).not.toBeInTheDocument();
    expect(screen.queryByText(/protected app/u)).not.toBeInTheDocument();
    // A disabled accessibility bus and a helper that could not start both link to the card.
    for (const [gate, text] of [["accessibility-bus", /Accessibility support is turned off/u], ["start-failed", /App control could not start/u]] as const) {
      runtime.emit({ type: "app-under-test.launch.updated", conversationId: CONVERSATION, launch: {
        ...native, windowCount: 0, windows: [], protectedApps: 0, windowAccess: gate,
      } });
      expect(await screen.findByText(text)).toBeVisible();
      expect(screen.getByRole("button", { name: "Open App control settings" })).toBeVisible();
    }
    runtime.emit({ type: "app-under-test.launch.updated", conversationId: CONVERSATION, launch: {
      ...native, windowCount: 0, windows: [], protectedApps: 0, windowAccess: null,
    } });
    expect(screen.queryByText(/higher privileges/u)).not.toBeInTheDocument();
  });

  it("offers no settings link where the surface cannot open settings", async () => {
    setup(fakeRuntime({ launches: [launch({
      kind: "action", actionId: ACTION, label: "Native app", cdp: false, transport: "accessibility", protectedApps: 0, windowAccess: "helper-permission",
    })] }));
    expect(await screen.findByText(/denied Inertia's App control helper/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open App control settings" })).not.toBeInTheDocument();
  });

  it("renders evidence newest first with inline thumbnails and refreshes when a screenshot arrives", async () => {
    const runtime = fakeRuntime({
      launches: [launch()],
      evidence: [{ evidenceId: WINDOW, launchId: LAUNCH, kind: "launch", label: "Launched the app", at: "2026-10-19T10:00:00.000Z",
        width: null, height: null, hasThumbnail: false, thumbnail: null }],
    });
    setup(runtime);
    const timeline = await screen.findByRole("list", { name: "App evidence timeline" });
    expect(timeline).toHaveTextContent("Launched the app");
    const screenshot = { evidenceId: EVIDENCE, launchId: LAUNCH, kind: "screenshot" as const, label: "Captured a screenshot",
      at: "2026-10-19T10:00:05.000Z", width: 512, height: 320, hasThumbnail: true };
    runtime.state.evidence = [...runtime.state.evidence, { ...screenshot, thumbnail: THUMBNAIL }];
    runtime.emit({ type: "app-under-test.evidence.appended", conversationId: CONVERSATION, evidence: screenshot });
    await waitFor(() => expect(runtime.commands("app-under-test.evidence.list")).toHaveLength(2));
    const image = await screen.findByRole("img", { name: "Screenshot of the app, 512 × 320 pixels" });
    expect(image).toHaveAttribute("src", THUMBNAIL);
    expect(image.closest("button, a")).toBeNull();
    expect(screen.getByText("Local screenshot · 512 × 320")).toBeVisible();
    const entries = within(timeline).getAllByRole("listitem");
    expect(entries[0]).toHaveTextContent("Screenshot");
    expect(entries[1]).toHaveTextContent("Launch");
  });

  it("never renders a thumbnail that is not a PNG data URL", async () => {
    setup(fakeRuntime({
      launches: [launch()],
      evidence: [{ evidenceId: EVIDENCE, launchId: LAUNCH, kind: "screenshot", label: "Captured a screenshot", at: "2026-10-19T10:00:05.000Z",
        width: 10, height: 10, hasThumbnail: true, thumbnail: "javascript:alert(1)" }],
    }));
    expect(await screen.findByText("Thumbnail is no longer kept")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("resets everything when the chat's App session is cleared", async () => {
    const runtime = fakeRuntime({
      launches: [launch()],
      logs: { [LAUNCH]: [line(1, "hello")] },
      evidence: [{ evidenceId: EVIDENCE, launchId: LAUNCH, kind: "launch", label: "Launched the app", at: "2026-10-19T10:00:00.000Z",
        width: null, height: null, hasThumbnail: false, thumbnail: null }],
    });
    setup(runtime);
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("hello"));
    runtime.emit({ type: "app-under-test.session.cleared", conversationId: CONVERSATION });
    expect(screen.getByText("Run the app you are building")).toBeVisible();
    expect(screen.queryByRole("list", { name: "App launches" })).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "App log" })).toHaveTextContent("Launch the app to see its output here.");
    expect(screen.queryByRole("list", { name: "App evidence timeline" })).not.toBeInTheDocument();
  });

  it("rereads launches, evidence and live tails after a reconnect", async () => {
    const runtime = fakeRuntime({ launches: [launch()], logs: { [LAUNCH]: [line(1, "first")] } });
    const view = setup(runtime);
    await waitFor(() => expect(runtime.commands("app-under-test.logs.read")).toHaveLength(1));
    view.rerender(<AppSurface {...view.props} status="offline" />);
    expect(screen.getByRole("button", { name: "Launch Electron app" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop Electron app" })).toBeDisabled();
    runtime.state.logs[LAUNCH] = [line(1, "first"), line(9, "after reconnect")];
    view.rerender(<AppSurface {...view.props} status="online" />);
    await waitFor(() => expect(runtime.commands("app-under-test.launches.list")).toHaveLength(2));
    expect(runtime.commands("app-under-test.evidence.list")).toHaveLength(2);
    await waitFor(() => expect(runtime.commands("app-under-test.logs.read")).toHaveLength(2));
    const log = screen.getByRole("log");
    await waitFor(() => expect(log).toHaveTextContent("after reconnect"));
    expect(within(log).getByText("7 lines skipped")).toBeVisible();
  });

  it("shows a launch failure as an alert and keeps every control keyboard reachable", async () => {
    const runtime = fakeRuntime({ launches: [launch()], logs: { [LAUNCH]: [line(1, "hello")] } });
    setup(runtime, { actions: [{ id: ACTION, name: "Dev server" }] });
    await screen.findByRole("list", { name: "App launches" });
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("hello"));
    const focusable = [...document.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, [tabindex='0']")];
    expect(focusable.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim())).toEqual(expect.arrayContaining([
      "Launch Electron app", "Launch action…", "Stop Electron app", "Copy lines", "Log for Electron app",
    ]));
    expect(screen.getByRole("searchbox", { name: "Filter log lines" })).toBeInTheDocument();
    runtime.sendCommand.mockRejectedValueOnce(new Error("The project has no Electron binary in node_modules."));
    fireEvent.click(screen.getByRole("button", { name: "Launch action…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Dev server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no Electron binary");
  });

  it("waits for the first message before offering anything", () => {
    setup(fakeRuntime(), { conversationId: null });
    expect(screen.getByText(/Available after the first message/u)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
