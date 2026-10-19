import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppUnderTestRuntimeWiring } from "../../src/server/runtime/app-under-test/runtime-wiring";
import {
  NO_CDP_TRANSPORT,
  type AppUnderTestCdpTransportContext,
  type CdpTransportFactory,
} from "../../src/server/runtime/app-under-test/window-transport";
import type { AppUnderTestWindow } from "../../src/shared/app-under-test";
import { clientCommandSchema, type ServerEvent } from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr, new PassThrough(), new PassThrough()];
  constructor(readonly pid: number) { super(); }
  exit(signal: NodeJS.Signals): void {
    this.emit("exit", null, signal);
    setImmediate(() => this.emit("close", null, signal));
  }
}

async function setup(options: { exits?: boolean; cdpTransports?: CdpTransportFactory } = {}) {
  const root = await mkdtemp(join(tmpdir(), "inertia-app-wiring-"));
  roots.push(root);
  let closed = false;
  const broadcast = vi.fn();
  const subscribers = vi.fn();
  const sent: ServerEvent[] = [];
  const children: FakeChild[] = [];
  const store = {
    conversation: vi.fn((id: string) => {
      if (id !== conversationId) throw new Error("That chat no longer exists.");
      return { id, projectId };
    }),
    conversationPath: vi.fn(() => root),
    project: vi.fn(() => ({ preferences: { actions: [{ id: actionId, name: "Dev server", executable: "node", args: ["server.js"] }] } })),
  };
  const onCleanupUnconfirmed = vi.fn();
  const wiring = createAppUnderTestRuntimeWiring({
    dataDirectory: join(root, "data"),
    store: store as never,
    closed: () => closed,
    broadcast,
    runtimeSync: { sendToConversationSubscribers: subscribers },
    send: (_socket, event) => sent.push(event),
    onCleanupUnconfirmed,
    cdpTransports: options.cdpTransports ?? NO_CDP_TRANSPORT,
    launchManager: {
      platform: "linux",
      sourceEnvironment: async () => ({ env: { PATH: "/usr/bin" }, pathEntries: [] }) as never,
      resolveActionExecutable: async () => "/usr/bin/node",
      resolveElectron: async (workspaceRoot) => ({ root: workspaceRoot, executable: "/usr/bin/electron", appPath: workspaceRoot }),
      spawn: () => {
        const child = new FakeChild(6_000 + children.length);
        children.push(child);
        process.nextTick(() => child.emit("spawn"));
        return child as unknown as ChildProcess;
      },
      terminateProcessTree: async (child) => {
        await new Promise((resolve) => setImmediate(resolve));
        if (options.exits !== false) (child as unknown as FakeChild).exit("SIGTERM");
        return options.exits !== false;
      },
      launchSettleMs: 1,
      stopExitWaitMs: 20,
    },
  });
  return { wiring, broadcast, subscribers, sent, children, onCleanupUnconfirmed, close: () => { closed = true; } };
}

describe("App under test runtime wiring", () => {
  it("routes mutations to the replayed broadcast and log lines only to the chat's subscribers", async () => {
    const { wiring, broadcast, subscribers, children } = await setup();
    const launch = await wiring.launches.launch({ conversationId, kind: "action", actionId, startedBy: "user" });
    expect(launch).toMatchObject({ label: "Dev server", state: "running", windows: [] });
    children[0]!.stdout.write("listening\n");
    await vi.waitFor(() => expect(subscribers).toHaveBeenCalled());
    for (const [chat, event] of subscribers.mock.calls) {
      expect(chat).toBe(conversationId);
      expect(event).toMatchObject({ type: "app-under-test.logs.appended", conversationId, launchId: launch.launchId });
    }
    const types = broadcast.mock.calls.map(([event]) => (event as { type: string }).type);
    expect(types).toContain("app-under-test.launch.updated");
    expect(types).not.toContain("app-under-test.logs.appended");
    await wiring.dispose();
  });

  it("sends window lists live to the chat's subscribers only, never into the replayed broadcast", async () => {
    const windows: AppUnderTestWindow[] = [];
    let context: AppUnderTestCdpTransportContext | undefined;
    const { wiring, broadcast, subscribers } = await setup({
      cdpTransports: {
        create: (value) => {
          context = value;
          return {
            windows: () => windows, pendingDialog: () => null, redactLog: (text) => text,
            inspect: vi.fn(), perform: vi.fn(), waitForWindow: async () => true, close: () => undefined,
          };
        },
      },
    });
    const launch = await wiring.launches.launch({ conversationId, kind: "electron", startedBy: "user" });
    windows.push({ windowId: "66666666-6666-4666-8666-666666666666", launchId: launch.launchId, title: "Fixture", origin: null, active: true, loading: false });
    context!.windowsChanged();
    await vi.waitFor(() => expect(subscribers).toHaveBeenCalledWith(conversationId, {
      type: "app-under-test.windows.updated", conversationId, launchId: launch.launchId, windows,
    }));
    const types = broadcast.mock.calls.map(([event]) => (event as { type: string }).type);
    expect(types).not.toContain("app-under-test.windows.updated");
    await expect(wiring.clearConversation(conversationId)).resolves.toBe(true);
    await wiring.dispose();
  });

  it("answers the App surface's commands for existing chats only", async () => {
    const { wiring, sent } = await setup();
    const list = clientCommandSchema.parse({ type: "app-under-test.launches.list", requestId: crypto.randomUUID(), payload: { conversationId } });
    await expect(wiring.commandHandler({} as WebSocket, list)).resolves.toBe("handled");
    expect(sent.at(-1)).toMatchObject({ result: { kind: "app-under-test.launches", conversationId, launches: [] } });
    const foreign = clientCommandSchema.parse({
      type: "app-under-test.launches.list", requestId: crypto.randomUUID(), payload: { conversationId: actionId },
    });
    await expect(wiring.commandHandler({} as WebSocket, foreign)).rejects.toThrow("no longer exists");
    await wiring.dispose();
  });

  it("stops a forgotten chat's launches and emits nothing once the runtime is closing", async () => {
    const { wiring, broadcast, close } = await setup();
    const launch = await wiring.launches.launch({ conversationId, kind: "action", actionId, startedBy: "agent" });
    wiring.forgetConversation(conversationId);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith({ type: "app-under-test.session.cleared", conversationId }));
    expect(wiring.launches.status(conversationId)).toEqual([]);
    expect(wiring.launches.liveLaunchCount).toBe(0);
    expect(launch.state).toBe("running");
    // Forgetting a chat without an App session is a no-op that never rejects.
    wiring.forgetConversation(actionId);
    close();
    broadcast.mockClear();
    await wiring.launches.launch({ conversationId, kind: "action", actionId, startedBy: "agent" });
    await expect(wiring.dispose()).resolves.toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("fails the shutdown drain when cleanup of a launch cannot be proved", async () => {
    const { wiring, onCleanupUnconfirmed } = await setup({ exits: false });
    await wiring.launches.launch({ conversationId, kind: "action", actionId, startedBy: "agent" });
    await expect(wiring.dispose()).rejects.toThrow("App under test cleanup could not be confirmed.");
    expect(onCleanupUnconfirmed).toHaveBeenCalled();
  });
});
