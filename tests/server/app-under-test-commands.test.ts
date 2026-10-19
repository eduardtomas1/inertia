import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeRequestError } from "../../src/server/runtime-errors";
import { runtimeMutationScope } from "../../src/server/runtime-sequencing";
import {
  AppUnderTestLaunchManager,
  type AppUnderTestRuntimeEvent,
} from "../../src/server/runtime/app-under-test/launch-manager";
import type {
  AppUnderTestCdpTransportContext,
  CdpTransportFactory,
} from "../../src/server/runtime/app-under-test/window-transport";
import { createAppUnderTestCommandHandler } from "../../src/server/runtime/commands/app-under-test-commands";
import { RUNTIME_COMMAND_POLICIES } from "../../src/renderer/src/utils/runtimeCommandPolicy";
import { APP_UNDER_TEST_COMMAND_TYPES, type AppUnderTestWindow } from "../../src/shared/app-under-test";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import {
  clientCommandSchema,
  type ClientCommand,
  type RuntimeMutationEvent,
  type ServerEvent,
} from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const actionId = "33333333-3333-4333-8333-333333333333";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr, new PassThrough(), new PassThrough()];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number) { super(); }
  exit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    setImmediate(() => this.emit("close", null, signal));
  }
}

async function setup(cdpTransports?: CdpTransportFactory) {
  const root = await mkdtemp(join(tmpdir(), "inertia-app-commands-"));
  roots.push(root);
  const project = join(root, "project");
  await mkdir(join(project, "node_modules", "electron", "dist"), { recursive: true });
  await writeFile(join(project, "node_modules", "electron", "path.txt"), "electron");
  await writeFile(join(project, "node_modules", "electron", "dist", "electron"), "");
  await chmod(join(project, "node_modules", "electron", "dist", "electron"), 0o755);
  await writeFile(join(project, "package.json"), "{}");
  const events: AppUnderTestRuntimeEvent[] = [];
  const children: FakeChild[] = [];
  const launches = new AppUnderTestLaunchManager({
    dataDirectory: join(root, "data"),
    platform: "linux",
    workspace: () => ({ root: project, actions: [{ id: actionId, name: "Tests", executable: "node", args: ["--test"] }] }),
    emit: (event) => events.push(event),
    sourceEnvironment: async () => ({ env: { PATH: "/usr/bin" }, pathEntries: [] }) as never,
    resolveActionExecutable: async () => "/usr/bin/node",
    spawn: () => {
      const child = new FakeChild(5_000 + children.length);
      children.push(child);
      process.nextTick(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
    terminateProcessTree: async (child) => {
      await new Promise((resolve) => setImmediate(resolve));
      (child as unknown as FakeChild).exit("SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
      return true;
    },
    launchSettleMs: 1,
    ...(cdpTransports ? { cdpTransports } : {}),
  });
  const sent: ServerEvent[] = [];
  const handler = createAppUnderTestCommandHandler({
    launches,
    assertConversation: (id) => {
      if (id !== conversationId) throw new RuntimeRequestError("That chat no longer exists.");
    },
    send: (_socket, event) => sent.push(event),
  });
  const run = async (command: Omit<ClientCommand, "requestId">): Promise<ServerEvent> => {
    const parsed = clientCommandSchema.parse({ ...command, requestId: crypto.randomUUID() });
    expect(await handler({} as WebSocket, parsed)).toBe("handled");
    const event = sent.at(-1)!;
    expect(parseServerEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    return event;
  };
  return { launches, events, children, run };
}

function mutationFrame(event: RuntimeMutationEvent): Record<string, unknown> {
  return {
    type: "runtime.event",
    sync: { runtimeGeneration: "77777777-7777-4777-8777-777777777777", latestSequence: 1 },
    scope: runtimeMutationScope(event),
    event,
  };
}

describe("App under test runtime commands and events", () => {
  it("accepts only a kind and a reviewed action id from the renderer", () => {
    const requestId = crypto.randomUUID();
    const parse = (payload: unknown) => clientCommandSchema.safeParse({ type: "app-under-test.launch", requestId, payload }).success;
    expect(parse({ conversationId, kind: "electron" })).toBe(true);
    expect(parse({ conversationId, kind: "action", actionId })).toBe(true);
    expect(parse({ conversationId, kind: "action" })).toBe(false);
    expect(parse({ conversationId, kind: "electron", actionId })).toBe(false);
    expect(parse({ conversationId, kind: "electron", args: ["--inspect"] })).toBe(false);
    expect(parse({ conversationId, kind: "action", actionId, command: "sh -c 'rm -rf /'" })).toBe(false);
    expect(clientCommandSchema.safeParse({
      type: "app-under-test.logs.read", requestId, payload: { conversationId, launchId: actionId, grep: "a\nb" },
    }).success).toBe(false);
    for (const type of APP_UNDER_TEST_COMMAND_TYPES) expect(RUNTIME_COMMAND_POLICIES[type], type).toBeDefined();
  });

  it("launches as the user, lists, reads logs, lists evidence and stops through validated results", async () => {
    const { run, events } = await setup();
    const launched = await run({ type: "app-under-test.launch", payload: { conversationId, kind: "electron" } } as never);
    expect(launched).toMatchObject({ type: "request.result", result: { kind: "app-under-test.launch", launch: { startedBy: "user", kind: "electron" } } });
    const { launchId } = (launched as { result: { launch: { launchId: string } } }).result.launch;
    await expect(run({ type: "app-under-test.launches.list", payload: { conversationId } } as never))
      .resolves.toMatchObject({ result: { kind: "app-under-test.launches", launches: [{ launchId }] } });
    await expect(run({ type: "app-under-test.logs.read", payload: { conversationId, launchId, limit: 5 } } as never))
      .resolves.toMatchObject({ result: { kind: "app-under-test.logs", launchId, lines: [{ stream: "inertia", text: "Launched by the user." }] } });
    await expect(run({ type: "app-under-test.stop", payload: { conversationId, launchId } } as never))
      .resolves.toMatchObject({ result: { kind: "app-under-test.launch", launch: { launchId, state: "exited", cleanupConfirmed: true } } });
    await expect(run({ type: "app-under-test.evidence.list", payload: { conversationId } } as never))
      .resolves.toMatchObject({ result: { kind: "app-under-test.evidence", evidence: [{ kind: "launch", label: "Launched by you", thumbnail: null }, { kind: "exit", label: "Stopped" }] } });

    await vi.waitFor(() => expect(events.some(({ type }) => type === "app-under-test.logs.appended")).toBe(true));
    for (const event of events) {
      const live = event.type === "app-under-test.logs.appended" || event.type === "app-under-test.windows.updated";
      const wire = JSON.parse(JSON.stringify(live ? event : mutationFrame(event)));
      expect(() => parseServerEvent(wire), event.type).not.toThrow();
      if (!live) {
        expect(runtimeMutationScope(event)).toEqual({ kind: "conversation-detail", conversationId });
      }
    }
    expect(() => parseServerEvent(mutationFrame({ type: "app-under-test.session.cleared", conversationId }))).not.toThrow();
    expect(() => parseServerEvent({ ...mutationFrame({ type: "app-under-test.session.cleared", conversationId }), scope: { kind: "shell" } }))
      .toThrow();
  });

  it("lists a running launch with its current windows, so a surface opened later shows them at once", async () => {
    const windows: AppUnderTestWindow[] = [];
    let context: AppUnderTestCdpTransportContext | undefined;
    const { run, events, launches } = await setup({
      create: (value) => {
        context = value;
        return {
          windows: () => windows,
          pendingDialog: () => null,
          redactLog: (text: string) => text,
          inspect: vi.fn(),
          perform: vi.fn(),
          waitForWindow: async () => windows.length > 0,
          close: () => undefined,
        };
      },
    });
    const launched = await run({ type: "app-under-test.launch", payload: { conversationId, kind: "electron" } } as never);
    const { launchId } = (launched as { result: { launch: { launchId: string } } }).result.launch;
    expect(launched).toMatchObject({ result: { launch: { cdp: true, windowCount: 0, windows: [] } } });
    windows.push({ windowId: "66666666-6666-4666-8666-666666666666", launchId, title: "Fixture", origin: "file://", active: true, loading: false });
    context!.windowsChanged();
    // A surface that mounts now rereads the list, which carries the windows.
    await expect(run({ type: "app-under-test.launches.list", payload: { conversationId } } as never))
      .resolves.toMatchObject({ result: { launches: [{ launchId, windowCount: 1, windows }] } });
    // Subscribed surfaces get the change live: a plain event, never a sequenced mutation.
    await vi.waitFor(() => expect(events.some((event) => event.type === "app-under-test.windows.updated")).toBe(true));
    const live = events.find((event) => event.type === "app-under-test.windows.updated")!;
    expect(parseServerEvent(JSON.parse(JSON.stringify(live)))).toEqual(live);
    expect(() => parseServerEvent(mutationFrame(live as never))).toThrow();
    expect(() => parseServerEvent({ ...live, windows: [{ ...windows[0], launchId: actionId }] })).toThrow();
    const stopping = run({ type: "app-under-test.stop", payload: { conversationId, launchId } } as never);
    // A sequenced launch change carries the windows of that moment.
    const updated = events.filter((event) => event.type === "app-under-test.launch.updated")
      .find((event) => (event as { launch: { state: string } }).launch.state === "stopping")!;
    expect(updated).toMatchObject({ launch: { windows } });
    expect(parseServerEvent(JSON.parse(JSON.stringify(mutationFrame(updated as RuntimeMutationEvent)))))
      .toMatchObject({ event: { launch: { windows } } });
    // A launch record that names another launch's window is refused at the boundary.
    const foreign = { ...(updated as { launch: object }).launch, windows: [{ ...windows[0], launchId: actionId }] };
    expect(() => parseServerEvent(mutationFrame({ ...updated, launch: foreign } as never))).toThrow();
    await expect(stopping).resolves.toMatchObject({ result: { launch: { state: "exited", windowCount: 0, windows: [] } } });
    await launches.dispose();
  });

  it("returns public errors for refused launches and foreign chats", async () => {
    const { run, launches } = await setup();
    await run({ type: "app-under-test.launch", payload: { conversationId, kind: "action", actionId } } as never);
    await run({ type: "app-under-test.launch", payload: { conversationId, kind: "action", actionId } } as never);
    const parsed = clientCommandSchema.parse({ type: "app-under-test.launch", requestId: crypto.randomUUID(), payload: { conversationId, kind: "electron" } });
    const handler = createAppUnderTestCommandHandler({ launches, assertConversation: () => undefined, send: vi.fn() });
    await expect(handler({} as WebSocket, parsed)).rejects.toBeInstanceOf(RuntimeRequestError);
    await expect(handler({} as WebSocket, parsed)).rejects.toThrow("already has 2 running launches");
    const foreign = clientCommandSchema.parse({ type: "app-under-test.launches.list", requestId: crypto.randomUUID(), payload: { conversationId: actionId } });
    const strict = createAppUnderTestCommandHandler({
      launches,
      assertConversation: (id) => { if (id !== conversationId) throw new RuntimeRequestError("That chat no longer exists."); },
      send: vi.fn(),
    });
    await expect(strict({} as WebSocket, foreign)).rejects.toThrow("no longer exists");
    await launches.dispose();
  });
});
