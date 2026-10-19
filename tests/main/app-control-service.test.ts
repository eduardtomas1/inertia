import { EventEmitter, getEventListeners } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppMetrics: () => [] },
  nativeImage: { createFromBuffer: vi.fn() },
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(), getMediaAccessStatus: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));

import { AppControlTreeTooLargeError } from "../../src/main/app-control-process-tree";
import { AppControlService, type AppControlServiceDependencies } from "../../src/main/app-control-service";
import type { AppControlWorkerRequest } from "../../src/main/app-control-worker-protocol";
import type { AppControlCommand } from "../../src/node/runtime-app-control-protocol";

const started = 1_760_000_000_000;
const identity = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  launchId: "44444444-4444-4444-8444-444444444444",
  pid: 100,
  processStartedAt: started,
};
const window = "a".repeat(32);
const snapshot: AppControlCommand = { command: "snapshot", window };
const press: AppControlCommand = { command: "perform", window, element: window, action: "press", text: null, expect: null };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 40 }, () => 1)]);
const snapshotValue = {
  kind: "snapshot", rootKey: window, title: "Main", bounds: null, text: "", elements: [], omittedTextChars: 0,
  omittedElements: 0, readLimitReached: false, unlabelled: false, sensitiveFilled: false,
};

type Handler = (request: AppControlWorkerRequest) => unknown;

class Child extends EventEmitter {
  readonly pid = 4_242;
  readonly requests: AppControlWorkerRequest[] = [];
  exitOnKill = true;
  readonly kill = vi.fn(() => {
    if (this.exitOnKill) setImmediate(() => this.emit("exit", 1));
    return true;
  });

  constructor(private readonly handler: () => Handler, ready = true) {
    super();
    if (ready) setImmediate(() => this.emit("message", "ready"));
  }

  postMessage(request: AppControlWorkerRequest): void {
    this.requests.push(request);
    const response = this.handler()(request);
    if (response !== undefined) setImmediate(() => this.emit("message", { id: request.id, result: response }));
  }
}

function harness(overrides: Partial<AppControlServiceDependencies> = {}) {
  let handler: Handler = () => ({ ok: true, value: snapshotValue });
  const children: Child[] = [];
  const dependencies: AppControlServiceDependencies = {
    platform: "linux",
    env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
    fork: vi.fn(() => {
      const child = new Child(() => handler);
      children.push(child);
      return child;
    }),
    accessibilityTrusted: vi.fn(() => true),
    screenRecordingGranted: vi.fn(() => true),
    processTable: vi.fn(async () => [
      { pid: 1, parentPid: 0, startedAtMs: 0, executable: "/sbin/init" },
      { pid: 100, parentPid: 1, startedAtMs: started + 50, executable: "/opt/guardian" },
      { pid: 101, parentPid: 100, startedAtMs: started + 60, executable: "/home/dev/app" },
      { pid: 102, parentPid: 101, startedAtMs: started + 70, executable: "/usr/bin/seahorse" },
      { pid: 300, parentPid: 1, startedAtMs: started, executable: "/usr/bin/other" },
    ]),
    ownPids: () => [5, 6],
    reduceThumbnail: vi.fn(() => ({ png, width: 512, height: 320 })),
    idleMs: 60_000,
    ...overrides,
  };
  const service = new AppControlService(dependencies);
  return { service, dependencies, children, respond: (next: Handler) => { handler = next; } };
}

