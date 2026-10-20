import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateConnectRuntimeGateway } from "../../../src/server/private-connect/runtime-gateway";
import { RuntimeStore } from "../../../src/server/database";
import { privateConnectRuntimeGrantsFromProjectIds } from "../../../src/shared/private-connect/runtime-grants";
import {
  privateConnectRuntimeSafeSubagentSchema,
  type PrivateConnectRuntimeAuthorization,
} from "../../../src/shared/private-connect/runtime-contract";

const directories: string[] = [];
const stores: RuntimeStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Private Connect supervised runtime gateway", () => {
  it("withholds a hidden watcher's runs and refuses to stop them, even on a project-wide grant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-watcher-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
    stores.push(store);
    const project = store.createProject("Allowed", directory);
    const watched = store.createConversation(project.id, "Allowed chat");
    const watcher = store.createConversation(project.id, "Watcher · Reviewer · Allowed chat");
    const stopRun = vi.fn(() => ({ stopped: true, alreadyStopped: false }));
    let visibility: "inherit" | "hidden" = "hidden";
    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => {
        const shell = store.shellSnapshot();
        return {
          ...shell,
          runs: [watched.id, watcher.id].map((conversationId, index) => ({
            id: `run-${index}`, kind: "agent", conversationId, status: "running",
          })) as unknown as typeof shell.runs,
        };
      },
      conversation: (id) => store.conversationShell(id),
      detail: (id) => store.conversationDetail(id),
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
      stopRun,
      watcherParent: (id) => id === watcher.id ? { watchedConversationId: watched.id, privateConnect: visibility } : null,
    });
    const subject: PrivateConnectRuntimeAuthorization = {
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view", "prompt"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const state = async () => {
      const response = await gateway.request(subject, { type: "state.get", requestId: "33333333-3333-4333-8333-333333333333" });
      if (!response.ok || response.result.kind !== "state") throw new Error("state unavailable");
      return response.result.state;
    };
    expect((await state()).conversations.map(({ id }) => id)).toEqual([watched.id]);
    expect((await state()).runs.map(({ conversationId }) => conversationId)).toEqual([watched.id]);
    expect(await gateway.request(subject, {
      type: "run.stop", requestId: "33333333-3333-4333-8333-333333333333", conversationId: watcher.id, runId: "run-1",
    })).toMatchObject({ ok: false, code: "not-found" });
    expect(stopRun).not.toHaveBeenCalled();
    visibility = "inherit";
    expect((await state()).conversations.map(({ id }) => id).sort()).toEqual([watched.id, watcher.id].sort());
  });

  it.each(["input.respond", "run.stop"] as const)("requires runtime mutation authority for %s", async (type) => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-scope-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
    stores.push(store);
    const project = store.createProject("Allowed", directory);
    const conversation = store.createConversation(project.id, "Allowed chat");
    const respondToInput = vi.fn(() => true);
    const stopRun = vi.fn(() => ({ stopped: true, alreadyStopped: false }));
    const detail = vi.fn((id: string) => store.conversationDetail(id));
    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => {
        const shell = store.shellSnapshot();
        return { ...shell, conversations: shell.conversations.map((item) => ({ ...item, pendingInput: true })) };
      },
      conversation: (id) => store.conversationShell(id),
      detail,
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
      respondToInput, stopRun,
    });
    const subject: PrivateConnectRuntimeAuthorization = {
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view", "prompt"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const request = {
      type, requestId: "33333333-3333-4333-8333-333333333333", conversationId: conversation.id,
      ...(type === "input.respond"
        ? { inputRequestId: "44444444-4444-4444-8444-444444444444", answers: { question: ["answer"] } }
        : { runId: "run-1" }),
    };
    expect((await gateway.request(subject, request)).ok).toBe(true);
    respondToInput.mockClear();
    stopRun.mockClear();
    expect(await gateway.request({ ...subject, scopes: ["view"] }, request))
      .toMatchObject({ ok: false, code: "forbidden" });
    expect(respondToInput).not.toHaveBeenCalled();
    expect(stopRun).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it("never projects delegated task telemetry into the strict remote detail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-telemetry-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
    stores.push(store);
    const project = store.createProject("Allowed", directory);
    const conversation = store.createConversation(project.id, "Allowed chat");
    const { turn } = store.beginAgentTurn({ id: "turn-telemetry", runId: "run-telemetry",
      conversationId: conversation.id, content: "Delegate", providerId: "codex", harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
      interactionMode: "build", accessMode: "supervised", configurationRevision: 1, association: "authoritative" });
    store.upsertSubagentTrace({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
      providerId: "codex", providerTaskId: null, providerAgentId: "agent-telemetry", parentProviderAgentId: null,
      parentProviderToolUseId: null, providerToolUseId: null, providerRole: null, providerName: "Reviewer",
      status: "running", isLive: true, description: null, progress: null, result: null, model: "private-model",
      activity: "Reading private files", usage: { totalTokens: 50, inputTokens: null, cachedInputTokens: null,
        cacheWriteInputTokens: null, outputTokens: null, reasoningOutputTokens: null, contextTokens: null,
        maxContextTokens: null }, toolUseCount: 2, durationMs: 300, sequence: 1 });
    expect(store.conversationDetail(conversation.id)!.subagents[0]).toMatchObject({
      model: "private-model", activity: "Reading private files", toolUseCount: 2, durationMs: 300,
    });
    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => store.shellSnapshot(),
      conversation: (conversationId) => store.conversationShell(conversationId),
      detail: (conversationId) => store.conversationDetail(conversationId),
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
    });
    const subject: PrivateConnectRuntimeAuthorization = {
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const response = await gateway.request(subject, {
      type: "conversation.get", requestId: "33333333-3333-4333-8333-333333333333", conversationId: conversation.id,
    });
    if (!response.ok || response.result.kind !== "conversation") throw new Error("Expected a conversation detail.");
    const [subagent] = response.result.detail.subagents;
    expect(Object.keys(subagent!).sort()).toEqual(
      ["description", "id", "name", "progress", "providerLabel", "status", "turnId", "updatedAt"],
    );
    expect(privateConnectRuntimeSafeSubagentSchema.safeParse(subagent).success).toBe(true);
    expect(privateConnectRuntimeSafeSubagentSchema.safeParse({ ...subagent, model: "private-model" }).success)
      .toBe(false);
    expect(JSON.stringify(response)).not.toMatch(/private-model|Reading private files/u);
  });

  it("labels a forwarded or automatic watcher note so it never reads as the user's own message", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-note-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
    stores.push(store);
    const project = store.createProject("Allowed", directory);
    const conversation = store.createConversation(project.id, "Allowed chat");
    store.beginAgentTurn({ id: "turn-note", runId: "run-note",
      conversationId: conversation.id, content: "The parser drops a token.", providerId: "codex", harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
      interactionMode: "build", accessMode: "supervised", configurationRevision: 1, association: "authoritative",
      watcherNote: {
        linkId: "55555555-5555-4555-8555-555555555555", wakeId: "66666666-6666-4666-8666-666666666666",
        watcherConversationId: "77777777-7777-4777-8777-777777777777", preset: "reviewer",
        watcherLabel: "codex · gpt-test", delivery: "queue",
      } });
    store.beginAgentTurn({ id: "turn-auto", runId: "run-auto",
      conversationId: conversation.id, content: "The test for empty lines is gone.", providerId: "codex", harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
      interactionMode: "build", accessMode: "supervised", configurationRevision: 1, association: "authoritative",
      watcherNote: {
        linkId: "55555555-5555-4555-8555-555555555555", wakeId: "88888888-8888-4888-8888-888888888888",
        watcherConversationId: "77777777-7777-4777-8777-777777777777", preset: "reviewer",
        watcherLabel: "codex · gpt-test", delivery: "queue", automatic: true,
      } });
    store.beginAgentTurn({ id: "turn-user", runId: "run-user",
      conversationId: conversation.id, content: "Fix it.", providerId: "codex", harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
      interactionMode: "build", accessMode: "supervised", configurationRevision: 1, association: "authoritative" });
    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => store.shellSnapshot(),
      conversation: (conversationId) => store.conversationShell(conversationId),
      detail: (conversationId) => store.conversationDetail(conversationId),
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
    });
    const subject: PrivateConnectRuntimeAuthorization = {
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const response = await gateway.request(subject, {
      type: "conversation.get", requestId: "33333333-3333-4333-8333-333333333333", conversationId: conversation.id,
    });
    if (!response.ok || response.result.kind !== "conversation") throw new Error("Expected a conversation detail.");
    expect(response.result.detail.messages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "[Forwarded watcher note]\n\nThe parser drops a token."],
      ["user", "[Watcher note sent automatically]\n\nThe test for empty lines is gone."],
      ["user", "Fix it."],
    ]);
  });

  it("leaves the missing checkpoint notice out of remote activity rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-notice-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
    stores.push(store);
    const project = store.createProject("Allowed", directory);
    const conversation = store.createConversation(project.id, "Allowed chat");
    const { turn } = store.beginAgentTurn({ id: "turn-notice", runId: "run-notice",
      conversationId: conversation.id, content: "Change the build", providerId: "codex", harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
      interactionMode: "build", accessMode: "supervised", configurationRevision: 1, association: "authoritative" });
    store.addActivity({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id, kind: "status",
      title: "No checkpoint for this turn", detail: "Checkpoint operation timed out.", status: "completed" });
    store.addActivity({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id, kind: "command",
      title: "npm test", detail: null, status: "completed" });
    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => store.shellSnapshot(),
      conversation: (conversationId) => store.conversationShell(conversationId),
      detail: (conversationId) => store.conversationDetail(conversationId),
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
    });
    const response = await gateway.request({
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }, {
      type: "conversation.get", requestId: "33333333-3333-4333-8333-333333333333", conversationId: conversation.id,
    });
    if (!response.ok || response.result.kind !== "conversation") throw new Error("Expected a conversation detail.");
    expect(response.result.detail.activities.map(({ kind }) => kind)).toEqual(["command"]);
    expect(JSON.stringify(response)).not.toContain("No checkpoint for this turn");
  });

  it("projects only granted conversations and never queues an ungranted prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-runtime-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
    stores.push(store);
    const project = store.createProject("Allowed", directory);
    const conversation = store.createConversation(project.id, "Allowed chat");
    const secretProject = store.createProject("Hidden", directory);
    const hiddenConversation = store.createConversation(secretProject.id, "Hidden chat");
    let queued = 0;
    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => store.shellSnapshot(),
      conversation: (conversationId) => store.conversationShell(conversationId),
      detail: (conversationId) => store.conversationDetail(conversationId),
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: `turn-${++queued}` }),
    });
    const subject: PrivateConnectRuntimeAuthorization = {
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view", "prompt"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const state = await gateway.request(subject, { type: "state.get", requestId: "33333333-3333-4333-8333-333333333333" });
    expect(state.ok).toBe(true);
    if (state.ok && state.result.kind === "state") expect(state.result.state.conversations.map(({ id }) => id)).toContain(conversation.id);
    const hidden = await gateway.request(subject, { type: "conversation.get", requestId: "44444444-4444-4444-8444-444444444444", conversationId: hiddenConversation.id });
    expect(hidden).toMatchObject({ ok: false, code: "not-found" });
    const prompt = await gateway.request(subject, { type: "prompt.send", requestId: "55555555-5555-4555-8555-555555555555", deliveryId: "66666666-6666-4666-8666-666666666666", conversationId: hiddenConversation.id, content: "do not send" });
    expect(prompt.ok).toBe(false);
    expect(queued).toBe(0);
  });
});
