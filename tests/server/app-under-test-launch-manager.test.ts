import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_UNDER_TEST_TOOL_NAMES,
  MAX_APP_LAUNCHES_PER_CONVERSATION,
  MAX_APP_LAUNCHES_PER_RUNTIME,
  appUnderTestLaunchSchema,
  type AppUnderTestWindow,
  type AppUnderTestWindowAccessGate,
} from "../../src/shared/app-under-test";
import { AppUnderTestError } from "../../src/server/runtime/app-under-test/errors";
import { containedPath, resolveElectronLaunchTarget } from "../../src/server/runtime/app-under-test/electron-target";
import {
  AppUnderTestLaunchManager,
  appUnderTestEnvironment,
  type AppUnderTestLaunchManagerOptions,
  type AppUnderTestRuntimeEvent,
} from "../../src/server/runtime/app-under-test/launch-manager";
import { providerProcessInvocation } from "../../src/server/provider/process";
import type {
  AppUnderTestCdpTransportContext,
  AppUnderTestWindowTransport,
} from "../../src/server/runtime/app-under-test/window-transport";

const roots: string[] = [];
const conversationId = "11111111-1111-4111-8111-111111111111";
const otherConversationId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio: unknown[];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly spawnfile: string;

  constructor(readonly pid: number | undefined, command: string, pipes: number) {
    super();
    this.spawnfile = command;
    this.stdio = [null, this.stdout, this.stderr, ...Array.from({ length: pipes - 3 }, () => new PassThrough())];
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }
}

interface Spawned {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
}

async function workspace(): Promise<{ root: string; data: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), "inertia-app-under-test-"));
  roots.push(root);
  const project = join(root, "project");
  const data = join(root, "data");
  await mkdir(join(project, "node_modules", "electron", "dist"), { recursive: true });
  await mkdir(data);
  await writeFile(join(project, "node_modules", "electron", "path.txt"), "electron");
  await writeFile(join(project, "node_modules", "electron", "dist", "electron"), "#!/bin/false\n");
  await chmod(join(project, "node_modules", "electron", "dist", "electron"), 0o755);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", main: "main.js" }));
  await writeFile(join(project, "main.js"), "");
  return { root, data, project };
}

