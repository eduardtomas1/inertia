import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

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

  it("persists review summaries and categorized workspace runs", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.snapshot().projects[0]!;
    const conversation = store.snapshot().conversations[0]!;
    store.upsertReviewSummary({
      conversationId: conversation.id,
      fingerprint: "1234abcd",
      providerId: "codex",
      overall: "Updates the review workflow.",
      files: [{ path: "src/review.ts", summary: "Adds review context.", hunks: [{ hunkId: "hunk-test", summary: "Connects the selected lines to the composer." }] }],
      generatedAt: "2026-07-22T10:00:00.000Z",
    });
    const run = store.createWorkspaceRun({
      kind: "check",
      projectId: project.id,
      conversationId: conversation.id,
      label: "typecheck",
      detail: "npm run typecheck",
      status: "running",
      port: null,
    });
    store.updateWorkspaceRun(run.id, { status: "succeeded" });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().reviewSummaries).toEqual([expect.objectContaining({ conversationId: conversation.id, fingerprint: "1234abcd" })]);
    expect(reopened.snapshot().runs).toEqual([expect.objectContaining({ id: run.id, kind: "check", status: "succeeded", finishedAt: expect.any(String) })]);
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
      totalProcessedScope: "thread",
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 4,
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
    expect(snapshot.usage).toContainEqual(expect.objectContaining({ conversationId: conversation.id, usedTokens: 126, maxTokens: 258_400, cacheWriteInputTokens: 4, totalProcessedScope: "thread", compactsAutomatically: true }));
    reopened.close();
  });

  it("persists bounded provider metadata independently of conversation state", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    store.saveProviderMetadata({
      providerId: "codex",
      executable: "/usr/local/bin/codex",
      version: "1.2.3",
      authState: "authenticated",
      models: [{
        id: "gpt-test",
        label: "GPT Test",
        description: "Test model",
        isDefault: true,
        inputModalities: ["text", "image"],
        reasoningOptions: [],
        defaultReasoningEffort: "",
      }],
      modelsUpdatedAt: "2026-07-22T10:00:00.000Z",
      modelsLastAttemptedAt: "2026-07-22T10:00:00.000Z",
      modelsProvenance: "provider",
      modelsStale: false,
      rateLimits: [{ id: "five-hour", label: "Five hour", usedPercent: 25, remainingPercent: 75, windowMinutes: 300, resetsAt: null }],
      rateLimitsUpdatedAt: "2026-07-22T10:00:00.000Z",
      rateLimitsLastAttemptedAt: "2026-07-22T10:00:00.000Z",
      rateLimitsProvenance: "provider",
      rateLimitsStale: false,
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.loadProviderMetadata()).toEqual([expect.objectContaining({
      providerId: "codex",
      executable: "/usr/local/bin/codex",
      models: [expect.objectContaining({ id: "gpt-test" })],
      rateLimits: [expect.objectContaining({ id: "five-hour", usedPercent: 25 })],
    })]);
    reopened.close();
  });

  it("migrates an existing version-four database without rebuilding user data", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const projectId = store.snapshot().projects[0]?.id;
    store.close();
    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE provider_metadata_cache");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
    legacy.close();

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.snapshot().projects[0]?.id).toBe(projectId);
    expect(migrated.loadProviderMetadata()).toEqual([]);
    migrated.close();
  });

  it("migrates legacy usage without preserving manufactured context or compaction claims", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.snapshot().projects[0]!;
    const codex = store.createConversation(project.id, "Codex legacy", { providerId: "codex" });
    const claude = store.createConversation(project.id, "Claude legacy", { providerId: "claude" });
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP TABLE thread_usage;
      CREATE TABLE thread_usage (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        used_tokens INTEGER NOT NULL,
        total_processed_tokens INTEGER,
        max_tokens INTEGER,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        compacts_automatically INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    const insert = legacy.prepare(`INSERT INTO thread_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(codex.id, 111, 999, 200_000, 100, 10, 11, 1, 1, "2026-07-22T10:00:00.000Z");
    insert.run(claude.id, 222, 888, 200_000, 200, 20, 22, 2, 1, "2026-07-22T10:00:00.000Z");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
    legacy.close();

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.snapshot().usage).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: codex.id, usedTokens: 111, totalProcessedTokens: 999, totalProcessedScope: "thread", compactsAutomatically: null }),
      expect.objectContaining({ conversationId: claude.id, usedTokens: null, totalProcessedTokens: null, totalProcessedScope: null, compactsAutomatically: null }),
    ]));
    migrated.close();
  });
});
