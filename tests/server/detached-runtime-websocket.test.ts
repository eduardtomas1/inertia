import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { mintDetachedRuntimeWebSocketUrl } from "../../src/node/detached-runtime-capability";
import type { RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import type { ServerEvent } from "../../src/shared/contracts";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";
import {
  connectRuntime,
} from "../support/runtime-event-queue";
import { startTestRuntime } from "../support/test-runtime";

const runtimeIdentity = {
  runtimeGenerationId: "00000000-0000-4000-8000-000000000091:1",
  systemBootId: "test:00000000-0000-4000-8000-000000000091",
} as const;

const REJECTED = "That request is unavailable in a detached chat.";

function send(socket: WebSocket, command: object): void {
  socket.send(JSON.stringify(command));
}

type RuntimeClient = Awaited<ReturnType<typeof connectRuntime>>;
type Reply = Extract<ServerEvent, {
  type: "request.ok" | "request.result" | "request.error" | "terminal.created";
}>;

async function reply(
  client: RuntimeClient,
  command: { type: string; payload: object },
): Promise<Reply> {
  const requestId = randomUUID();
  send(client.socket, { ...command, requestId });
  return await client.events.next(
    (event): event is Reply => (
      event.type === "request.ok"
      || event.type === "request.result"
      || event.type === "request.error"
      || event.type === "terminal.created"
    ) && event.requestId === requestId,
    command.type,
  );
}

async function result<Kind extends string>(
  client: RuntimeClient,
  command: { type: string; payload: object },
  kind: Kind,
): Promise<Extract<Extract<ServerEvent, { type: "request.result" }>["result"], { kind: Kind }>> {
  const event = await reply(client, command);
  if (event.type !== "request.result" || event.result.kind !== kind) {
    throw new Error(`Expected ${kind} for ${command.type}, received ${JSON.stringify(event)}.`);
  }
  return event.result as Extract<Extract<ServerEvent, { type: "request.result" }>["result"], { kind: Kind }>;
}

async function rejected(
  client: RuntimeClient,
  command: { type: string; payload: object },
): Promise<string> {
  const event = await reply(client, command);
  if (event.type !== "request.error") {
    throw new Error(`Expected ${command.type} to fail, received ${event.type}.`);
  }
  return event.message;
}

function initializeRepository(path: string): void {
  execFileSync("git", ["init", "-b", "main", path]);
  writeFileSync(join(path, "README.md"), "Detached chat tools\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", [
    "-C", path,
    "-c", "user.name=Inertia Test",
    "-c", "user.email=inertia@example.invalid",
    "commit", "-m", "initial",
  ]);
}

function createLaunch(
  store: RuntimeStore,
  sides: readonly [{ projectId: string; conversationId: string }, { projectId: string; conversationId: string }],
): string {
  const launchId = randomUUID();
  store.createPairedLaunch(launchId, sides.map((side, ordinal) => ({
    ordinal: ordinal as 0 | 1,
    projectId: side.projectId,
    plannedConversationId: side.conversationId,
    plannedWorktreePath: null,
    plannedBranch: null,
    ownsWorktree: false,
  })) as Parameters<RuntimeStore["createPairedLaunch"]>[1]);
  return launchId;
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
        type: "message.send",
        requestId: randomUUID(),
        payload: {
          conversationId: conversationA.id,
          content: "Do not attach another conversation's context",
          attachments: [],
          activate: false,
          context: { conversationContextPacketIds: [randomUUID()] },
        },
      },
      {
        type: "conversation.context.source.load",
        requestId: randomUUID(),
        payload: {
          sourceConversationId: conversationB.id,
          targetConversationId: conversationA.id,
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

  it("serves the main window's chat tools to a detached chat for its own conversation only", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-detached-tools-"));
    roots.push(root);
    const data = join(root, "data");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    mkdirSync(data);
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    initializeRepository(workspaceA);
    const databasePath = join(data, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, workspaceA);
    const projectA = store.createProject("Visible project", workspaceA);
    const conversationA = store.createConversation(projectA.id, "Visible chat");
    const siblingA = store.createConversation(projectA.id, "Sibling chat");
    const projectB = store.createProject("Secret project", workspaceB);
    const conversationB = store.createConversation(projectB.id, "Secret chat");
    const otherB = store.createConversation(projectB.id, "Other secret chat");
    const keybindings = { search: "g", "new-chat": "h", "toggle-sidebar": "u", "toggle-terminal": "y", tasks: "t" } as const;
    store.updateSettings({
      compactOnReturn: "never",
      terminalFontSize: 17,
      keybindings,
      discordReleaseRepositoryUrl: "https://github.com/owner/secret-release",
    });
    const ownedLaunch = createLaunch(store, [
      { projectId: projectA.id, conversationId: conversationA.id },
      { projectId: projectA.id, conversationId: siblingA.id },
    ]);
    const foreignLaunch = createLaunch(store, [
      { projectId: projectB.id, conversationId: conversationB.id },
      { projectId: projectB.id, conversationId: otherB.id },
    ]);
    store.close();
    const database = new Database(databasePath);
    database.prepare("UPDATE paired_launch_sides SET conversation_id = planned_conversation_id").run();
    database.close();

    const runtime = await startTestRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspaceA,
      enableProviders: false,
      secureFiles: new SecureFileTestBroker(),
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    const main = await connectRuntime(runtime.websocketUrl);
    await main.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const detached = await connectRuntime(mintDetachedRuntimeWebSocketUrl({
      websocketUrl: runtime.websocketUrl,
      conversationId: conversationA.id,
      clientId: "test-window:tools",
    }));
    const detachedFrames: Array<{ type: string; event?: { type: string; conversationId?: string | null } }> = [];
    detached.socket.on("message", (data) => {
      detachedFrames.push(JSON.parse(data.toString()) as typeof detachedFrames[number]);
    });
    const welcome = await detached.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    expect(welcome.snapshot.settings).toMatchObject({
      compactOnReturn: "never",
      terminalFontSize: 17,
      keybindings,
      discordReleaseRepositoryUrl: "",
    });
    expect(JSON.stringify(welcome)).not.toContain("secret-release");

    const own = { projectId: projectA.id, conversationId: conversationA.id };
    const sibling = { projectId: projectA.id, conversationId: siblingA.id };
    const foreign = { projectId: projectB.id, conversationId: conversationB.id };

    expect(await result(detached, { type: "usage.limits.get", payload: { refresh: false } }, "usage.limits"))
      .toMatchObject({ kind: "usage.limits" });
    expect(await result(detached, {
      type: "conversation.background-tasks.get",
      payload: { conversationId: conversationA.id, before: null },
    }, "conversation.background-tasks")).toMatchObject({ kind: "conversation.background-tasks" });
    expect(await rejected(detached, {
      type: "conversation.background-tasks.get",
      payload: { conversationId: siblingA.id, before: null },
    })).toBe(REJECTED);

    const file = await result(detached, {
      type: "workspace.file.read",
      payload: { ...own, path: "README.md" },
    }, "workspace.file");
    expect(file.file.content).toBe("Detached chat tools\n");
    const entries = await result(detached, { type: "workspace.entries", payload: own }, "workspace.entries");
    expect(entries.entries.map(({ path }) => path)).toContain("README.md");
    for (const scope of [sibling, foreign]) {
      expect(await rejected(detached, { type: "workspace.file.read", payload: { ...scope, path: "README.md" } })).toBe(REJECTED);
    }

    const status = await result(detached, { type: "git.refresh", payload: own }, "git.status");
    expect(status.status).toMatchObject({ isRepository: true, branch: "main" });
    expect(await rejected(detached, { type: "git.refresh", payload: foreign })).toBe(REJECTED);
    expect(await rejected(detached, { type: "git.refresh", payload: { projectId: projectA.id } })).toBe(REJECTED);
    const siblingStatus = await result(main, { type: "git.refresh", payload: sibling }, "git.status");
    await result(main, {
      type: "git.branch.create",
      payload: { ...sibling, repositoryPath: ".", authorityRef: siblingStatus.status.authorityRef, name: "sibling-branch" },
    }, "git.action");
    await result(detached, {
      type: "git.branch.create",
      payload: { ...own, repositoryPath: ".", authorityRef: status.status.authorityRef, name: "detached-branch" },
    }, "git.action");
    await detached.events.next(
      (event): event is Extract<ServerEvent, { type: "workspace.git.invalidated" }> =>
        event.type === "workspace.git.invalidated"
        && event.projectId === projectA.id
        && event.conversationId === conversationA.id,
      "own Git invalidation",
    );
    expect(detachedFrames
      .filter(({ type, event }) => type === "runtime.event" && event?.type === "workspace.git.invalidated")
      .map(({ event }) => event?.conversationId)).toEqual([conversationA.id]);

    expect(await reply(detached, {
      type: "conversation.update",
      payload: { conversationId: conversationA.id, title: "Renamed in its window" },
    })).toMatchObject({ type: "request.ok" });
    await detached.events.next(
      (event): event is ServerEvent => (
        event.type === "snapshot.updated"
        && event.snapshot.conversations.some(({ title }) => title === "Renamed in its window")
      ) || (
        event.type === "conversation.shell.updated"
        && event.conversation.title === "Renamed in its window"
      ),
      "renamed conversation",
    );
    expect(await rejected(detached, {
      type: "conversation.update",
      payload: { conversationId: siblingA.id, title: "Not mine" },
    })).toBe(REJECTED);

    expect(await reply(detached, {
      type: "prompt-preset.create",
      payload: { name: "Detached review", body: "Review this window's change.", route: null },
    })).toMatchObject({ type: "request.ok" });
    await detached.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && Boolean(event.snapshot.promptPresets?.some(({ name }) => name === "Detached review")),
      "projected prompt preset",
    );

    expect(await result(detached, { type: "duo.pending", payload: { projectIds: [projectA.id] } }, "duo.pending"))
      .toMatchObject({ kind: "duo.pending", hasMore: false });
    const duoStatus = await result(detached, { type: "duo.status", payload: { launchId: ownedLaunch } }, "duo.status");
    expect(duoStatus.sides.map(({ conversationId }) => conversationId)).toEqual([conversationA.id, siblingA.id]);
    expect(await rejected(detached, { type: "duo.status", payload: { launchId: foreignLaunch } })).toBe(REJECTED);
    expect(await rejected(detached, { type: "duo.pending", payload: { projectIds: [projectB.id] } })).toBe(REJECTED);

    const terminal = await reply(detached, { type: "terminal.create", payload: { ...own, cols: 80, rows: 24 } });
    if (terminal.type !== "terminal.created") throw new Error(`Expected a terminal, received ${terminal.type}.`);
    expect(await reply(detached, {
      type: "terminal.input",
      payload: { terminalId: terminal.terminalId, data: "" },
    })).toMatchObject({ type: "request.ok" });
    expect(await rejected(detached, { type: "terminal.create", payload: { ...sibling, cols: 80, rows: 24 } })).toBe(REJECTED);
    const mainTerminal = await reply(main, { type: "terminal.create", payload: { ...sibling, cols: 80, rows: 24 } });
    if (mainTerminal.type !== "terminal.created") throw new Error(`Expected a terminal, received ${mainTerminal.type}.`);
    expect(await rejected(detached, {
      type: "terminal.attach",
      payload: { ...sibling, terminalId: mainTerminal.terminalId, cols: 80, rows: 24 },
    })).toBe(REJECTED);
    expect(await rejected(detached, {
      type: "terminal.attach",
      payload: { ...own, terminalId: mainTerminal.terminalId, cols: 80, rows: 24 },
    })).toBe("Terminal not found.");
    for (const command of [
      { type: "terminal.input", payload: { terminalId: mainTerminal.terminalId, data: "exit\r" } },
      { type: "terminal.close", payload: { terminalId: mainTerminal.terminalId } },
    ]) {
      expect(await rejected(detached, command)).toBe("Terminal not found.");
    }
    expect(await reply(main, {
      type: "terminal.input",
      payload: { terminalId: mainTerminal.terminalId, data: "" },
    })).toMatchObject({ type: "request.ok" });
    expect(await reply(detached, {
      type: "terminal.close",
      payload: { terminalId: terminal.terminalId },
    })).toMatchObject({ type: "request.ok" });
    await detached.events.next(
      (event): event is Extract<ServerEvent, { type: "terminal.exit" }> =>
        event.type === "terminal.exit" && event.terminalId === terminal.terminalId,
      "detached terminal exit",
    );
    expect(await rejected(main, {
      type: "terminal.input",
      payload: { terminalId: terminal.terminalId, data: "" },
    })).toBe("Terminal not found.");
    expect(await reply(main, {
      type: "terminal.close",
      payload: { terminalId: mainTerminal.terminalId },
    })).toMatchObject({ type: "request.ok" });
    detached.socket.close();
    main.socket.close();
  });
});