const signal = () => new AbortController().signal;
/** The runtime that asks: the fixtures' launch roots are children of pid 1 (POSIX tables) or pid 4 (the Windows one). */
const owner = { parentPids: [1, 4] };
/** Lets the fake worker load and receive its command before fake time moves. */
async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("App control service", () => {
  it("sends the worker only the launch's owned tree, with denied executables and Inertia's own pids", async () => {
    const { service, children } = harness();
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toEqual({ ok: true, value: snapshotValue });
    expect(children).toHaveLength(1);
    expect(children[0]!.requests[0]).toEqual({ id: 1, scope: { pids: [100, 101, 102], deniedPids: [102, 5, 6] }, command: snapshot });
  });

  it("refuses a launch whose root is gone or is not the process the runtime spawned", async () => {
    const { service, dependencies, children } = harness();
    await expect(service.perform({ ...identity, processStartedAt: started - 120_000 }, snapshot, signal(), owner))
      .resolves.toEqual({ ok: false, code: "not-found", reason: "launch-gone", dispatched: false });
    await expect(service.perform({ ...identity, pid: 999 }, snapshot, signal(), owner)).resolves.toMatchObject({ code: "not-found", reason: "launch-gone" });
    (dependencies.processTable as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ps failed"));
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ code: "native-failure" });
    expect(children).toHaveLength(0);
  });

  it("applies the macOS permission gates in main and tells a helper denial from a real one", async () => {
    const denied = harness({ platform: "darwin", accessibilityTrusted: vi.fn(() => false) });
    await expect(denied.service.perform(identity, snapshot, signal(), owner)).resolves.toEqual({ ok: false, code: "permission-denied", reason: null, dispatched: false });
    expect(denied.children).toHaveLength(0);
    expect(denied.service.permissions()).toEqual({ kind: "permissions", accessibility: "required", screenRecording: "granted", screenshots: "available" });
    await expect(denied.service.perform(identity, { command: "permissions" }, signal(), owner)).resolves.toMatchObject({ ok: true, value: { kind: "permissions" } });

    const helper = harness({ platform: "darwin" });
    helper.respond(() => ({ ok: false, code: "permission-denied", reason: null, dispatched: false }));
    await expect(helper.service.perform(identity, snapshot, signal(), owner)).resolves.toEqual({ ok: false, code: "helper-permission-denied", reason: null, dispatched: false });

    const linux = harness();
    linux.respond(() => ({ ok: false, code: "permission-denied", reason: null, dispatched: false }));
    await expect(linux.service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ code: "permission-denied" });

    const recording = harness({ platform: "darwin", screenRecordingGranted: vi.fn(() => false) });
    await expect(recording.service.perform(identity, { command: "screenshot", window }, signal(), owner))
      .resolves.toEqual({ ok: false, code: "permission-denied", reason: "screen-recording", dispatched: false });
  });

  it("reports the App control card's state per platform, probing the helper with an empty scope and never prompting", async () => {
    const windowsValue = { ok: true, value: { kind: "windows", windows: [], omitted: 0 } };
    const linux = harness();
    linux.respond(() => windowsValue);
    await expect(linux.service.settingsState()).resolves.toEqual({
      platform: "linux", available: true, accessibility: "available", screenRecording: "not-needed", screenshots: "available", session: "x11",
    });
    // The probe lists no launch's windows: its scope is empty.
    expect(linux.children[0]!.requests[0]).toMatchObject({ scope: { pids: [], deniedPids: [] }, command: { command: "windows" } });
    linux.respond(() => ({ ok: false, code: "native-failure", reason: null, dispatched: false }));
    await expect(linux.service.settingsState()).resolves.toMatchObject({ accessibility: "unavailable" });

    const wayland = harness({ env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" } });
    wayland.respond(() => windowsValue);
    await expect(wayland.service.settingsState()).resolves.toMatchObject({ accessibility: "available", screenshots: "unavailable", session: "wayland" });

    const windows = harness({ platform: "win32", env: {} });
    await expect(windows.service.settingsState()).resolves.toEqual({
      platform: "win32", available: true, accessibility: "available", screenRecording: "not-needed", screenshots: "available", session: null,
    });
    expect(windows.children).toHaveLength(0);

    const required = harness({ platform: "darwin", accessibilityTrusted: vi.fn(() => false), screenRecordingGranted: vi.fn(() => false) });
    await expect(required.service.settingsState()).resolves.toEqual({
      platform: "darwin", available: true, accessibility: "required", screenRecording: "required", screenshots: "available", session: null,
    });
    // Without the grant the helper is never started, so nothing can prompt.
    expect(required.children).toHaveLength(0);

    const granted = harness({ platform: "darwin" });
    granted.respond(() => windowsValue);
    await expect(granted.service.settingsState()).resolves.toMatchObject({ accessibility: "granted", screenRecording: "granted" });
    granted.respond(() => ({ ok: false, code: "permission-denied", reason: null, dispatched: false }));
    await expect(granted.service.settingsState()).resolves.toMatchObject({ accessibility: "helper-denied" });
    granted.respond(() => ({ ok: false, code: "timeout", reason: null, dispatched: false }));
    await expect(granted.service.settingsState()).resolves.toMatchObject({ accessibility: "granted" });

    const other = harness({ platform: "freebsd" });
    await expect(other.service.settingsState()).resolves.toMatchObject({ platform: "unsupported", available: false });
    expect(other.children).toHaveLength(0);
    const disposed = harness();
    await disposed.service.dispose();
    await expect(disposed.service.settingsState()).resolves.toMatchObject({ available: false, accessibility: "unavailable" });
  });

  it("gates screenshots on Wayland and reduces every capture to a bounded thumbnail in main", async () => {
    const wayland = harness({ env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" } });
    await expect(wayland.service.perform(identity, { command: "screenshot", window }, signal(), owner))
      .resolves.toEqual({ ok: false, code: "unsupported", reason: "wayland", dispatched: false });
    expect(wayland.service.permissions().screenshots).toBe("unavailable");

    const x11 = harness();
    const large = new Uint8Array([...png, ...new Uint8Array(400_000)]);
    x11.respond(() => ({ ok: true, value: { kind: "screenshot", png: large, width: 1024, height: 640, mayIncludeOverlappingWindows: true } }));
    await expect(x11.service.perform(identity, { command: "screenshot", window }, signal(), owner)).resolves.toEqual({
      ok: true, value: { kind: "screenshot", png, width: 512, height: 320, mayIncludeOverlappingWindows: true },
    });
    expect(x11.dependencies.reduceThumbnail).toHaveBeenCalledWith(large);
    (x11.dependencies.reduceThumbnail as ReturnType<typeof vi.fn>).mockReturnValueOnce({ png: large, width: 512, height: 320 });
    await expect(x11.service.perform(identity, { command: "screenshot", window }, signal(), owner)).resolves.toMatchObject({ code: "native-failure" });
    (x11.dependencies.reduceThumbnail as ReturnType<typeof vi.fn>).mockReturnValueOnce({ png, width: 1024, height: 640 });
    await expect(x11.service.perform(identity, { command: "screenshot", window }, signal(), owner)).resolves.toMatchObject({ code: "native-failure" });
  });

  it("times out a hung inspection after 10 seconds, kills the worker and starts a fresh one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { service, children, respond } = harness();
    respond(() => undefined);
    const pending = service.perform(identity, snapshot, signal(), owner);
    await flush();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, code: "timeout", reason: null, dispatched: false });
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    respond(() => ({ ok: true, value: snapshotValue }));
    const next = service.perform(identity, snapshot, signal(), owner);
    await flush();
    await expect(next).resolves.toMatchObject({ ok: true });
    expect(children).toHaveLength(2);
  });

  it("gives an action 20 seconds and reports it as possibly dispatched", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { service, children, respond } = harness();
    respond(() => undefined);
    const pending = service.perform(identity, press, signal(), owner);
    await flush();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, code: "timeout", reason: null, dispatched: true });
  });

  it("forces the kill after the 3 second grace and disables itself only when that exit is not confirmed either", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const forced: number[] = [];
    const recovered = harness({ forceKill: (pid) => { forced.push(pid); recovered.children[0]!.emit("exit", 9); } });
    recovered.respond(() => undefined);
    const hung = recovered.service.perform(identity, snapshot, signal(), owner);
    await flush();
    recovered.children[0]!.exitOnKill = false;
    await vi.advanceTimersByTimeAsync(10_000 + 2_999);
    expect(forced).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(hung).resolves.toMatchObject({ code: "timeout" });
    expect(forced).toEqual([4_242]);
    expect(recovered.service.available).toBe(true);

    const forceKill = vi.fn();
    const { service, children, respond } = harness({ forceKill });
    respond(() => undefined);
    const pending = service.perform(identity, snapshot, signal(), owner);
    await flush();
    children[0]!.exitOnKill = false;
    await vi.advanceTimersByTimeAsync(10_000 + 3_000);
    expect(forceKill).toHaveBeenCalledExactlyOnceWith(4_242);
    expect(service.available).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ code: "timeout" });
    expect(service.available).toBe(false);
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ code: "unavailable" });
    await expect(service.dispose()).rejects.toThrow("unconfirmed");
  });

  it("recycles the worker after a native failure, a crash or a malformed answer", async () => {
    const { service, children, respond } = harness();
    respond(() => ({ ok: false, code: "native-failure", reason: null, dispatched: false }));
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ code: "native-failure" });
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    respond(() => ({ ok: true, value: { kind: "windows", windows: [], omitted: 0 } }));
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ code: "native-failure" });
    expect(children[1]!.kill).toHaveBeenCalledOnce();
    respond((request) => {
      setImmediate(() => children.at(-1)!.emit("exit", 9));
      return request.id === -1 ? null : undefined;
    });
    await expect(service.perform(identity, press, signal(), owner)).resolves.toEqual({ ok: false, code: "native-failure", reason: null, dispatched: true });
    respond(() => ({ ok: false, code: "not-found", reason: "stale", dispatched: false }));
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ code: "not-found" });
    expect(children).toHaveLength(4);
    expect(children[3]!.kill).not.toHaveBeenCalled();
  });

  it("answers a cancelled call at once while the next command waits for the native call to finish", async () => {
    const { service, children, respond } = harness();
    let release!: () => void;
    respond((request) => {
      if (request.id === 1) {
        release = () => children[0]!.emit("message", { id: 1, result: { ok: true, value: { kind: "perform", rootKey: null, windowClosed: false } } });
        return undefined;
      }
      return { ok: true, value: snapshotValue };
    });
    const controller = new AbortController();
    const first = service.perform(identity, press, controller.signal, owner);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.perform(identity, snapshot, signal(), owner);
    controller.abort();
    await expect(first).resolves.toEqual({ ok: false, code: "cancelled", reason: null, dispatched: true });
    let settled = false;
    void second.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(children[0]!.requests.map(({ id }) => id)).toEqual([1, 2]);
  });

  it("keeps at most 16 commands queued", async () => {
    const { service, respond } = harness();
    respond(() => undefined);
    const pending = Array.from({ length: 16 }, () => service.perform(identity, snapshot, AbortSignal.timeout(50), owner));
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ code: "busy" });
    await Promise.all(pending);
    await service.dispose().catch(() => undefined);
  });

  it("reads the Windows process table in the worker", async () => {
    const { service, children, respond, dependencies } = harness({ platform: "win32", env: {} });
    respond((request) => request.command.command === "tree"
      ? { ok: true, value: { kind: "tree", entries: [
          { pid: 100, parentPid: 4, startedAtMs: started + 10, executable: "guardian.exe" },
          { pid: 101, parentPid: 100, startedAtMs: started + 20, executable: "consent.exe" },
          // No start time: a pid that cannot be proved a child is dropped with its subtree.
          { pid: 102, parentPid: 100, startedAtMs: null, executable: "helper.exe" },
        ] } }
      : { ok: true, value: snapshotValue });
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ ok: true });
    expect(dependencies.processTable).not.toHaveBeenCalled();
    expect(children[0]!.requests.map(({ command, scope }) => [command.command, scope])).toEqual([
      ["tree", { pids: [], deniedPids: [] }],
      ["snapshot", { pids: [100, 101], deniedPids: [101, 5, 6] }],
    ]);
  });

  it("reads the macOS process tree in the worker through libproc, never with ps", async () => {
    const { service, children, respond, dependencies } = harness({ platform: "darwin", env: {} });
    respond((request) => request.command.command === "tree"
      ? { ok: true, value: { kind: "tree", entries: [
          { pid: 100, parentPid: 1, startedAtMs: started + 10, executable: "/Applications/My App.app/Contents/MacOS/My App" },
          { pid: 101, parentPid: 100, startedAtMs: started + 20, executable: "/System/Applications/Utilities/Keychain Access.app/Contents/MacOS/Keychain Access" },
        ] } }
      : { ok: true, value: snapshotValue });
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ ok: true });
    expect(dependencies.processTable).not.toHaveBeenCalled();
    expect(children[0]!.requests.map(({ command, scope }) => [command.command, scope])).toEqual([
      ["tree", { pids: [], deniedPids: [] }],
      ["snapshot", { pids: [100, 101], deniedPids: [101, 5, 6] }],
    ]);
    // A tree read the helper is denied is the helper's own denial while macOS lists Inertia.
    respond(() => ({ ok: false, code: "permission-denied", reason: null, dispatched: false }));
    await expect(service.perform(identity, snapshot, signal(), owner)).resolves.toMatchObject({ code: "helper-permission-denied" });
  });

  it("refuses a launch whose root is not a direct child of the runtime that asked", async () => {
    const { service, children } = harness();
    await expect(service.perform(identity, snapshot, signal(), { parentPids: [77] }))
      .resolves.toEqual({ ok: false, code: "not-found", reason: "launch-gone", dispatched: false });
    await expect(service.perform(identity, snapshot, signal(), { parentPids: [] }))
      .resolves.toMatchObject({ code: "not-found", reason: "launch-gone" });
    expect(children).toHaveLength(0);
    await expect(service.perform(identity, snapshot, signal(), { parentPids: [1] })).resolves.toMatchObject({ ok: true });
  });

  it("refuses a process tree too large to check with unavailable", async () => {
    const { service, dependencies, children } = harness();
    (dependencies.processTable as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new AppControlTreeTooLargeError());
    await expect(service.perform(identity, snapshot, signal(), owner))
      .resolves.toEqual({ ok: false, code: "unavailable", reason: "tree-too-large", dispatched: false });
    expect(children).toHaveLength(0);
  });

  it("reuses a launch's resolved process tree for one second", async () => {
    let now = 1_000;
    const { service, dependencies } = harness({ now: () => now });
    await service.perform(identity, snapshot, signal(), owner);
    now += 999;
    await service.perform(identity, snapshot, signal(), owner);
    expect(dependencies.processTable).toHaveBeenCalledOnce();
    now += 1;
    await service.perform(identity, snapshot, signal(), owner);
    expect(dependencies.processTable).toHaveBeenCalledTimes(2);
    // Another launch identity never shares the cached tree, and the parent check still runs on a cached one.
    await service.perform({ ...identity, launchId: "55555555-5555-4555-8555-555555555555" }, snapshot, signal(), owner);
    expect(dependencies.processTable).toHaveBeenCalledTimes(3);
    await expect(service.perform(identity, snapshot, signal(), { parentPids: [77] })).resolves.toMatchObject({ reason: "launch-gone" });
  });

  it("gives a screenshot the 20 second action watchdog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { service, children, respond } = harness();
    respond(() => undefined);
    const pending = service.perform(identity, { command: "screenshot", window }, signal(), owner);
    await flush();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, code: "timeout", reason: null, dispatched: false });
  });

  it("does not grow exit or abort listeners across 100 commands", async () => {
    const { service, children } = harness();
    const shared = new AbortController().signal;
    for (let index = 0; index < 100; index += 1) {
      await expect(service.perform(identity, snapshot, shared, owner)).resolves.toMatchObject({ ok: true });
    }
    expect(children).toHaveLength(1);
    expect(children[0]!.listenerCount("exit")).toBe(1);
    expect(children[0]!.listenerCount("message")).toBe(1);
    expect(getEventListeners(shared, "abort")).toHaveLength(0);
    expect(service.pendingListeners).toBe(0);
  });

  it("latches off after three workers fail to load, until the Settings card probes again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let loads = false;
    const children: Child[] = [];
    const { service } = harness({
      readyTimeoutMs: 1_000,
      fork: () => {
        const child = new Child(() => () => ({ ok: true, value: { kind: "windows", windows: [], omitted: 0 } }), loads);
        children.push(child);
        return child;
      },
    });
    for (const reason of [null, null, "start-failed"]) {
      const pending = service.perform(identity, snapshot, signal(), owner);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ ok: false, code: "native-failure", reason, dispatched: false });
    }
    expect(children).toHaveLength(3);
    // Latched: nothing is forked and the answer is immediate.
    await expect(service.perform(identity, snapshot, signal(), owner))
      .resolves.toEqual({ ok: false, code: "native-failure", reason: "start-failed", dispatched: false });
    expect(children).toHaveLength(3);
    // The Settings probe is the retry: it clears the latch and tries a fresh worker.
    loads = true;
    const probe = service.settingsState();
    await vi.advanceTimersByTimeAsync(0);
    await expect(probe).resolves.toMatchObject({ accessibility: "available" });
    expect(children).toHaveLength(4);
    await service.dispose();
  });

  it("fails a worker that never loads its bindings", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const children: Child[] = [];
    const { service } = harness({
      readyTimeoutMs: 1_000,
      fork: () => {
        const child = new Child(() => () => undefined, false);
        children.push(child);
        return child;
      },
    });
    const pending = service.perform(identity, snapshot, signal(), owner);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ code: "native-failure" });
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });
});