function harness(
  paths: { data: string; project: string },
  overrides: Partial<AppUnderTestLaunchManagerOptions> & { exitOnTerminate?: boolean; confirmTermination?: boolean } = {},
) {
  const spawned: Spawned[] = [];
  const events: AppUnderTestRuntimeEvent[] = [];
  let nextPid = 4_000;
  const terminations: Array<{ pid: number | undefined; force: boolean }> = [];
  const manager = new AppUnderTestLaunchManager({
    dataDirectory: paths.data,
    platform: "linux",
    workspace: (id) => {
      if (id !== conversationId && id !== otherConversationId) throw new Error("missing chat");
      return {
        root: paths.project,
        actions: [{ id: actionId, name: "Dev server", executable: "node", args: ["server.js", "--port", "5173"] }],
      };
    },
    emit: (event) => events.push(event),
    sourceEnvironment: async () => ({
      env: {
        PATH: "/usr/bin",
        HOME: "/home/user",
        DISPLAY: ":1",
        WAYLAND_DISPLAY: "wayland-0",
        OPENAI_API_KEY: "sk-secret",
        ANTHROPIC_API_KEY: "secret",
        GITHUB_TOKEN: "ghp_secret",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require /tmp/evil.js",
        ELECTRON_OVERRIDE_DIST_PATH: "/tmp/elsewhere",
      },
      pathEntries: ["/usr/bin"],
    }) as never,
    resolveActionExecutable: async (name) => `/usr/bin/${name}`,
    spawn: (command, args, options) => {
      const child = new FakeChild(nextPid++, command, (options.stdio as unknown[]).length);
      spawned.push({ command, args, options, child });
      process.nextTick(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
    terminateProcessTree: async (child, force) => {
      terminations.push({ pid: child.pid, force });
      // A real child reports exit asynchronously, after the signal.
      await new Promise((resolve) => setImmediate(resolve));
      if (overrides.exitOnTerminate !== false) (child as unknown as FakeChild).exit(null, force ? "SIGKILL" : "SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
      return overrides.confirmTermination ?? true;
    },
    launchSettleMs: 5,
    stopExitWaitMs: 50,
    ...overrides,
  });
  return { manager, spawned, events, terminations };
}

function transport(windows: AppUnderTestWindow[]): AppUnderTestWindowTransport & { closed: number } {
  const value = {
    closed: 0,
    windows: () => windows,
    pendingDialog: () => null,
    redactLog: (text: string) => text,
    inspect: vi.fn(),
    perform: vi.fn(),
    waitForWindow: vi.fn(async () => windows.length > 0),
    close: () => { value.closed += 1; },
  };
  return value as never;
}

describe("AppUnderTestLaunchManager", () => {
  it("spawns the project's contained Electron binary without a shell, with pipes, an isolated profile and a sanitized environment", async () => {
    const paths = await workspace();
    const { manager, spawned } = harness(paths);
    const launch = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    expect(launch).toMatchObject({ kind: "electron", state: "running", startedBy: "agent", cdp: false, windowCount: 0, windows: [], label: "Electron app" });
    expect(spawned).toHaveLength(1);
    const [{ command, args, options }] = spawned;
    expect(command).toBe(join(paths.project, "node_modules", "electron", "dist", "electron"));
    expect(options).toMatchObject({ cwd: paths.project, shell: false, detached: true, windowsHide: false });
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe", "pipe", "pipe"]);
    const profile = join(paths.data, "app-under-test", launch.launchId);
    expect(args).toEqual(["--remote-debugging-pipe", `--user-data-dir=${profile}`, paths.project]);
    // Windows reports synthetic POSIX modes (0o666), not the requested 0o700.
    if (process.platform !== "win32") {
      expect((await stat(profile)).mode & 0o777).toBe(0o700);
      expect((await stat(join(paths.data, "app-under-test"))).mode & 0o777).toBe(0o700);
    }
    expect(options.env).toMatchObject({
      PATH: "/usr/bin", HOME: "/home/user", DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-0", ACCESSIBILITY_ENABLED: "1",
    });
    // The debugging pipe already carries console lines; Chromium's stderr copy would repeat them.
    for (const key of ["ELECTRON_ENABLE_LOGGING", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "ELECTRON_OVERRIDE_DIST_PATH"]) {
      expect(options.env, key).not.toHaveProperty(key);
    }
    await manager.dispose();
  });

  it("runs a reviewed project action with its own arguments and only stdout/stderr pipes", async () => {
    const paths = await workspace();
    const { manager, spawned } = harness(paths);
    const launch = await manager.launch({ conversationId, kind: "action", actionId, startedBy: "user" });
    expect(launch).toMatchObject({ kind: "action", actionId, label: "Dev server", startedBy: "user", cdp: false });
    expect(spawned[0]).toMatchObject({ command: "/usr/bin/node", args: ["server.js", "--port", "5173"] });
    expect(spawned[0]!.options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    expect(spawned[0]!.options.env).toMatchObject({ ELECTRON_ENABLE_LOGGING: "1", ACCESSIBILITY_ENABLED: "1" });
    await expect(readdir(join(paths.data, "app-under-test")).catch(() => [])).resolves.toEqual([]);
    await expect(manager.launch({ conversationId, kind: "action", actionId: "44444444-4444-4444-8444-444444444444", startedBy: "agent" }))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(manager.launch({ conversationId, kind: "action", startedBy: "agent" })).rejects.toMatchObject({ code: "invalid" });
    await manager.dispose();
  });

  it("serves an action launch's native windows through the accessibility transport, with the spawn time as identity", async () => {
    const paths = await workspace();
    const contexts: Array<Parameters<NonNullable<AppUnderTestLaunchManagerOptions["accessibilityTransports"]>["create"]>[0]> = [];
    const window: AppUnderTestWindow = {
      windowId: "55555555-5555-4555-8555-555555555555", launchId: "", title: "Native", origin: null, active: true, loading: false,
    };
    const refreshWindows = vi.fn(async () => undefined);
    const transport: AppUnderTestWindowTransport = {
      windows: () => (contexts[0] ? [{ ...window, launchId: contexts[0].launchId }] : []),
      pendingDialog: () => null,
      redactLog: (text) => text,
      inspect: vi.fn(),
      perform: vi.fn(),
      waitForWindow: async () => true,
      close: vi.fn(),
      refreshWindows,
      status: () => status,
      watchChanged: vi.fn(),
      turnSettled: vi.fn(),
    };
    let status: { unavailable: string | null; protectedApps: number; access: AppUnderTestWindowAccessGate | null } = {
      unavailable: "Allow accessibility.", protectedApps: 2, access: "permission",
    };
    let watched = false;
    const before = Date.now();
    const { manager, events } = harness(paths, {
      accessibilityTransports: { create: (context) => { contexts.push(context); return transport; } },
      watched: (id) => id === conversationId && watched,
    });
    const launch = await manager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" });
    expect(launch).toMatchObject({ cdp: false, transport: "accessibility", windowCount: 1, protectedApps: 2, windowAccess: "permission" });
    expect(appUnderTestLaunchSchema.safeParse(launch).success).toBe(true);
    // Polling follows the chat's subscribers and turns.
    expect(contexts[0]!.watched?.()).toBe(false);
    watched = true;
    expect(contexts[0]!.watched?.()).toBe(true);
    manager.watchChanged("99999999-9999-4999-8999-999999999999");
    expect(transport.watchChanged).not.toHaveBeenCalled();
    manager.watchChanged(conversationId);
    manager.watchChanged();
    expect(transport.watchChanged).toHaveBeenCalledTimes(2);
    // A gate that ends is republished as launch state.
    status = { unavailable: null, protectedApps: 0, access: null };
    contexts[0]!.windowsChanged();
    const updates = events.filter((event) => event.type === "app-under-test.launch.updated");
    expect(updates.at(-1)).toMatchObject({ launch: { protectedApps: 0, windowAccess: null } });
    status = { unavailable: "Allow accessibility.", protectedApps: 2, access: "permission" };
    expect(contexts[0]).toMatchObject({ launchId: launch.launchId, conversationId, pid: launch.pid });
    expect(contexts[0]!.processStartedAt).toBeGreaterThanOrEqual(before);
    expect(contexts[0]!.processStartedAt).toBeLessThanOrEqual(Date.now());
    expect(manager.hasWindowTransport(conversationId)).toBe(true);
    const turn = { runId: "66666666-6666-4666-8666-666666666666", turnId: "77777777-7777-4777-8777-777777777777" };
    await manager.refreshWindows(conversationId, new AbortController().signal, turn);
    expect(refreshWindows).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), turn);
    const waitForWindow = vi.spyOn(transport, "waitForWindow");
    await manager.waitForReady(conversationId, launch.launchId, new AbortController().signal, 1_000, turn);
    expect(waitForWindow).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), 1_000, turn);
    expect(manager.transportStatus(conversationId)).toEqual({ unavailable: "Allow accessibility.", protectedApps: 2, access: "permission" });
    expect(manager.windowOwner(conversationId, window.windowId)?.transport).toBe(transport);
    // Per-turn transport state (foreground grants) ends with the turn.
    manager.turnSettled("66666666-6666-4666-8666-666666666666");
    expect(transport.turnSettled).toHaveBeenCalledWith("66666666-6666-4666-8666-666666666666");
    // A screenshot the model received, and an activation, keep their own fixed evidence labels.
    const thumbnail = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(30)]);
    expect(contexts[0]!.evidence({ kind: "screenshot", png: thumbnail, width: 10, height: 10, sentToAgent: true })).toEqual(expect.any(String));
    expect(contexts[0]!.evidence({ kind: "action", action: "activate" })).toEqual(expect.any(String));
    expect(manager.listEvidence(conversationId).slice(-2).map(({ label }) => label))
      .toEqual(["Screenshot sent to the agent", "Agent brought a window to the front"]);
    // An Electron launch never uses it.
    const electron = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    expect(electron).toMatchObject({ transport: null, cdp: false });
    expect(electron).not.toHaveProperty("protectedApps");
    expect(electron).not.toHaveProperty("windowAccess");
    expect(contexts).toHaveLength(1);
    await manager.dispose();
    expect(transport.close).toHaveBeenCalled();
  });

  it("runs a Windows batch action only through the reviewed workspace-action invocation, never a shell option", async () => {
    const paths = await workspace();
    const { manager, spawned } = harness(paths, {
      platform: "win32",
      resolveActionExecutable: async () => "C:\\Project\\scripts\\dev server.cmd",
    });
    await manager.launch({ conversationId, kind: "action", actionId, startedBy: "user" });
    const [{ command, args, options }] = spawned;
    const expected = providerProcessInvocation(
      "C:\\Project\\scripts\\dev server.cmd", ["server.js", "--port", "5173"], options.env, "win32",
    );
    expect({ command, args }).toEqual({ command: expected.command, args: expected.args });
    expect(args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(options).toMatchObject({ shell: false, windowsVerbatimArguments: true, windowsHide: true, detached: false });
    await manager.dispose();
  });

  it("limits live launches per chat and across the runtime, and frees a slot when one exits", async () => {
    const paths = await workspace();
    const { manager, spawned } = harness(paths);
    for (let index = 0; index < MAX_APP_LAUNCHES_PER_CONVERSATION; index += 1) {
      await manager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" });
    }
    await expect(manager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" }))
      .rejects.toMatchObject({ code: "too-large", message: expect.stringContaining("inertia_app_stop") });
    spawned[0]!.child.exit(0);
    await vi.waitFor(() => expect(manager.liveLaunchCount).toBe(1));
    await expect(manager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" })).resolves.toMatchObject({ state: "running" });
    await manager.dispose();

    const chats = Array.from({ length: MAX_APP_LAUNCHES_PER_RUNTIME }, (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`);
    const { manager: manyManager } = harness(paths, {
      workspace: () => ({ root: paths.project, actions: [{ id: actionId, name: "Dev", executable: "node", args: [] }] }),
    });
    for (const chat of chats) await manyManager.launch({ conversationId: chat, kind: "action", actionId, startedBy: "agent" });
    await expect(manyManager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" }))
      .rejects.toMatchObject({ code: "too-large", message: expect.stringContaining("across all chats") });
    await manyManager.dispose();
  });

  it("tracks exit, keeps the exited launch with its logs, and proves cleanup before deleting the profile", async () => {
    const paths = await workspace();
    const { manager, spawned, events, terminations } = harness(paths);
    const launch = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    const child = spawned[0]!.child;
    child.stdout.write("ready on http://localhost:5173\n");
    child.stderr.write(Buffer.from([0xe2, 0x82]));
    child.stderr.write(Buffer.from([0xac, 0x0a]));
    child.exit(3);
    await vi.waitFor(() => expect(manager.status(conversationId, launch.launchId)[0]).toMatchObject({
      state: "exited", exitCode: 3, signal: null, stopRequested: false, cleanupConfirmed: true,
    }));
    expect(terminations).toEqual([{ pid: launch.pid, force: true }]);
    await expect(lstat(join(paths.data, "app-under-test", launch.launchId))).rejects.toMatchObject({ code: "ENOENT" });
    const page = manager.logs(conversationId, launch.launchId);
    expect(page.lines.map(({ stream, text }) => [stream, text])).toEqual([
      ["inertia", "Launched by the agent."],
      ["stdout", "ready on http://localhost:5173"],
      ["stderr", "€"],
      ["inertia", "Exited with code 3."],
    ]);
    expect(manager.listEvidence(conversationId).map(({ kind, label }) => [kind, label])).toEqual([
      ["launch", "Launched by the agent"],
      ["exit", "Exited with code 3"],
    ]);
    expect(events.filter(({ type }) => type === "app-under-test.launch.updated").at(-1))
      .toMatchObject({ launch: { state: "exited", cleanupConfirmed: true } });
    await vi.waitFor(() => expect(events.some(({ type }) => type === "app-under-test.logs.appended")).toBe(true));
    const logEvent = events.find((event) => event.type === "app-under-test.logs.appended");
    expect(logEvent).toMatchObject({ conversationId, launchId: launch.launchId });
  });

  it("keeps at most eight launches per chat, dropping the oldest exited ones first", async () => {
    const paths = await workspace();
    const { manager, spawned } = harness(paths);
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      ids.push((await manager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" })).launchId);
      if (index < 10) spawned.at(-1)!.child.exit(0);
      await vi.waitFor(() => expect(manager.liveLaunchCount).toBeLessThanOrEqual(1));
    }
    expect(manager.status(conversationId).map(({ launchId }) => launchId)).toEqual(ids.slice(-8));
    expect(manager.status(conversationId).at(-1)).toMatchObject({ state: "running" });
    await manager.dispose();
  });

  it("never drops a launch not proved stopped, and refuses a ninth while all eight are unproved", async () => {
    const paths = await workspace();
    const unproved = new Set<number>();
    const { manager, spawned } = harness(paths, {
      terminateProcessTree: async (child) => {
        await new Promise((resolve) => setImmediate(resolve));
        return !unproved.has(child.pid!);
      },
    });
    const launchAndExit = async (keepUnproved: boolean): Promise<string> => {
      const launch = await manager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" });
      if (keepUnproved) unproved.add(launch.pid!);
      spawned.at(-1)!.child.exit(0);
      await vi.waitFor(() => expect(manager.status(conversationId, launch.launchId)[0]!.cleanupConfirmed).toBe(!keepUnproved));
      return launch.launchId;
    };
    const ids = [await launchAndExit(true)];
    for (let index = 0; index < 9; index += 1) ids.push(await launchAndExit(false));
    // The oldest launch may still run, so only proved-stopped launches made room.
    expect(manager.status(conversationId).map(({ launchId }) => launchId)).toEqual([ids[0], ...ids.slice(-7)]);
    for (let index = 0; index < 7; index += 1) ids.push(await launchAndExit(true));
    // Seven more unproved launches pushed out every proved-stopped one.
    expect(manager.status(conversationId).map(({ launchId }) => launchId)).toEqual([ids[0], ...ids.slice(-7)]);
    const count = spawned.length;
    await expect(manager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" })).rejects.toMatchObject({
      code: "too-large",
      message: "This chat has 8 launches running or not confirmed stopped. Stop or confirm them with inertia_app_stop first.",
    });
    expect(spawned).toHaveLength(count);
    expect(manager.status(conversationId).every(({ cleanupConfirmed }) => cleanupConfirmed === false)).toBe(true);
    await expect(manager.dispose()).resolves.toBe(false);
  });

  it("stops the whole tree with confirmation and reports unconfirmed cleanup truthfully", async () => {
    const paths = await workspace();
    const { manager, terminations } = harness(paths);
    const launch = await manager.launch({ conversationId, kind: "electron", startedBy: "user" });
    const stopped = await manager.stop(conversationId, launch.launchId);
    expect(stopped).toMatchObject({ state: "exited", signal: "SIGTERM", stopRequested: true, cleanupConfirmed: true });
    expect(manager.listEvidence(conversationId).at(-1)).toMatchObject({ kind: "exit", label: "Stopped" });
    expect(terminations).toEqual([{ pid: launch.pid, force: false }]);
    expect(manager.logs(conversationId, launch.launchId).lines.at(-1)?.text).toBe("Stopped by Inertia.");
    await expect(lstat(join(paths.data, "app-under-test", launch.launchId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.stop(conversationId, launch.launchId)).resolves.toMatchObject({ state: "exited" });
    expect(terminations).toHaveLength(1);

    const onCleanupUnconfirmed = vi.fn();
    const { manager: unconfirmed } = harness(paths, { exitOnTerminate: false, confirmTermination: false, onCleanupUnconfirmed });
    const alive = await unconfirmed.launch({ conversationId, kind: "electron", startedBy: "agent" });
    await expect(unconfirmed.stop(conversationId, alive.launchId)).resolves.toMatchObject({
      state: "stopping", cleanupConfirmed: false, failure: "Inertia could not confirm that the app stopped.",
    });
    expect(onCleanupUnconfirmed).toHaveBeenCalled();
    expect(unconfirmed.liveLaunchCount).toBe(1);
    // The profile stays while the tree may still use it.
    await expect(lstat(join(paths.data, "app-under-test", alive.launchId))).resolves.toBeTruthy();
    await expect(unconfirmed.dispose()).resolves.toBe(false);
  });

  it("clears a chat's App session, stopping only that chat's launches", async () => {
    const paths = await workspace();
    const { manager, events } = harness(paths);
    const mine = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    const other = await manager.launch({ conversationId: otherConversationId, kind: "action", actionId, startedBy: "agent" });
    await expect(manager.clear(conversationId)).resolves.toBe(true);
    expect(manager.status(conversationId)).toEqual([]);
    expect(() => manager.logs(conversationId, mine.launchId)).toThrow(AppUnderTestError);
    expect(manager.listEvidence(conversationId)).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "app-under-test.session.cleared", conversationId });
    expect(manager.status(otherConversationId)[0]).toMatchObject({ launchId: other.launchId, state: "running" });
    expect(() => manager.status(otherConversationId, mine.launchId)).toThrow("does not belong to this chat");
    await expect(lstat(join(paths.data, "app-under-test", mine.launchId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.dispose()).resolves.toBe(true);
    expect(manager.status(otherConversationId)).toEqual([]);
    await expect(manager.launch({ conversationId, kind: "electron", startedBy: "agent" }))
      .rejects.toMatchObject({ code: "unavailable", message: "The runtime is shutting down." });
  });

  it("stops a launch whose call was cancelled after it started", async () => {
    const paths = await workspace();
    const { manager, spawned } = harness(paths, { launchSettleMs: 30_000 });
    const controller = new AbortController();
    const pending = manager.launch({ conversationId, kind: "electron", startedBy: "agent", signal: controller.signal });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled", dispatched: true });
    expect(manager.status(conversationId)[0]).toMatchObject({ state: "exited", cleanupConfirmed: true });
    expect(manager.liveLaunchCount).toBe(0);
  });

  it("records a launch that could not start and removes its profile", async () => {
    const paths = await workspace();
    await rm(join(paths.project, "main.js"));
    const { manager, spawned } = harness(paths);
    await expect(manager.launch({ conversationId, kind: "electron", startedBy: "agent" }))
      .rejects.toMatchObject({ code: "not-found", message: expect.stringContaining("main entry") });
    expect(spawned).toEqual([]);
    expect(manager.status(conversationId)[0]).toMatchObject({ state: "exited", failure: expect.stringContaining("main entry"), cleanupConfirmed: true });
    expect(manager.liveLaunchCount).toBe(0);
  });

  it("sweeps profiles left by an earlier runtime before the first launch", async () => {
    const paths = await workspace();
    const stale = join(paths.data, "app-under-test", "55555555-5555-4555-8555-555555555555");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "Cookies"), "old");
    const unrelated = join(paths.data, "app-under-test", "keep-me");
    await mkdir(unrelated);
    const { manager } = harness(paths);
    await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(unrelated)).resolves.toBeTruthy();
    await manager.dispose();
  });

  it("hands fds 3 and 4 to the CDP transport factory and publishes its windows", async () => {
    const paths = await workspace();
    const windows: AppUnderTestWindow[] = [];
    const fake = transport(windows);
    let context: AppUnderTestCdpTransportContext | undefined;
    const { manager, spawned, events } = harness(paths, {
      cdpTransports: { create: (value) => { context = value; return fake; } },
    });
    const launch = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    expect(launch.cdp).toBe(true);
    expect(context?.input).toBe(spawned[0]!.child.stdio[3]);
    expect(context?.output).toBe(spawned[0]!.child.stdio[4]);
    const launchEvents = events.filter((event) => event.type === "app-under-test.launch.updated").length;
    windows.push({ windowId: "66666666-6666-4666-8666-666666666666", launchId: launch.launchId, title: "Fixture", origin: null, active: true, loading: false });
    context!.windowsChanged();
    context!.log("console", "renderer says hi");
    expect(manager.windows(conversationId)).toEqual(windows);
    // A surface opened later learns the windows from the launch record itself.
    expect(manager.status(conversationId, launch.launchId)[0]).toMatchObject({ windowCount: 1, windows, readyAt: expect.any(String) });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "app-under-test.windows.updated", conversationId, launchId: launch.launchId, windows }));
    // Window changes alone never publish a sequenced launch.updated.
    expect(events.filter((event) => event.type === "app-under-test.launch.updated")).toHaveLength(launchEvents);
    expect(manager.windowOwner(conversationId, windows[0]!.windowId)?.transport).toBe(fake);
    expect(manager.windowOwner(otherConversationId, windows[0]!.windowId)).toBeNull();
    expect(manager.logs(conversationId, launch.launchId, { grep: "renderer" }).lines).toEqual([
      expect.objectContaining({ stream: "console", text: "renderer says hi" }),
    ]);
    await expect(manager.stop(conversationId, launch.launchId)).resolves.toMatchObject({ windowCount: 0, windows: [] });
    expect(fake.closed).toBe(1);
    expect(manager.windows(conversationId)).toEqual([]);
  });

  it("coalesces live window lists, sends them only when they changed, and keeps launch.updated for launch changes", async () => {
    const paths = await workspace();
    const windows: AppUnderTestWindow[] = [];
    const fake = transport(windows);
    let context: AppUnderTestCdpTransportContext | undefined;
    const { manager, events } = harness(paths, { cdpTransports: { create: (value) => { context = value; return fake; } } });
    const launch = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    const launchUpdates = (): AppUnderTestRuntimeEvent[] => events.filter((event) => event.type === "app-under-test.launch.updated");
    const windowUpdates = (): AppUnderTestRuntimeEvent[] => events.filter((event) => event.type === "app-under-test.windows.updated");
    const before = launchUpdates().length;
    const window = { windowId: "66666666-6666-4666-8666-666666666666", launchId: launch.launchId, title: "One", origin: null, active: true, loading: true };
    windows.push(window);
    for (let index = 0; index < 20; index += 1) {
      window.title = `Title ${index}`;
      context!.windowsChanged();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(windowUpdates()).toHaveLength(0);
    await vi.waitFor(() => expect(windowUpdates()).toHaveLength(1));
    expect(windowUpdates()[0]).toMatchObject({ windows: [{ title: "Title 19" }] });
    // An unchanged list is not sent again.
    context!.windowsChanged();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(windowUpdates()).toHaveLength(1);
    expect(launchUpdates()).toHaveLength(before);
    // A state change carries the windows of that moment.
    const stopping = manager.stop(conversationId, launch.launchId);
    expect(launchUpdates().at(-1)).toMatchObject({ launch: { state: "stopping", windows: [{ title: "Title 19" }] } });
    await stopping;
    expect(launchUpdates().at(-1)).toMatchObject({ launch: { state: "exited", windows: [], cleanupConfirmed: true } });
    const states = launchUpdates().slice(before).map((event) => (event as { launch: { state: string; cleanupConfirmed: boolean | null } }).launch);
    expect(new Set(states.map((entry) => JSON.stringify(entry))).size).toBe(states.length);
  });

  it("redacts the secrets the launch's windows revealed from stdout, stderr and transport lines", async () => {
    const paths = await workspace();
    const fake = transport([]);
    fake.redactLog = (text: string) => text.replaceAll("hunter2-secret", "[redacted]");
    let context: AppUnderTestCdpTransportContext | undefined;
    const { manager, spawned } = harness(paths, { cdpTransports: { create: (value) => { context = value; return fake; } } });
    const launch = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    const child = spawned[0]!.child;
    // A secret split across chunks is still found: redaction sees whole lines.
    child.stdout.write("login with hunter2-");
    child.stdout.write("secret ok\n");
    child.stderr.write("warn hunter2-secret\n");
    context!.log("console", "echo hunter2-secret");
    context!.log("exception", "Error: hunter2-secret");
    context!.log("crash", "App window 1 crashed.");
    await vi.waitFor(() => expect(manager.logs(conversationId, launch.launchId).lines).toHaveLength(6));
    const lines = manager.logs(conversationId, launch.launchId).lines.map(({ stream, text }) => [stream, text]);
    expect(lines).toEqual(expect.arrayContaining([
      ["inertia", "Launched by the agent."],
      ["stdout", "login with [redacted] ok"],
      ["stderr", "warn [redacted]"],
      ["console", "echo [redacted]"],
      ["exception", "Error: [redacted]"],
      ["crash", "App window 1 crashed."],
    ]));
    expect(JSON.stringify(lines)).not.toContain("hunter2");
    await manager.dispose();
  });

  it("rate-limits console events per launch and marks dropped ones at most once a second", async () => {
    const paths = await workspace();
    let context: AppUnderTestCdpTransportContext | undefined;
    const { manager } = harness(paths, { cdpTransports: { create: (value) => { context = value; return transport([]); } } });
    const launch = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    for (let index = 0; index < 1_000; index += 1) context!.log("console", `line ${index}`);
    // Burst 400 plus at most a few tokens refilled while the loop ran.
    let total = 0;
    for (let cursor = 0; ;) {
      const page = manager.logs(conversationId, launch.launchId, { cursor, limit: 200, grep: "line " });
      total += page.lines.length;
      if (page.lines.length === 0) break;
      cursor = page.lines.at(-1)!.cursor;
    }
    expect(total).toBeGreaterThanOrEqual(400);
    expect(total).toBeLessThan(450);
    const markers = (): string[] => manager.logs(conversationId, launch.launchId, { grep: "dropped", limit: 200 }).lines.map(({ text }) => text);
    expect(markers()).toEqual([]);
    for (let index = 0; index < 100; index += 1) context!.log("console", `more ${index}`);
    await vi.waitFor(() => expect(markers()).toHaveLength(1), { timeout: 3_000 });
    expect(markers()[0]).toMatch(/^\d+ console events dropped\.$/u);
    expect(Number.parseInt(markers()[0]!, 10)).toBe(1_000 + 100 - total - manager.logs(conversationId, launch.launchId, { grep: "more ", limit: 200 }).lines.length);
    // Crash lines are never dropped.
    context!.log("crash", "App window 1 crashed.");
    expect(manager.logs(conversationId, launch.launchId).lines.at(-1)).toMatchObject({ stream: "crash" });
    await manager.dispose();
  });

  it("keeps at most 16 idle chat sessions, evicting the least recently used with its logs and evidence", async () => {
    const paths = await workspace();
    const chats = Array.from({ length: 19 }, (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`);
    const { manager, spawned, events } = harness(paths, {
      workspace: () => ({ root: paths.project, actions: [{ id: actionId, name: "Dev", executable: "node", args: [] }] }),
    });
    const cleared = (): unknown[] => events.filter((event) => event.type === "app-under-test.session.cleared");
    const launches: string[] = [];
    const runAndExit = async (chat: string): Promise<void> => {
      launches.push((await manager.launch({ conversationId: chat, kind: "action", actionId, startedBy: "agent" })).launchId);
      spawned.at(-1)!.child.exit(0);
      await vi.waitFor(() => expect(manager.status(chat)[0]).toMatchObject({ state: "exited" }));
    };
    for (const chat of chats.slice(0, 16)) await runAndExit(chat);
    expect(cleared()).toEqual([]);
    // Reading chat 0 makes it recent, so chat 1 is now the least recently used.
    manager.status(chats[0]!, launches[0]);
    await runAndExit(chats[16]!);
    expect(cleared()).toEqual([{ type: "app-under-test.session.cleared", conversationId: chats[1] }]);
    expect(manager.status(chats[1]!)).toEqual([]);
    expect(manager.listEvidence(chats[1]!)).toEqual([]);
    expect(() => manager.logs(chats[1]!, launches[1]!)).toThrow(AppUnderTestError);
    expect(manager.status(chats[0]!)).toHaveLength(1);
    // A session with a live launch is never evicted and does not count as idle.
    await manager.launch({ conversationId: chats[17]!, kind: "action", actionId, startedBy: "agent" });
    await runAndExit(chats[18]!);
    expect(cleared().at(-1)).toEqual({ type: "app-under-test.session.cleared", conversationId: chats[2] });
    expect(manager.status(chats[17]!)[0]).toMatchObject({ state: "running" });
    await manager.dispose();
  });

  it("keeps thumbnails within 16 MiB across the runtime by evicting idle sessions", async () => {
    const paths = await workspace();
    const chats = Array.from({ length: 9 }, (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`);
    const { manager, spawned, events } = harness(paths, {
      workspace: () => ({ root: paths.project, actions: [{ id: actionId, name: "Dev", executable: "node", args: [] }] }),
    });
    const png = (): Uint8Array => {
      const bytes = new Uint8Array(250 * 1024);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return bytes;
    };
    for (const chat of chats) {
      const launch = await manager.launch({ conversationId: chat, kind: "action", actionId, startedBy: "agent" });
      for (let shot = 0; shot < 8; shot += 1) {
        manager.appendEvidence(chat, launch.launchId, { kind: "screenshot", png: png(), width: 10, height: 10 });
      }
      spawned.at(-1)!.child.exit(0);
      await vi.waitFor(() => expect(manager.liveLaunchCount).toBe(0));
    }
    // Nine chats of 2,000 KiB each exceed 16 MiB: the oldest idle one goes.
    const total = chats.reduce((sum, chat) => sum + manager.listEvidence(chat)
      .reduce((bytes, entry) => bytes + (entry.thumbnail ? Buffer.from(entry.thumbnail.split(",")[1]!, "base64").byteLength : 0), 0), 0);
    expect(total).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(events).toContainEqual({ type: "app-under-test.session.cleared", conversationId: chats[0] });
    expect(manager.listEvidence(chats[8]!).filter(({ hasThumbnail }) => hasThumbnail)).toHaveLength(8);
    await manager.dispose();
  });

  it("reports an unconfirmed clear until the stuck launch is proved stopped", async () => {
    const paths = await workspace();
    const { manager } = harness(paths, { exitOnTerminate: false, confirmTermination: false });
    await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    await expect(manager.clear(conversationId)).resolves.toBe(false);
    // Retrying does not pretend the tree is gone.
    await expect(manager.clear(conversationId)).resolves.toBe(false);
    await expect(manager.clear(otherConversationId)).resolves.toBe(true);
  });

  it("keeps an unconfirmed clear's session reachable until a later clear or stop proves its launch stopped", async () => {
    const paths = await workspace();
    const { manager, spawned, events } = harness(paths, { exitOnTerminate: false });
    const cleared = (): unknown[] => events.filter((event) => event.type === "app-under-test.session.cleared");
    const electron = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    const action = await manager.launch({ conversationId: otherConversationId, kind: "action", actionId, startedBy: "agent" });
    await expect(manager.clear(conversationId)).resolves.toBe(false);
    await expect(manager.clear(otherConversationId)).resolves.toBe(false);
    for (const [chat, launch] of [[conversationId, electron], [otherConversationId, action]] as const) {
      expect(manager.status(chat)).toEqual([expect.objectContaining({
        launchId: launch.launchId, state: "stopping", cleanupConfirmed: false,
        failure: "Inertia could not confirm that the app stopped.",
      })]);
      expect(manager.logs(chat, launch.launchId).lines.length).toBeGreaterThan(0);
      expect(manager.listEvidence(chat).length).toBeGreaterThan(0);
    }
    expect(cleared()).toEqual([]);
    expect(manager.liveLaunchCount).toBe(2);
    // The process trees exit late; a later clear or stop proves it and completes the removal.
    for (const { child } of spawned) child.exit(null, "SIGTERM");
    await vi.waitFor(() => expect(manager.liveLaunchCount).toBe(0));
    await expect(manager.clear(conversationId)).resolves.toBe(true);
    expect(cleared()).toEqual([{ type: "app-under-test.session.cleared", conversationId }]);
    expect(manager.status(conversationId)).toEqual([]);
    await expect(lstat(join(paths.data, "app-under-test", electron.launchId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.stop(otherConversationId, action.launchId)).resolves.toMatchObject({
      state: "exited", cleanupConfirmed: true, failure: null,
    });
    expect(cleared().at(-1)).toEqual({ type: "app-under-test.session.cleared", conversationId: otherConversationId });
    expect(manager.status(otherConversationId)).toEqual([]);
    await expect(manager.dispose()).resolves.toBe(true);
  });

  it("never evicts an idle session whose launch exited without proof that its tree is gone", async () => {
    const paths = await workspace();
    const chats = Array.from({ length: 17 }, (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`);
    const { manager, spawned, events } = harness(paths, {
      workspace: () => ({ root: paths.project, actions: [{ id: actionId, name: "Dev", executable: "node", args: [] }] }),
      // Only the first launch's tree cannot be proved gone after it exits.
      terminateProcessTree: async (child, force) => {
        await new Promise((resolve) => setImmediate(resolve));
        (child as unknown as FakeChild).exit(null, force ? "SIGKILL" : "SIGTERM");
        await new Promise((resolve) => setImmediate(resolve));
        return child.pid !== 4_000;
      },
    });
    const stuck = await manager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" });
    await expect(manager.clear(conversationId)).resolves.toBe(false);
    expect(manager.status(conversationId)).toEqual([expect.objectContaining({
      launchId: stuck.launchId, state: "exited", cleanupConfirmed: false,
    })]);
    expect(manager.liveLaunchCount).toBe(0);
    for (const chat of chats) {
      await manager.launch({ conversationId: chat, kind: "action", actionId, startedBy: "agent" });
      spawned.at(-1)!.child.exit(0);
      await vi.waitFor(() => expect(manager.status(chat)[0]).toMatchObject({ state: "exited" }));
    }
    const cleared = events.filter((event) => event.type === "app-under-test.session.cleared");
    expect(cleared).toEqual([{ type: "app-under-test.session.cleared", conversationId: chats[0] }]);
    expect(manager.status(conversationId)).toEqual([expect.objectContaining({ launchId: stuck.launchId, cleanupConfirmed: false })]);
    await expect(manager.dispose()).resolves.toBe(false);
  });

  it("runs one window action at a time per launch and times out a queued one with nothing sent", async () => {
    const paths = await workspace();
    const { manager } = harness(paths, { actionQueueWaitMs: 30 });
    const launch = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    const order: string[] = [];
    let release!: () => void;
    const first = manager.withAction(conversationId, launch.launchId, async () => {
      order.push("first");
      await new Promise<void>((resolve) => { release = resolve; });
      return "first";
    });
    await expect(manager.withAction(conversationId, launch.launchId, async () => order.push("late")))
      .rejects.toMatchObject({ code: "timeout", dispatched: false });
    const queued = manager.withAction(conversationId, launch.launchId, async () => {
      order.push("queued");
      return "queued";
    });
    release();
    await expect(first).resolves.toBe("first");
    await expect(queued).resolves.toBe("queued");
    expect(order).toEqual(["first", "queued"]);
    await manager.dispose();
  });

  it("cancels a queued window action with its call, with nothing sent and the queue intact", async () => {
    const paths = await workspace();
    const { manager } = harness(paths);
    const launch = await manager.launch({ conversationId, kind: "electron", startedBy: "agent" });
    let release!: () => void;
    const first = manager.withAction(conversationId, launch.launchId, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "first";
    });
    const controller = new AbortController();
    const reached = vi.fn();
    const cancelled = manager.withAction(conversationId, launch.launchId, async () => reached(), controller.signal);
    const startedAt = Date.now();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled", dispatched: false });
    // The default queue wait is 30 s; a cancelled call stops waiting at once.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const already = new AbortController();
    already.abort();
    await expect(manager.withAction(conversationId, launch.launchId, async () => reached(), already.signal))
      .rejects.toMatchObject({ code: "cancelled" });
    const after = manager.withAction(conversationId, launch.launchId, async () => "after");
    release();
    await expect(first).resolves.toBe("first");
    await expect(after).resolves.toBe("after");
    expect(reached).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("keeps launch bookkeeping and cleanup when an event subscriber throws", async () => {
    const paths = await workspace();
    const { manager, spawned } = harness(paths, { emit: () => { throw new Error("subscriber failed"); } });
    const launch = await manager.launch({ conversationId, kind: "action", actionId, startedBy: "agent" });
    expect(launch.state).toBe("running");
    spawned[0]!.child.stdout.write("hello\n");
    spawned[0]!.child.exit(0);
    await vi.waitFor(() => expect(manager.status(conversationId, launch.launchId)[0]).toMatchObject({
      state: "exited", exitCode: 0, cleanupConfirmed: true,
    }));
    // The slot is free again: a throwing subscriber never strands a live launch.
    expect(manager.liveLaunchCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(manager.dispose()).resolves.toBe(true);
  });

  it("keeps the agent from naming anything but a kind and a reviewed action", () => {
    expect(APP_UNDER_TEST_TOOL_NAMES).toHaveLength(13);
    const source = { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "x", XAUTHORITY: "/run/x" };
    expect(appUnderTestEnvironment(source, "action", "linux")).toEqual({
      NO_COLOR: "1", PATH: "/bin", XAUTHORITY: "/run/x", ELECTRON_ENABLE_LOGGING: "1", ACCESSIBILITY_ENABLED: "1",
    });
    expect(appUnderTestEnvironment(source, "electron", "linux")).toEqual({
      NO_COLOR: "1", PATH: "/bin", XAUTHORITY: "/run/x", ACCESSIBILITY_ENABLED: "1",
    });
  });
});

describe("containedPath", () => {
  it("contains Windows paths by drive and case-insensitively, and refuses other drives, shares and siblings", () => {
    const root = "C:\\Users\\Dev\\Project";
    expect(containedPath(root, root, win32)).toBe(true);
    expect(containedPath(root, "c:\\users\\dev\\project\\node_modules\\electron\\dist\\electron.exe", win32)).toBe(true);
    expect(containedPath(root, "C:\\Users\\Dev\\Project\\..cache\\main.js", win32)).toBe(true);
    expect(containedPath(root, "C:\\Users\\Dev\\Project2\\main.js", win32)).toBe(false);
    expect(containedPath(root, "C:\\Users\\Dev\\main.js", win32)).toBe(false);
    expect(containedPath(root, "D:\\Users\\Dev\\Project\\main.js", win32)).toBe(false);
    expect(containedPath(root, "\\\\server\\share\\Project\\main.js", win32)).toBe(false);
    const share = "\\\\server\\share\\Project";
    expect(containedPath(share, "\\\\SERVER\\Share\\Project\\dist\\electron.exe", win32)).toBe(true);
    expect(containedPath(share, "\\\\server\\other\\Project\\dist\\electron.exe", win32)).toBe(false);
  });

  it("compares POSIX paths exactly, so a differently cased path is refused rather than assumed equal", () => {
    expect(containedPath("/home/dev/project", "/home/dev/project/node_modules/electron", posix)).toBe(true);
    expect(containedPath("/home/dev/project", "/home/dev/project-2/main.js", posix)).toBe(false);
    expect(containedPath("/home/dev/project", "/home/dev/Project/main.js", posix)).toBe(false);
    expect(containedPath("/home/dev/project", "/home/dev/project/..cache/main.js", posix)).toBe(true);
    expect(containedPath("/home/dev/project", "/home/dev", posix)).toBe(false);
  });
});

describe("resolveElectronLaunchTarget", () => {
  it("resolves dist/<path.txt> inside the project without executing anything", async () => {
    const paths = await workspace();
    await expect(resolveElectronLaunchTarget(paths.project, "linux")).resolves.toEqual({
      root: paths.project,
      executable: join(paths.project, "node_modules", "electron", "dist", "electron"),
      appPath: paths.project,
    });
  });

  it("refuses an Electron package or binary that a symlink places outside the project", async () => {
    const paths = await workspace();
    const outside = join(paths.root, "outside");
    await mkdir(join(outside, "dist"), { recursive: true });
    await writeFile(join(outside, "path.txt"), "electron");
    await writeFile(join(outside, "dist", "electron"), "");
    await chmod(join(outside, "dist", "electron"), 0o755);
    await rm(join(paths.project, "node_modules", "electron"), { recursive: true });
    await symlink(outside, join(paths.project, "node_modules", "electron"));
    await expect(resolveElectronLaunchTarget(paths.project, "linux")).rejects.toMatchObject({ code: "invalid" });

    const binary = await workspace();
    await rm(join(binary.project, "node_modules", "electron", "dist", "electron"));
    await symlink(join(outside, "dist", "electron"), join(binary.project, "node_modules", "electron", "dist", "electron"));
    await expect(resolveElectronLaunchTarget(binary.project, "linux")).rejects.toMatchObject({ code: "invalid" });

    const main = await workspace();
    await rm(join(main.project, "main.js"));
    await symlink(join(outside, "dist", "electron"), join(main.project, "main.js"));
    await expect(resolveElectronLaunchTarget(main.project, "linux"))
      .rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("main entry") });
  });

  it("refuses a missing package, a foreign path.txt and a non-executable binary", async () => {
    const paths = await workspace();
    await expect(resolveElectronLaunchTarget(paths.project, "darwin")).rejects.toMatchObject({ code: "unavailable" });
    await writeFile(join(paths.project, "node_modules", "electron", "path.txt"), "../../../bin/sh");
    await expect(resolveElectronLaunchTarget(paths.project, "linux")).rejects.toMatchObject({ code: "unavailable" });
    await writeFile(join(paths.project, "node_modules", "electron", "path.txt"), "electron");
    // Windows has no execute bit, so the non-executable refusal is POSIX-only.
    if (process.platform !== "win32") {
      await chmod(join(paths.project, "node_modules", "electron", "dist", "electron"), 0o644);
      await expect(resolveElectronLaunchTarget(paths.project, "linux")).rejects.toMatchObject({ code: "unavailable" });
    }
    await rm(join(paths.project, "node_modules"), { recursive: true });
    await expect(resolveElectronLaunchTarget(paths.project, "linux"))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("node_modules/electron") });
    await expect(resolveElectronLaunchTarget(join(paths.root, "missing"), "linux")).rejects.toMatchObject({ code: "unavailable" });
  });
});
