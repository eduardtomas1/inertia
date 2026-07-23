import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { RuntimeStore } from "../../src/server/database";

const temporaryDirectories: string[] = [];

async function createStore(options: { withProject?: boolean } = {}): Promise<{ directory: string; databasePath: string; workspacePath: string; store: RuntimeStore }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-store-test-"));
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspacePath);
  if (options.withProject !== false) {
    const project = store.createProject("Test project", workspacePath);
    store.createConversation(project.id, "Test chat");
  }
  return { directory, databasePath, workspacePath, store };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RuntimeStore conversation lifecycle", () => {
  it("keeps a new workspace empty until the user adds a project", async () => {
    const { databasePath, workspacePath, store } = await createStore({ withProject: false });
    expect(store.snapshot()).toMatchObject({
      projects: [],
      conversations: [],
      messages: [],
      activeProjectId: null,
      activeConversationId: null,
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().projects).toEqual([]);
    expect(reopened.snapshot().activeProjectId).toBeNull();
    reopened.close();
  });

  it("persists sidebar mode, canonical grouping metadata, and per-project overrides", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    store.updateSettings({
      sidebarMode: "activity",
      projectGrouping: "repository",
      codexBinaryPath: process.platform === "win32" ? "C:\\Tools\\Codex\\codex.exe" : "/opt/codex/bin/codex",
    });
    const project = store.createProject("Package", workspacePath, {
      normalizedPath: workspacePath,
      repositoryIdentity: "git:/workspace/.git",
      repositoryRoot: "/workspace",
      repositoryRelativePath: "packages/app",
    });
    store.updateProject(project.id, { groupingMode: "repository-path", name: "App package" });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings).toMatchObject({
      sidebarMode: "activity",
      projectGrouping: "repository",
      codexBinaryPath: process.platform === "win32" ? "C:\\Tools\\Codex\\codex.exe" : "/opt/codex/bin/codex",
    });
    expect(reopened.project(project.id)).toMatchObject({
      name: "App package",
      repositoryIdentity: "git:/workspace/.git",
      repositoryRoot: "/workspace",
      repositoryRelativePath: "packages/app",
      groupingMode: "repository-path",
    });
    reopened.close();
  });

  it("tracks unread background completion and supports safe settle and restore", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.snapshot().projects[0]!;
    const background = store.createConversation(project.id, "Background");
    store.createConversation(project.id, "Foreground");

    store.updateConversation(background.id, { status: "running" });
    expect(() => store.settleConversation(background.id, true)).toThrow(/cannot be settled/u);
    const completed = store.updateConversation(background.id, { status: "completed" });
    expect(completed.completedAt).toEqual(expect.any(String));
    expect(completed.completedAt! > completed.lastViewedAt!).toBe(true);

    const settled = store.settleConversation(background.id, true);
    expect(settled.settledAt).toEqual(expect.any(String));
    expect(settled.lastViewedAt).toBe(settled.settledAt);
    expect(store.settleConversation(background.id, false).settledAt).toBeNull();

    store.selectConversation(background.id);
    expect(store.conversation(background.id).lastViewedAt! >= completed.completedAt!).toBe(true);
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.conversation(background.id)).toMatchObject({
      status: "completed",
      attentionKind: null,
      settledAt: null,
      completedAt: expect.any(String),
      lastViewedAt: expect.any(String),
    });
    reopened.close();
  });

  it("preserves whether a waiting thread needs approval or user input", async () => {
    const { store } = await createStore();
    const project = store.snapshot().projects[0]!;
    const conversation = store.createConversation(project.id, "Interaction");
    expect(store.updateConversation(conversation.id, { status: "needs-input", attentionKind: "approval" })).toMatchObject({
      status: "needs-input",
      attentionKind: "approval",
    });
    expect(store.updateConversation(conversation.id, { status: "running" })).toMatchObject({
      status: "running",
      attentionKind: null,
    });
    expect(store.updateConversation(conversation.id, { status: "needs-input", attentionKind: "input" })).toMatchObject({
      status: "needs-input",
      attentionKind: "input",
    });
    store.close();
  });

  it("persists response presentation preferences across restart", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    expect(store.snapshot().settings.usageDisplayMode).toBe("compact");
    store.updateSettings({
      responseDensity: "comfortable",
      defaultCodeWrap: true,
      autoCollapseWorkLog: false,
      showChangedFileSummaries: false,
      showTimestamps: false,
      showThinking: false,
      usageDisplayMode: "expanded",
      interfaceScale: "comfortable",
      terminalFontSize: 17,
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings).toMatchObject({
      responseDensity: "comfortable",
      defaultCodeWrap: true,
      autoCollapseWorkLog: false,
      showChangedFileSummaries: false,
      showTimestamps: false,
      showThinking: false,
      usageDisplayMode: "expanded",
      interfaceScale: "comfortable",
      terminalFontSize: 17,
    });
    reopened.close();
  });

  it("adds interface scale after the Codex binary migration without changing existing preferences", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    store.updateSettings({
      codexBinaryPath: "/opt/Inertia Tools/codex",
      responseDensity: "comfortable",
      terminalFontSize: 19,
    });
    store.close();

    const beforeInterfaceScale = new Database(databasePath);
    const latestMigration = beforeInterfaceScale.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number };
    beforeInterfaceScale.exec("ALTER TABLE app_state DROP COLUMN usage_display_mode");
    beforeInterfaceScale.exec("ALTER TABLE app_state DROP COLUMN interface_scale");
    beforeInterfaceScale.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(latestMigration.version - 1);
    beforeInterfaceScale.close();

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.snapshot().settings).toMatchObject({
      interfaceScale: "default",
      codexBinaryPath: "/opt/Inertia Tools/codex",
      responseDensity: "comfortable",
      terminalFontSize: 19,
    });
    migrated.close();
  });

  it("backfills legacy disabled usage as hidden while new profiles default to compact", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    expect(store.snapshot().settings.usageDisplayMode).toBe("compact");
    store.updateSettings({ usageDisplayMode: "hidden" });
    store.close();

    const legacy = new Database(databasePath);
    const latestMigration = legacy.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number };
    expect((legacy.prepare("SELECT show_usage FROM app_state WHERE id = 1").get() as { show_usage: number }).show_usage).toBe(0);
    legacy.exec("ALTER TABLE app_state DROP COLUMN usage_display_mode");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latestMigration.version);
    legacy.close();

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.snapshot().settings.usageDisplayMode).toBe("hidden");
    migrated.updateSettings({ usageDisplayMode: "compact" });
    migrated.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings.usageDisplayMode).toBe("compact");
    reopened.close();
  });

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
    store.updateConversation(conversation.id, { status: "needs-input", attentionKind: "approval" });
    store.addActivity({
      conversationId: conversation.id,
      runId: "run-before-restart",
      kind: "command",
      title: "Running a command",
      detail: null,
      status: "running",
    });
    const workspaceRun = store.createWorkspaceRun({
      kind: "check",
      projectId: project.id,
      conversationId: conversation.id,
      actionId: "test:focused",
      label: "Focused tests",
      detail: "npm run test:focused",
      status: "waiting",
      port: null,
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
    expect(snapshot.runs.find(({ id }) => id === workspaceRun.id)).toMatchObject({
      actionId: "test:focused",
      status: "failed",
      canStop: false,
      finishedAt: expect.any(String),
      detail: expect.stringContaining("Interrupted when the local runtime stopped"),
    });
    expect(snapshot.conversations.find(({ id }) => id === conversation.id)?.attentionKind).toBeNull();
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
      actionId: "typecheck",
      label: "typecheck",
      detail: "npm run typecheck",
      status: "running",
      port: null,
    });
    store.updateWorkspaceRun(run.id, { status: "succeeded" });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().reviewSummaries).toEqual([expect.objectContaining({ conversationId: conversation.id, fingerprint: "1234abcd" })]);
    expect(reopened.snapshot().runs).toEqual([expect.objectContaining({
      id: run.id,
      kind: "check",
      actionId: "typecheck",
      status: "succeeded",
      canStop: false,
      finishedAt: expect.any(String),
    })]);
    reopened.dismissWorkspaceRun(run.id);
    expect(reopened.snapshot().runs).toEqual([]);
    reopened.close();
  });

  it("refuses to dismiss active workspace controls", async () => {
    const { store } = await createStore();
    const project = store.snapshot().projects[0]!;
    const run = store.createWorkspaceRun({
      kind: "service",
      projectId: project.id,
      conversationId: null,
      actionId: "preview",
      label: "preview",
      detail: "npm run preview",
      status: "running",
      port: 4173,
    });

    expect(() => store.dismissWorkspaceRun(run.id)).toThrow(/active/iu);
    expect(store.workspaceRun(run.id)).toMatchObject({ id: run.id, status: "running" });
    store.close();
  });

  it("persists review state and notes, then invalidates changed targets without deleting local notes", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    const reviewedFingerprint = "a".repeat(64);
    const noteFingerprint = "b".repeat(64);
    store.setReviewState({
      conversationId: conversation.id,
      scope: "hunk",
      path: "src/review.ts",
      hunkId: "hunk-one",
      targetFingerprint: reviewedFingerprint,
      reviewed: true,
    });
    const note = store.createReviewNote({
      conversationId: conversation.id,
      path: "src/review.ts",
      hunkId: "hunk-one",
      lineIds: ["hunk-one:line-2", "hunk-one:line-3"],
      targetFingerprint: noteFingerprint,
      body: "Check the cancellation path.",
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().reviewStates).toEqual([
      expect.objectContaining({ reviewed: true, stale: false, targetFingerprint: reviewedFingerprint }),
    ]);
    expect(reopened.snapshot().reviewNotes).toEqual([
      expect.objectContaining({ id: note.id, body: "Check the cancellation path.", stale: false }),
    ]);

    reopened.reconcileReviewTargets(conversation.id, {
      files: {},
      hunks: { [`src/review.ts\0hunk-one`]: "c".repeat(64) },
      notes: { [note.id]: null },
    });
    const invalidated = reopened.snapshot();
    expect(invalidated.reviewStates[0]).toMatchObject({ reviewed: false, stale: true });
    expect(invalidated.reviewNotes[0]).toMatchObject({ id: note.id, stale: true });

    reopened.updateReviewNote(conversation.id, note.id, "Keep the recovery checkpoint visible.");
    expect(reopened.snapshot().reviewNotes[0]).toMatchObject({ body: "Keep the recovery checkpoint visible.", stale: true });
    reopened.deleteReviewNote(conversation.id, note.id);
    expect(reopened.snapshot().reviewNotes).toEqual([]);
    reopened.close();
  });

  it("persists reasoning summaries, context usage, and provider-aware thread defaults", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    store.updateSettings({
      showThinking: false,
      usageDisplayMode: "compact",
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
    expect(snapshot.settings).toMatchObject({ showThinking: false, usageDisplayMode: "compact", defaultModel: "model-a", defaultReasoningEffort: "high", defaultInteractionMode: "plan" });
    expect(snapshot.conversations.find(({ id }) => id === conversation.id)).toMatchObject({ model: "model-a", reasoningEffort: "high", interactionMode: "plan" });
    expect(snapshot.reasonings).toContainEqual(expect.objectContaining({ id: reasoning.id, content: "Checked the safe path.", status: "completed" }));
    expect(snapshot.usage).toContainEqual(expect.objectContaining({ conversationId: conversation.id, usedTokens: 126, maxTokens: 258_400, cacheWriteInputTokens: 4, totalProcessedScope: "thread", compactsAutomatically: true }));
    reopened.close();
  });

  it("normalizes untrusted provider context values before writing them", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const conversation = store.createConversation(store.snapshot().projects[0]!.id, "Invalid provider context");
    const usage = store.upsertUsage({
      conversationId: conversation.id,
      usedTokens: 201,
      totalProcessedTokens: 900,
      totalProcessedScope: "provider" as never,
      maxTokens: 200,
      inputTokens: -1,
      cachedInputTokens: 1.5,
      cacheWriteInputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 30,
      reasoningOutputTokens: 4,
      compactsAutomatically: null,
    });
    expect(usage).toMatchObject({
      usedTokens: null,
      totalProcessedTokens: 900,
      totalProcessedScope: null,
      maxTokens: 200,
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: 30,
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().usage).toContainEqual(expect.objectContaining({
      conversationId: conversation.id,
      usedTokens: null,
      maxTokens: 200,
      inputTokens: null,
    }));
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
