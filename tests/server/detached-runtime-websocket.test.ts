import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { mintDetachedRuntimeWebSocketUrl } from "../../src/node/detached-runtime-capability";
import type { RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import type { ServerEvent } from "../../src/shared/contracts";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";
import {
  connectRuntime,
} from "../support/runtime-event-queue";
import { startTestRuntime } from "../support/test-runtime";

const runtimeIdentity = {
  runtimeGenerationId: "00000000-0000-4000-8000-000000000091:1",
  systemBootId: "test:00000000-0000-4000-8000-000000000091",
} as const;

function send(socket: WebSocket, command: object): void {
  socket.send(JSON.stringify(command));
}

async function rejectedUpgrade(url: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: "http://localhost:5173" });
    const timeout = setTimeout(
      () => reject(new Error("The replayed capability was not rejected.")),
      3_000,
    );
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.on("error", () => {
      // ws also reports the rejected handshake as an ordinary socket error.
    });
  });
}

describe("detached runtime websocket", () => {
  const roots: string[] = [];
  const runtimes: RunningRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    for (const root of roots.splice(0)) {
      await removeTemporaryDirectory(root);
    }
  });

  it("scopes admission, hydration, commands, and replay to one conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-detached-runtime-"));
    roots.push(root);
    const data = join(root, "data");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    mkdirSync(data);
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    const store = new RuntimeStore(join(data, "inertia.sqlite"), workspaceA);
    const projectA = store.createProject("Visible project", workspaceA);
    const conversationA = store.createConversation(projectA.id, "Visible chat");
    const projectB = store.createProject("Secret project", workspaceB);
    const conversationB = store.createConversation(projectB.id, "Secret chat");
    store.close();

    const runtime = await startTestRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspaceA,
      enableProviders: false,
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    const scopedUrl = mintDetachedRuntimeWebSocketUrl({
      websocketUrl: runtime.websocketUrl,
      conversationId: conversationA.id,
      clientId: "test-window:1",
    });
    expect(new URL(scopedUrl).pathname).not.toBe(
      new URL(runtime.websocketUrl).pathname,
    );

    const detached = await connectRuntime(scopedUrl);
    const welcome = await detached.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    expect(welcome.snapshot.projects.map(({ id }) => id)).toEqual([
      projectA.id,
    ]);
    expect(welcome.snapshot.conversations.map(({ id }) => id)).toEqual([
      conversationA.id,
    ]);
    expect(JSON.stringify(welcome)).not.toContain("Secret");

    const loadOwned = randomUUID();
    send(detached.socket, {
      type: "conversation.detail.load",
      requestId: loadOwned,
      payload: { conversationId: conversationA.id },
    });
    await detached.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === loadOwned
        && event.result.kind === "conversation.detail",
    );

    for (const command of [
      {
        type: "conversation.detail.load",
        requestId: randomUUID(),
        payload: { conversationId: conversationB.id },
      },
      {
        type: "conversation.select",
        requestId: randomUUID(),
        payload: { conversationId: conversationB.id },
      },
      {
        type: "message.send",
        requestId: randomUUID(),
        payload: {
          conversationId: conversationA.id,
          content: "Do not activate the main window",
          attachments: [],
          activate: true,
        },
      },
      {
        type: "settings.update",
        requestId: randomUUID(),
        payload: { theme: "dark" },
      },
    ]) {
      send(detached.socket, command);
      const rejection = await detached.events.next(
        (event): event is Extract<ServerEvent, { type: "request.error" }> =>
          event.type === "request.error"
          && event.requestId === command.requestId,
      );
      expect(rejection.message).toBe(
        "That request is unavailable in a detached chat.",
      );
    }

    expect(await rejectedUpgrade(scopedUrl)).toBe(404);

    const main = await connectRuntime(runtime.websocketUrl);
    const mainWelcome = await main.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    expect(mainWelcome.snapshot.conversations.map(({ id }) => id))
      .toEqual(expect.arrayContaining([conversationA.id, conversationB.id]));
    detached.socket.close();
    main.socket.close();
  });
});
