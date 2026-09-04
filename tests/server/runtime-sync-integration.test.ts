import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import type { RunningRuntime } from "../../src/server";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { startTestRuntime as startRuntime } from "../support/test-runtime";

class RawEventQueue {
  private readonly events: ServerEvent[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      this.events.push(JSON.parse(data.toString()) as ServerEvent);
      for (const waiter of this.waiters) waiter();
    });
  }

  next<T extends ServerEvent>(predicate: (event: ServerEvent) => event is T): Promise<T> {
    const take = (): T | undefined => {
      const index = this.events.findIndex(predicate);
      return index < 0 ? undefined : this.events.splice(index, 1)[0] as T;
    };
    const existing = take();
    if (existing) return Promise.resolve(existing);
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out waiting for a runtime frame; pending: ${this.events.map(({ type }) => type).join(", ") || "none"}.`));
      }, 4_000);
      const check = (): void => {
        const event = take();
        if (!event) return;
        clearTimeout(timeout);
        this.waiters.delete(check);
        resolve(event);
      };
      this.waiters.add(check);
    });
  }
}

async function connect(url: string): Promise<RawEventQueue> {
  const socket = new WebSocket(url, { origin: "http://localhost:5173" });
  const queue = new RawEventQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return queue;
}

function send(socket: WebSocket, command: ClientCommand | object): void {
  socket.send(JSON.stringify(command));
}

describe("runtime incremental synchronization", () => {
  const runtimes: RunningRuntime[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function runtimeFixture(): Promise<RunningRuntime> {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-sync-"));
    directories.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const runtime = await startRuntime({
      dataDirectory: join(root, "data"),
      defaultWorkspacePath: workspace,
      enableProviders: false,
      runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
    });
    runtimes.push(runtime);
    return runtime;
  }

  it("sequences committed mutations, embeds the same cursor in snapshots, and skips failed attempts", async () => {
    const runtime = await runtimeFixture();
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    expect(welcome.sync).toEqual(welcome.snapshot.sync);
    expect(welcome.sync?.runtimeGeneration).toMatch(/^[0-9a-f-]{36}$/iu);
    await client.next(
      (event): event is Extract<ServerEvent, { type: "runtime.sync.completed" }> =>
        event.type === "runtime.sync.completed",
    );

    const firstRequestId = randomUUID();
    send(client.socket, {
      type: "settings.update",
      requestId: firstRequestId,
      payload: { theme: "dark" },
    });
    const first = await client.next(
      (event): event is Extract<ServerEvent, { type: "runtime.event" }> =>
        event.type === "runtime.event"
        && event.event.type === "snapshot.updated"
        && event.event.snapshot.settings.theme === "dark",
    );
    expect(first.scope).toEqual({ kind: "shell" });
    expect(first.event.type).toBe("snapshot.updated");
    if (first.event.type === "snapshot.updated") {
      expect(first.event.snapshot.sync).toEqual(first.sync);
      expect(first.event.snapshot.settings.theme).toBe("dark");
    }
    await client.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === firstRequestId,
    );

    const failedRequestId = randomUUID();
    send(client.socket, {
      type: "settings.update",
      requestId: failedRequestId,
      payload: { theme: "not-a-theme" },
    });
    await client.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === failedRequestId,
    );

    const secondRequestId = randomUUID();
    send(client.socket, {
      type: "settings.update",
      requestId: secondRequestId,
      payload: { theme: "light" },
    });
    const second = await client.next(
      (event): event is Extract<ServerEvent, { type: "runtime.event" }> =>
        event.type === "runtime.event" && event.sync.latestSequence > first.sync.latestSequence,
    );
    expect(second.sync.latestSequence).toBe(first.sync.latestSequence + 1);
  });

  it("acknowledges explicit mounted-pane subscription lifecycle updates", async () => {
    const runtime = await runtimeFixture();
    const client = await connect(runtime.websocketUrl);
    await client.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    await client.next(
      (event): event is Extract<
        ServerEvent,
        { type: "runtime.sync.completed" }
      > => event.type === "runtime.sync.completed",
    );
    const conversationId = randomUUID();

    for (const [owner, mountedConversationId] of [
      ["primary", conversationId],
      ["primary", null],
    ] as const) {
      const requestId = randomUUID();
      send(client.socket, {
        type: "conversation.detail.subscription",
        requestId,
        payload: {
          owner,
          conversationId: mountedConversationId,
        },
      });
      await client.next(
        (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
          event.type === "request.ok" && event.requestId === requestId,
      );
    }
  });

  it("reconnects from the last accepted cursor and resets an incompatible generation", async () => {
    const runtime = await runtimeFixture();
    const firstClient = await connect(runtime.websocketUrl);
    const welcome = await firstClient.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome" && event.sync !== undefined,
    );
    await firstClient.next(
      (event): event is Extract<ServerEvent, { type: "runtime.sync.completed" }> =>
        event.type === "runtime.sync.completed",
    );
    const cursor = welcome.sync!;
    await new Promise<void>((resolve) => {
      firstClient.socket.once("close", () => resolve());
      firstClient.socket.close();
    });

    const writer = await connect(runtime.websocketUrl);
    await writer.next(
      (event): event is Extract<ServerEvent, { type: "runtime.sync.completed" }> =>
        event.type === "runtime.sync.completed",
    );
    const unrelatedRequestId = randomUUID();
    send(writer.socket, {
      type: "settings.update",
      requestId: unrelatedRequestId,
      payload: { theme: "dark" },
    });
    await writer.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === unrelatedRequestId,
    );

    const requestId = randomUUID();
    send(writer.socket, {
      type: "settings.update",
      requestId,
      payload: { compactSidebar: true },
    });
    const published = await writer.next(
      (event): event is Extract<ServerEvent, { type: "runtime.event" }> =>
        event.type === "runtime.event"
        && event.event.type === "snapshot.updated"
        && event.event.snapshot.settings.compactSidebar === true,
    );

    const resumeUrl = new URL(runtime.websocketUrl);
    resumeUrl.searchParams.set("runtimeGeneration", cursor.runtimeGeneration);
    resumeUrl.searchParams.set("afterSequence", String(cursor.latestSequence));
    const resumed = await connect(resumeUrl.toString());
    const refreshed = await resumed.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    expect(refreshed.sync?.latestSequence).toBeGreaterThanOrEqual(
      published.sync.latestSequence,
    );
    expect(refreshed.snapshot.sync).toEqual(refreshed.sync);
    expect(refreshed.snapshot.settings.compactSidebar).toBe(true);
    const completed = await resumed.next(
      (event): event is Extract<ServerEvent, { type: "runtime.sync.completed" }> =>
        event.type === "runtime.sync.completed",
    );
    expect(completed.sync).toEqual(refreshed.sync);

    const mismatchUrl = new URL(runtime.websocketUrl);
    mismatchUrl.searchParams.set("runtimeGeneration", randomUUID());
    mismatchUrl.searchParams.set("afterSequence", String(refreshed.sync?.latestSequence));
    const reset = await connect(mismatchUrl.toString());
    const resetWelcome = await reset.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    expect(resetWelcome.sync?.runtimeGeneration).toBe(cursor.runtimeGeneration);
    expect(resetWelcome.snapshot.sync).toEqual(resetWelcome.sync);
  });
});
