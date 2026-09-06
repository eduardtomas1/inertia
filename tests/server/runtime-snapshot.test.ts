import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, expect, it } from "vitest";

import type { RunningRuntime } from "../../src/server";
import type { ServerEvent } from "../../src/shared/contracts";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";
import { connectRuntime as connect } from "../support/runtime-event-queue";
import { loadConversationDetail } from "../support/runtime-conversation-detail";
import { startTestRuntime as startRuntime } from "../support/test-runtime";

const roots: string[] = [];
const runtimes: RunningRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
});
function send(socket: WebSocket, command: object): void {
  socket.send(JSON.stringify(command));
}

it("starts empty, mutates, and persists a deterministic app snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-runtime-snapshot-"));
  roots.push(root);
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const runtimeIdentity = {
    runtimeGenerationId: `${randomUUID()}:1`,
    systemBootId: `test:${randomUUID()}`,
  };
  const runtime = await startRuntime({
    dataDirectory: data,
    defaultWorkspacePath: workspace,
    enableProviders: false,
    ...runtimeIdentity,
  });
  runtimes.push(runtime);
  expect(new URL(runtime.websocketUrl).hostname).toBe("127.0.0.1");
  expect(new URL(runtime.websocketUrl).pathname).toMatch(/^\/runtime\/[A-Za-z0-9_-]{40,}$/);

  const client = await connect(runtime.websocketUrl);
  const welcome = await client.events.next((event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome");
  expect(welcome.snapshot.projects).toEqual([]);
  expect(welcome.snapshot.conversations).toEqual([]);
  expect(welcome.snapshot.settings.defaultAccessMode).toBe("supervised");
  expect(welcome.snapshot).not.toHaveProperty("messages");

  // Leave a real pre-mutation snapshot queued, as startup/background refresh
  // can do. A request acknowledgment does not discard earlier broadcasts.
  const refreshRequestId = randomUUID();
  send(client.socket, { type: "app.refresh", requestId: refreshRequestId });
  await client.events.next(
    (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
      event.type === "request.ok" && event.requestId === refreshRequestId,
  );

  const settingsRequestId = randomUUID();
  send(client.socket, {
    type: "settings.update",
    requestId: settingsRequestId,
    payload: { theme: "dark", colorTheme: "iris", compactSidebar: true, terminalFontSize: 15 },
  });
  const settingsResult = await client.events.next(
    (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
      event.type === "request.ok" && event.requestId === settingsRequestId,
  );
  expect(settingsResult.requestId).toBe(settingsRequestId);
  const settingsSnapshot = await client.events.next(
    (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated"
      && event.snapshot.settings.theme === "dark"
      && event.snapshot.settings.colorTheme === "iris"
      && event.snapshot.settings.compactSidebar
      && event.snapshot.settings.terminalFontSize === 15,
  );
  expect(settingsSnapshot.snapshot.settings).toMatchObject({ theme: "dark", colorTheme: "iris", compactSidebar: true, terminalFontSize: 15 });

  const projectRequestId = randomUUID();
  send(client.socket, {
    type: "project.create",
    requestId: projectRequestId,
    payload: { name: "Inertia", path: workspace },
  });
  const projectSnapshot = await client.events.next(
    (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated"
      && event.snapshot.projects.some(({ name, path }) =>
        name === "Inertia" && path === workspace),
  );
  const projectCreated = await client.events.next(
    (event): event is Extract<ServerEvent, { type: "request.result" }> =>
      event.type === "request.result"
      && event.requestId === projectRequestId
      && event.result.kind === "project.created",
  );
  const project = projectSnapshot.snapshot.projects.find(({ name }) => name === "Inertia");
  expect(project?.path).toBe(workspace);
  expect(
    projectCreated.result.kind === "project.created"
      ? projectCreated.result.projectId
      : null,
  ).toBe(project?.id);

  const conversationRequestId = randomUUID();
  send(client.socket, {
    type: "conversation.create",
    requestId: conversationRequestId,
    payload: { projectId: project?.id, title: "Runtime work" },
  });
  await client.events.next(
    (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
      event.type === "request.ok" && event.requestId === conversationRequestId,
  );
  const conversationSnapshot = await client.events.next(
    (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated"
      && event.snapshot.conversations.some(({ title, projectId }) =>
        title === "Runtime work" && projectId === project?.id),
  );
  const conversation = conversationSnapshot.snapshot.conversations.find(({ title }) => title === "Runtime work");

  const providerRequestId = randomUUID();
  send(client.socket, {
    type: "conversation.update",
    requestId: providerRequestId,
    payload: { conversationId: conversation?.id, providerId: "claude" },
  });
  await client.events.next(
    (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
      event.type === "request.ok" && event.requestId === providerRequestId,
  );
  await client.events.next(
    (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated"
      && event.snapshot.conversations.some(({ id, providerId }) => id === conversation?.id && providerId === "claude"),
  );

  const messageRequestId = randomUUID();
  send(client.socket, {
    type: "message.send",
    requestId: messageRequestId,
    payload: { conversationId: conversation?.id, content: "Keep the runtime calm." },
  });
  await client.events.next(
    (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
      event.type === "request.ok" && event.requestId === messageRequestId,
  );
  const messageSnapshot = await client.events.next(
    (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated"
      && event.snapshot.conversations.some(({ id, providerId }) =>
        id === conversation?.id && providerId === "claude"),
  );
  const messageDetail = await loadConversationDetail(client.socket, client.events, conversation!.id);
  expect(messageDetail.messages.some(({ content }) => content === "Keep the runtime calm.")).toBe(true);
  expect(messageSnapshot.snapshot.conversations.find(({ id }) => id === conversation?.id)?.providerId).toBe("claude");

  const unsentProviderRequestId = randomUUID();
  send(client.socket, {
    type: "conversation.update",
    requestId: unsentProviderRequestId,
    payload: { conversationId: conversation?.id, providerId: "codex" },
  });
  await client.events.next(
    (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
      event.type === "request.ok" && event.requestId === unsentProviderRequestId,
  );
  const switchedProvider = await client.events.next(
    (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated"
      && event.snapshot.conversations.some(({ id, providerId }) =>
        id === conversation?.id && providerId === "codex"),
  );
  expect(switchedProvider.snapshot.conversations.find(({ id }) =>
    id === conversation?.id)?.providerId).toBe("codex");

  client.socket.close();
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);

  const restarted = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false, ...runtimeIdentity });
  runtimes.push(restarted);
  const persistedClient = await connect(restarted.websocketUrl);
  const persisted = await persistedClient.events.next(
    (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
  );
  expect(persisted.snapshot.projects).toHaveLength(1);
  expect(persisted.snapshot.settings.theme).toBe("dark");
  const persistedDetail = await loadConversationDetail(
    persistedClient.socket,
    persistedClient.events,
    persisted.snapshot.activeConversationId!,
  );
  expect(persistedDetail.messages.some(({ content }) => content === "Keep the runtime calm.")).toBe(true);
});
