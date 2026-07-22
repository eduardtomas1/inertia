import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{ directory: string; databasePath: string; workspacePath: string; store: RuntimeStore }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-store-test-"));
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  return { directory, databasePath, workspacePath, store: new RuntimeStore(databasePath, workspacePath) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RuntimeStore conversation lifecycle", () => {
  it("clears a provider session when a conversation switches providers", async () => {
    const { store } = await createStore();
    const project = store.snapshot().projects[0];
    const conversation = store.createConversation(project.id, "Provider switch", { providerId: "codex" });

    store.updateConversation(conversation.id, { providerSessionId: "codex-session" });
    expect(store.updateConversation(conversation.id, { model: "gpt-test" }).providerSessionId).toBe("codex-session");
    expect(store.updateConversation(conversation.id, { providerId: "claude" }).providerSessionId).toBeNull();
    store.close();
  });

  it("recovers runs that were interrupted by an application restart", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.snapshot().projects[0];
    const conversation = store.createConversation(project.id, "Interrupted run");
    store.updateConversation(conversation.id, { status: "running" });
    store.addActivity({
      conversationId: conversation.id,
      runId: "run-before-restart",
      kind: "command",
      title: "Running a command",
      detail: null,
      status: "running",
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    const snapshot = reopened.snapshot();
    expect(snapshot.conversations.find(({ id }) => id === conversation.id)?.status).toBe("failed");
    expect(snapshot.activities.find(({ runId }) => runId === "run-before-restart")?.status).toBe("failed");
    expect(snapshot.activities.some(({ conversationId, kind, title }) =>
      conversationId === conversation.id
      && kind === "error"
      && title.includes("ended when Inertia closed"),
    )).toBe(true);
    reopened.close();
  });

  it("persists one streaming assistant message and the latest native plan across restart", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.snapshot().projects[0];
    const conversation = store.createConversation(project.id, "Streaming lifecycle");
    const assistant = store.createMessage(conversation.id, "Partial", "assistant");
    store.updateMessageContent(assistant.id, "Partial response complete");
    store.upsertAgentPlan({
      conversationId: conversation.id,
      runId: "run-plan",
      explanation: "A native plan",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "inProgress" },
      ],
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    const snapshot = reopened.snapshot();
    expect(snapshot.messages.filter(({ id }) => id === assistant.id)).toEqual([
      expect.objectContaining({ role: "assistant", content: "Partial response complete" }),
    ]);
    expect(snapshot.plans).toContainEqual({
      conversationId: conversation.id,
      runId: "run-plan",
      explanation: "A native plan",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "inProgress" },
      ],
    });
    reopened.close();
  });

  it("updates an activity lifecycle in place", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const conversation = store.snapshot().conversations[0];
    const started = store.addActivity({
      conversationId: conversation.id,
      runId: "run-activity",
      kind: "command",
      title: "Command",
      detail: null,
      status: "running",
    });

    const completed = store.updateActivity(started.id, { status: "completed" });
    expect(completed).toMatchObject({ id: started.id, runId: started.runId, status: "completed" });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().activities.filter(({ runId }) => runId === "run-activity")).toEqual([
      expect.objectContaining({ id: started.id, status: "completed" }),
    ]);
    reopened.close();
  });

  it("persists reasoning summaries, context usage, and provider-aware thread defaults", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    store.updateSettings({
      showThinking: false,
      showUsage: true,
      defaultModel: "model-a",
      defaultReasoningEffort: "high",
      defaultInteractionMode: "plan",
    });
    const project = store.snapshot().projects[0];
    const conversation = store.createConversation(project.id, "Provider metadata");
    const reasoning = store.createReasoning(conversation.id, "run-metadata");
    store.updateReasoning(reasoning.id, { content: "Checked the safe path.", status: "completed" });
    store.upsertUsage({
      conversationId: conversation.id,
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      compactsAutomatically: true,
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    const snapshot = reopened.snapshot();
    expect(snapshot.settings).toMatchObject({ showThinking: false, showUsage: true, defaultModel: "model-a", defaultReasoningEffort: "high", defaultInteractionMode: "plan" });
    expect(snapshot.conversations.find(({ id }) => id === conversation.id)).toMatchObject({ model: "model-a", reasoningEffort: "high", interactionMode: "plan" });
    expect(snapshot.reasonings).toContainEqual(expect.objectContaining({ id: reasoning.id, content: "Checked the safe path.", status: "completed" }));
    expect(snapshot.usage).toContainEqual(expect.objectContaining({ conversationId: conversation.id, usedTokens: 126, maxTokens: 258_400, compactsAutomatically: true }));
    reopened.close();
  });
});
