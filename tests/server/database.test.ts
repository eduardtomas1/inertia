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

  it("keeps navigation shells bounded and loads heavy records for only one conversation", async () => {
    const { store } = await createStore();
    const first = store.snapshot().conversations[0]!;
    const second = store.createConversation(first.projectId, "Second chat");
    const shellSizeBefore = JSON.stringify(store.shellSnapshot()).length;
    const messageCount = 100;
    const payload = "x".repeat(4_096);

    for (let index = 0; index < messageCount; index += 1) {
      store.createMessage(first.id, `first:${index}:${payload}`);
      store.createMessage(second.id, `second:${index}:${payload}`);
    }

    const shell = store.shellSnapshot();
    const shellSizeAfter = JSON.stringify(shell).length;
    expect(shellSizeAfter).toBe(shellSizeBefore);
    expect(shell).not.toHaveProperty("messages");
    expect(shell.conversations).toHaveLength(2);
    expect(shell.conversations.every(({ latestTurn }) => latestTurn === null)).toBe(true);

    const firstDetail = store.conversationDetail(first.id);
    expect(firstDetail?.conversation.id).toBe(first.id);
    expect(firstDetail?.messages).toHaveLength(messageCount);
    expect(firstDetail?.messages.every(({ conversationId }) => conversationId === first.id)).toBe(true);
    expect(firstDetail?.messages.some(({ content }) => content.startsWith("second:"))).toBe(false);
    expect(JSON.stringify(firstDetail).length).toBeGreaterThan(shellSizeAfter * 100);
    expect(store.conversationDetail("missing-conversation")).toBeNull();
    store.close();
  });

  it("persists authoritative turns with an immutable execution configuration and boundary usage", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    const userMessage = store.createMessage(conversation.id, "Implement the durable turn model.");
    const requestedAt = userMessage.createdAt;
    const at = (offsetMs: number): string =>
      new Date(Date.parse(requestedAt) + offsetMs).toISOString();
    const usageAtStart = {
      usedTokens: 120,
      totalProcessedTokens: 1_000,
      totalProcessedScope: "thread" as const,
      maxTokens: 200_000,
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      compactsAutomatically: true,
      capturedAt: requestedAt,
    };
    const turn = store.createAgentTurn({
      id: "turn-authoritative-1",
      conversationId: conversation.id,
      runId: "run-authoritative-1",
      userMessageId: userMessage.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex-local",
      model: "gpt-5.6",
      modelAlias: "latest",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: "session-before",
      requestedAt,
      usageAtStart,
      configurationRevision: 7,
      association: "authoritative",
    });
    expect(turn).toMatchObject({
      status: "queued",
      startedAt: null,
      completedAt: null,
      terminalAssistantMessageId: null,
      providerSessionBefore: "session-before",
      providerSessionAfter: null,
      usageAtStart,
      usageAtCompletion: null,
      association: "authoritative",
    });

    store.updateAgentTurnLifecycle(turn.id, { status: "starting", updatedAt: at(1_000) });
    store.updateAgentTurnLifecycle(turn.id, { status: "running", updatedAt: at(2_000) });
    store.updateAgentTurnLifecycle(turn.id, { status: "waiting-for-approval", updatedAt: at(3_000) });
    store.updateAgentTurnLifecycle(turn.id, { status: "running", updatedAt: at(4_000) });
    store.updateAgentTurnLifecycle(turn.id, { status: "waiting-for-input", updatedAt: at(5_000) });
    const assistantMessage = store.createMessage(conversation.id, "The durable turn model is ready.", "assistant");
    const usageAtCompletion = {
      ...usageAtStart,
      usedTokens: 180,
      totalProcessedTokens: 1_450,
      inputTokens: 350,
      outputTokens: 80,
      reasoningOutputTokens: 20,
      capturedAt: at(6_000),
    };
    const completed = store.updateAgentTurnLifecycle(turn.id, {
      status: "completed",
      terminalAssistantMessageId: assistantMessage.id,
      providerSessionAfter: "session-after",
      terminalReason: "provider-completed",
      checkpointId: "checkpoint-1",
      usageAtCompletion,
      completedAt: at(6_000),
      updatedAt: at(6_000),
    });
    expect(completed).toMatchObject({
      status: "completed",
      requestedAt,
      startedAt: at(1_000),
      completedAt: at(6_000),
      terminalAssistantMessageId: assistantMessage.id,
      providerSessionAfter: "session-after",
      checkpointId: "checkpoint-1",
      usageAtCompletion,
    });
    expect(store.shellSnapshot().conversations.find(({ id }) => id === conversation.id)?.latestTurn)
      .toEqual(expect.objectContaining({
        id: turn.id,
        runId: turn.runId,
        status: "completed",
        model: "gpt-5.6",
        reasoningEffort: "high",
      }));
    expect(store.shellSnapshot().conversations[0]?.latestTurn)
      .not.toHaveProperty("terminalAssistantMessageId");

    store.updateConversation(conversation.id, {
      model: "a-later-conversation-default",
      reasoningEffort: "low",
      interactionMode: "plan",
      accessMode: "full",
    });
    expect(store.agentTurn(turn.id)).toMatchObject({
      model: "gpt-5.6",
      modelAlias: "latest",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 7,
      requestedAt,
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.agentTurnForRun("run-authoritative-1")).toEqual(
      expect.objectContaining({ id: turn.id, conversationId: conversation.id }),
    );
    expect(reopened.agentTurnForRun("missing-run")).toBeNull();
    expect(reopened.agentTurnsForConversation(conversation.id)).toEqual([
      expect.objectContaining({
        id: turn.id,
        runId: "run-authoritative-1",
        userMessageId: userMessage.id,
        terminalAssistantMessageId: assistantMessage.id,
        status: "completed",
        requestedAt,
        startedAt: at(1_000),
        completedAt: at(6_000),
        harnessId: "codex-app-server",
        backendProfileId: "codex-local",
        providerSessionBefore: "session-before",
        providerSessionAfter: "session-after",
        association: "authoritative",
        usageAtStart,
        usageAtCompletion,
      }),
    ]);
    expect(reopened.snapshot().agentTurns).toEqual([
      expect.objectContaining({ id: turn.id, status: "completed" }),
    ]);
    reopened.close();
  });

  it("guards turn lifecycle order, write-once boundaries, and terminal metadata", async () => {
    const { store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    const userMessage = store.createMessage(conversation.id, "Exercise lifecycle guards.");
    const requestedAt = userMessage.createdAt;
    const at = (offsetMs: number): string =>
      new Date(Date.parse(requestedAt) + offsetMs).toISOString();
    const turn = store.createAgentTurn({
      conversationId: conversation.id,
      runId: "run-lifecycle-guards",
      userMessageId: userMessage.id,
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfileId: "claude-local",
      model: "claude-opus",
      reasoningEffort: "",
      interactionMode: "plan",
      accessMode: "auto-edit",
      requestedAt,
      configurationRevision: 0,
      association: "inferred",
    });

    expect(() => store.updateAgentTurnLifecycle(turn.id, {
      status: "running",
      terminalReason: "too early",
      updatedAt: at(1_000),
    })).toThrow(/terminal turn metadata/iu);
    expect(() => store.updateAgentTurnLifecycle(turn.id, {
      status: "starting",
      startedAt: at(-1_000),
      updatedAt: at(1_000),
    })).toThrow(/precede its request/iu);

    store.updateAgentTurnLifecycle(turn.id, {
      status: "starting",
      startedAt: at(1_000),
      updatedAt: at(1_000),
    });
    expect(() => store.updateAgentTurnLifecycle(turn.id, {
      status: "queued",
      updatedAt: at(2_000),
    })).toThrow(/cannot transition/iu);
    const failed = store.updateAgentTurnLifecycle(turn.id, {
      status: "failed",
      terminalReason: "provider-exit",
      completedAt: at(3_000),
      updatedAt: at(3_000),
    });
    expect(failed).toMatchObject({
      status: "failed",
      startedAt: at(1_000),
      completedAt: at(3_000),
      terminalReason: "provider-exit",
    });
    expect(() => store.updateAgentTurnLifecycle(turn.id, {
      status: "running",
      updatedAt: at(4_000),
    })).toThrow(/cannot transition/iu);
    expect(() => store.updateAgentTurnLifecycle(turn.id, {
      status: "failed",
      terminalReason: "different-reason",
      updatedAt: at(4_000),
    })).toThrow(/write-once/iu);
    expect(() => store.createAgentTurn({
      conversationId: conversation.id,
      runId: "run-invalid-revision",
      userMessageId: userMessage.id,
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfileId: "claude-local",
      model: "claude-opus",
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "full",
      configurationRevision: -1,
      association: "authoritative",
    })).toThrow(/configuration revision/iu);
    store.close();
  });

  it("associates every persisted turn-owned record and permits multiple assistant messages in one turn", async () => {
    const { store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    const userMessage = store.createMessage(conversation.id, "Inspect, implement, and verify.");
    const turn = store.createAgentTurn({
      id: "turn-owned-records",
      conversationId: conversation.id,
      runId: "run-owned-records",
      userMessageId: userMessage.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "legacy:codex:codex-app-server",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    const assistantOne = store.createMessage(conversation.id, "First segment.", "assistant", [], turn.id);
    const assistantTwo = store.createMessage(conversation.id, "Second segment.", "assistant", [], turn.id);
    const activity = store.addActivity({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      kind: "command",
      title: "Run focused tests",
      detail: null,
      status: "completed",
    });
    const reasoning = store.createReasoning(conversation.id, turn.runId, turn.id);
    store.upsertAgentPlan({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      explanation: "Keep each record on the emitter turn.",
      steps: [{ step: "Verify ownership", status: "completed" }],
    });
    const usage = store.upsertUsage({
      conversationId: conversation.id,
      turnId: turn.id,
      usedTokens: 40,
      totalProcessedTokens: 60,
      totalProcessedScope: "run",
      maxTokens: 1_000,
      inputTokens: 30,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 2,
      compactsAutomatically: false,
    });
    const checkpoint = store.addCheckpoint({
      conversationId: conversation.id,
      turnId: turn.id,
      ref: "refs/inertia/checkpoints/owned",
      label: "Before owned turn",
      turnIndex: 99,
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
    });

    const snapshot = store.snapshot();
    expect(snapshot.messages.filter(({ id }) => [userMessage.id, assistantOne.id, assistantTwo.id].includes(id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: userMessage.id, turnId: turn.id }),
        expect.objectContaining({ id: assistantOne.id, turnId: turn.id }),
        expect.objectContaining({ id: assistantTwo.id, turnId: turn.id }),
      ]));
    expect(snapshot.activities).toContainEqual(expect.objectContaining({ id: activity.id, turnId: turn.id }));
    expect(snapshot.reasonings).toContainEqual(expect.objectContaining({ id: reasoning.id, turnId: turn.id }));
    expect(snapshot.plans).toContainEqual(expect.objectContaining({ runId: turn.runId, turnId: turn.id }));
    expect(usage.turnId).toBe(turn.id);
    expect(checkpoint.turnId).toBe(turn.id);

    const other = store.createConversation(conversation.projectId, "Other conversation");
    expect(() => store.addActivity({
      conversationId: other.id,
      runId: turn.runId,
      turnId: turn.id,
      kind: "error",
      title: "Wrong conversation",
      detail: null,
      status: "failed",
    })).toThrow(/identities do not match/iu);
    store.close();
  });

  it("keeps the latest native plan for each authoritative turn", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    const firstUser = store.createMessage(conversation.id, "Plan the first change.");
    const firstTurn = store.createAgentTurn({
      id: "turn-plan-first",
      conversationId: conversation.id,
      runId: "run-plan-first",
      userMessageId: firstUser.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex-local",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "plan",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    store.upsertAgentPlan({
      conversationId: conversation.id,
      runId: firstTurn.runId,
      turnId: firstTurn.id,
      explanation: "Initial first-turn plan.",
      steps: [{ step: "Inspect", status: "inProgress" }],
    });
    store.upsertAgentPlan({
      conversationId: conversation.id,
      runId: firstTurn.runId,
      turnId: firstTurn.id,
      explanation: "Updated first-turn plan.",
      steps: [{ step: "Inspect", status: "completed" }],
    });

    const secondUser = store.createMessage(conversation.id, "Plan the second change.");
    const secondTurn = store.createAgentTurn({
      id: "turn-plan-second",
      conversationId: conversation.id,
      runId: "run-plan-second",
      userMessageId: secondUser.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex-local",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "plan",
      accessMode: "supervised",
      configurationRevision: 1,
      association: "authoritative",
    });
    store.upsertAgentPlan({
      conversationId: conversation.id,
      runId: secondTurn.runId,
      turnId: secondTurn.id,
      explanation: "Second-turn plan.",
      steps: [{ step: "Verify", status: "pending" }],
    });

    const otherConversation = store.createConversation(conversation.projectId, "Other plans");
    expect(() => store.upsertAgentPlan({
      conversationId: conversation.id,
      runId: secondTurn.runId,
      turnId: firstTurn.id,
      explanation: null,
      steps: [],
    })).toThrow(/identities do not match/iu);
    expect(() => store.upsertAgentPlan({
      conversationId: otherConversation.id,
      runId: firstTurn.runId,
      turnId: firstTurn.id,
      explanation: null,
      steps: [],
    })).toThrow(/identities do not match/iu);
    expect(() => store.upsertAgentPlan({
      conversationId: conversation.id,
      runId: "missing-plan-run",
      turnId: "missing-plan-turn",
      explanation: null,
      steps: [],
    })).toThrow(/turn not found/iu);

    expect(store.snapshot().plans.filter(({ conversationId }) =>
      conversationId === conversation.id,
    )).toEqual([
      {
        conversationId: conversation.id,
        runId: firstTurn.runId,
        turnId: firstTurn.id,
        explanation: "Updated first-turn plan.",
        steps: [{ step: "Inspect", status: "completed" }],
      },
      {
        conversationId: conversation.id,
        runId: secondTurn.runId,
        turnId: secondTurn.id,
        explanation: "Second-turn plan.",
        steps: [{ step: "Verify", status: "pending" }],
      },
    ]);
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().plans.filter(({ conversationId }) =>
      conversationId === conversation.id,
    )).toEqual([
      expect.objectContaining({
        runId: firstTurn.runId,
        turnId: firstTurn.id,
        explanation: "Updated first-turn plan.",
      }),
      expect.objectContaining({
        runId: secondTurn.runId,
        turnId: secondTurn.id,
        explanation: "Second-turn plan.",
      }),
    ]);
    reopened.close();
  });

  it("recovers only the explicitly interrupted turn instead of rewriting older turn records", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    const oldUser = store.createMessage(conversation.id, "Older work");
    const oldTurn = store.createAgentTurn({
      id: "turn-before-interruption",
      conversationId: conversation.id,
      runId: "run-before-interruption",
      userMessageId: oldUser.id,
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfileId: "legacy:claude:claude-agent-sdk",
      model: "claude-test",
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "auto-edit",
      configurationRevision: 0,
      association: "authoritative",
    });
    const oldActivity = store.addActivity({
      conversationId: conversation.id,
      runId: oldTurn.runId,
      turnId: oldTurn.id,
      kind: "command",
      title: "Historical activity",
      detail: null,
      status: "running",
    });
    store.updateAgentTurnLifecycle(oldTurn.id, {
      status: "completed",
      updatedAt: new Date(Date.parse(oldTurn.requestedAt) + 1_000).toISOString(),
    });

    const currentUser = store.createMessage(conversation.id, "Current work");
    const currentTurn = store.createAgentTurn({
      id: "turn-interrupted",
      conversationId: conversation.id,
      runId: "run-interrupted",
      userMessageId: currentUser.id,
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfileId: "legacy:claude:claude-agent-sdk",
      model: "claude-test",
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "auto-edit",
      configurationRevision: 0,
      association: "authoritative",
    });
    const currentActivity = store.addActivity({
      conversationId: conversation.id,
      runId: currentTurn.runId,
      turnId: currentTurn.id,
      kind: "command",
      title: "Interrupted activity",
      detail: null,
      status: "running",
    });
    const currentReasoning = store.createReasoning(conversation.id, currentTurn.runId, currentTurn.id);
    store.updateConversation(conversation.id, { status: "running" });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    const snapshot = reopened.snapshot();
    expect(snapshot.agentTurns.find(({ id }) => id === oldTurn.id)?.status).toBe("completed");
    expect(snapshot.activities.find(({ id }) => id === oldActivity.id)?.status).toBe("running");
    expect(snapshot.agentTurns.find(({ id }) => id === currentTurn.id)).toMatchObject({
      status: "interrupted",
      terminalReason: "runtime-restart",
    });
    expect(snapshot.activities.find(({ id }) => id === currentActivity.id)?.status).toBe("failed");
    expect(snapshot.reasonings.find(({ id }) => id === currentReasoning.id)?.status).toBe("failed");
    expect(snapshot.activities).toContainEqual(expect.objectContaining({
      runId: currentTurn.runId,
      turnId: currentTurn.id,
      kind: "error",
    }));
    reopened.close();
  });

  it("adds the empty turn ledger to an existing V0.0.6 database without rebuilding conversations", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const conversationId = store.snapshot().conversations[0]!.id;
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE agent_turns");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 16").run();
    legacy.close();

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.conversation(conversationId).id).toBe(conversationId);
    expect(migrated.snapshot().agentTurns).toEqual([]);
    const inspection = new Database(databasePath, { readonly: true });
    const columns = inspection.prepare("PRAGMA table_info(agent_turns)").all() as Array<{ name: string }>;
    inspection.close();
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "id",
      "conversation_id",
      "run_id",
      "user_message_id",
      "terminal_assistant_message_id",
      "harness_id",
      "backend_profile_id",
      "model",
      "model_alias",
      "reasoning_effort",
      "interaction_mode",
      "access_mode",
      "provider_session_before",
      "provider_session_after",
      "requested_at",
      "started_at",
      "completed_at",
      "status",
      "terminal_reason",
      "checkpoint_id",
      "usage_start_json",
      "usage_completion_json",
      "configuration_revision",
      "association",
      "created_at",
      "updated_at",
    ]));
    migrated.close();
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
    expect(project.gitRepositoryLimit).toBe(128);
    store.updateProject(project.id, {
      groupingMode: "repository-path",
      gitRepositoryLimit: 256,
      name: "App package",
    });
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
      gitRepositoryLimit: 256,
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
      workspaceStartupSurface: "tools",
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
      workspaceStartupSurface: "tools",
      terminalFontSize: 17,
    });
    reopened.close();
  });

  it("adds the compact summary startup without changing existing preferences", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    store.updateSettings({
      responseDensity: "comfortable",
      terminalFontSize: 18,
    });
    store.close();

    const previous = new Database(databasePath);
    previous.exec("ALTER TABLE app_state DROP COLUMN workspace_startup_surface");
    previous.prepare("DELETE FROM schema_migrations WHERE version = 31").run();
    previous.close();

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.snapshot().settings).toMatchObject({
      workspaceStartupSurface: "summary",
      responseDensity: "comfortable",
      terminalFontSize: 18,
    });
    migrated.close();
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
    beforeInterfaceScale.exec("ALTER TABLE app_state DROP COLUMN usage_display_mode");
    beforeInterfaceScale.exec("ALTER TABLE app_state DROP COLUMN interface_scale");
    beforeInterfaceScale.prepare("DELETE FROM schema_migrations WHERE version >= 14").run();
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
    expect((legacy.prepare("SELECT show_usage FROM app_state WHERE id = 1").get() as { show_usage: number }).show_usage).toBe(0);
    legacy.exec("ALTER TABLE app_state DROP COLUMN usage_display_mode");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 15").run();
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

  it("persists only provider-supported model flexibility in continuation identities", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.snapshot().projects[0];
    const codex = store.createConversation(project.id, "Flexible model", {
      providerId: "codex",
      model: "gpt-test",
    });
    const cursor = store.createConversation(project.id, "Fixed model", {
      providerId: "cursor",
      model: "cursor-test",
    });

    expect(store.updateConversation(codex.id, {
      providerSessionId: "codex-session",
    }).continuationIdentity?.modelIdentity).toBeNull();
    expect(store.updateConversation(cursor.id, {
      providerSessionId: "cursor-session",
    }).continuationIdentity?.modelIdentity).toBe("cursor-test");
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.conversation(codex.id).continuationIdentity?.modelIdentity)
      .toBeNull();
    expect(reopened.conversation(cursor.id).continuationIdentity?.modelIdentity)
      .toBe("cursor-test");
    reopened.close();
  });

  it("fails closed instead of guessing a malformed persisted continuation identity", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    store.updateConversation(conversation.id, {
      providerSessionId: "bound-provider-session",
    });
    store.close();

    const database = new Database(databasePath);
    database.prepare(`
      UPDATE conversations
      SET continuation_identity_json = ?
      WHERE id = ?
    `).run("{not-valid-json", conversation.id);
    database.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.conversation(conversation.id)).toMatchObject({
      providerSessionId: "bound-provider-session",
      continuationIdentity: null,
    });
    reopened.close();
  });

  it("starts every newly created conversation without provider or per-turn identity", async () => {
    const { store, workspacePath } = await createStore();
    const project = store.snapshot().projects[0];
    const viewed = store.createConversation(project.id, "Viewed context", {
      providerId: "claude",
      model: "viewed-model",
      reasoningEffort: "viewed-effort",
      interactionMode: "plan",
      accessMode: "full",
      branch: "viewed/branch",
      worktreePath: workspacePath,
    });
    store.updateConversation(viewed.id, {
      providerSessionId: "viewed-provider-session",
      status: "completed",
      attentionKind: null,
    });
    store.createMessage(viewed.id, "Viewed turn");

    const created = store.createConversation(project.id, "Isolated");

    expect(created).toMatchObject({
      providerId: store.snapshot().settings.defaultProvider,
      model: store.snapshot().settings.defaultModel,
      reasoningEffort: store.snapshot().settings.defaultReasoningEffort,
      interactionMode: store.snapshot().settings.defaultInteractionMode,
      accessMode: store.snapshot().settings.defaultAccessMode,
      branch: null,
      worktreePath: null,
      providerSessionId: null,
      status: "idle",
      attentionKind: null,
    });
    expect(store.hasConversationMessages(created.id)).toBe(false);
    expect(store.snapshot().agentTurns.filter(({ conversationId }) => conversationId === created.id)).toEqual([]);
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
      attentionState: "unseen",
      canStop: false,
      finishedAt: expect.any(String),
      detail: expect.stringContaining("Interrupted when the local runtime stopped"),
    });
    expect(snapshot.conversations.find(({ id }) => id === conversation.id)?.attentionKind).toBeNull();
    reopened.close();
  });

  it("rolls back every recovery projection when recovery cannot finish", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.snapshot().projects[0]!;
    const conversation = store.createConversation(
      project.id,
      "Interrupted atomic recovery",
    );
    store.updateConversation(conversation.id, {
      status: "needs-input",
      attentionKind: "approval",
    });
    const userMessage = store.createMessage(
      conversation.id,
      "Recover every authoritative projection atomically.",
    );
    const turn = store.createAgentTurn({
      id: "turn-atomic-recovery",
      conversationId: conversation.id,
      runId: "run-atomic-recovery",
      userMessageId: userMessage.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "legacy:codex:codex-app-server",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    store.updateAgentTurnLifecycle(turn.id, {
      status: "running",
      startedAt: turn.requestedAt,
      updatedAt: turn.requestedAt,
    });
    const activity = store.addActivity({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      kind: "command",
      title: "Interrupted command",
      detail: null,
      status: "running",
    });
    const reasoning = store.createReasoning(
      conversation.id,
      turn.runId,
      turn.id,
    );
    const subagent = store.upsertSubagentTrace({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      providerId: "codex",
      providerTaskId: "task-atomic-recovery",
      providerAgentId: "agent-atomic-recovery",
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: "tool-atomic-recovery",
      providerRole: "reviewer",
      providerName: "Atomic Recovery Reviewer",
      status: "running",
      description: "Verify recovery transaction boundaries.",
      progress: "Waiting for recovery.",
      result: null,
      sequence: 4,
      updatedAt: turn.requestedAt,
    })?.trace;
    expect(subagent).toBeDefined();
    const workspaceRun = store.createWorkspaceRun({
      kind: "agent",
      projectId: project.id,
      conversationId: conversation.id,
      id: turn.runId,
      actionId: null,
      label: "Interrupted agent",
      detail: null,
      status: "waiting",
      port: null,
    });
    store.close();

    const database = new Database(databasePath);
    database.exec(`
      CREATE TRIGGER reject_recovery_activity
      BEFORE INSERT ON activities
      WHEN NEW.kind = 'error'
      BEGIN
        SELECT RAISE(ABORT, 'injected recovery failure');
      END
    `);
    database.close();

    const reopened = new RuntimeStore(
      databasePath,
      workspacePath,
      { recoverInterruptedRuns: false },
    );
    expect(() => reopened.recoverInterruptedRuns())
      .toThrow(/injected recovery failure/iu);
    expect(reopened.conversation(conversation.id)).toMatchObject({
      status: "needs-input",
      attentionKind: "approval",
    });
    expect(reopened.workspaceRun(workspaceRun.id)).toMatchObject({
      status: "waiting",
      finishedAt: null,
    });
    expect(reopened.agentTurn(turn.id)).toMatchObject({
      status: "running",
      completedAt: null,
      terminalReason: null,
    });
    expect(reopened.subagentTrace(subagent!.id)).toMatchObject({
      status: "running",
      sequence: 4,
    });
    expect(reopened.snapshot().activities).toContainEqual(
      expect.objectContaining({
        id: activity.id,
        status: "running",
      }),
    );
    expect(reopened.snapshot().reasonings).toContainEqual(
      expect.objectContaining({
        id: reasoning.id,
        status: "running",
      }),
    );
    reopened.close();
  });

  it("preserves a nullable legacy plan across restart", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.snapshot().projects[0];
    const conversation = store.createConversation(project.id, "Streaming lifecycle");
    const assistant = store.createMessage(conversation.id, "Partial", "assistant");
    store.updateMessageContent(assistant.id, "Partial response complete");
    store.upsertAgentPlan({
      conversationId: conversation.id,
      runId: "run-plan",
      turnId: null,
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
      turnId: null,
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
    const summary = {
      conversationId: conversation.id,
      fingerprint: "1".repeat(64),
      providerId: "codex" as const,
      harnessId: "codex-app-server",
      backendProfileId: "legacy:codex:codex-app-server",
      model: "gpt-5.6-codex",
      overall: "Updates the review workflow exactly.",
      classifications: [{
        classification: "behavior-change" as const,
        evidence: "The review workflow now retains complete summaries.",
      }],
      files: [{
        path: "src/review.ts",
        summary: "Adds complete persisted review context.",
        classifications: [{
          classification: "migration" as const,
          evidence: "The database gains an additive summary payload.",
        }],
        hunks: [{
          hunkId: "hunk-test",
          summary: "Connects validated review metadata to persistence.",
          classifications: [{
            classification: "test-impact" as const,
            evidence: "Reopen coverage compares the complete value.",
          }],
        }],
      }],
      generatedAt: "2026-07-22T10:00:00.000Z",
    };
    expect(store.upsertReviewSummary(summary)).toEqual(summary);
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
    expect(reopened.snapshot().reviewSummaries).toEqual([summary]);
    expect(reopened.snapshot().runs).toEqual([expect.objectContaining({
      id: run.id,
      kind: "check",
      actionId: "typecheck",
      status: "succeeded",
      canStop: false,
      finishedAt: expect.any(String),
    })]);
    reopened.dismissWorkspaceRun(run.id);
    expect(reopened.snapshot().runs).toEqual([
      expect.objectContaining({
        id: run.id,
        status: "succeeded",
        attentionState: "dismissed",
      }),
    ]);
    reopened.close();
  });

  it("persists explicit run attention transitions and keeps waiting requests actionable", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.snapshot().projects[0]!;
    const conversation = store.snapshot().conversations[0]!;
    const failure = store.createWorkspaceRun({
      kind: "source-control",
      projectId: project.id,
      conversationId: conversation.id,
      label: "Push",
      detail: "Remote rejected the push.",
      status: "running",
      port: null,
    });
    expect(store.updateWorkspaceRun(failure.id, { status: "failed" })).toMatchObject({
      attentionState: "unseen",
    });
    expect(store.markWorkspaceRunSeen(failure.id)).toMatchObject({ attentionState: "seen" });
    expect(store.markWorkspaceRunSeen(failure.id)).toMatchObject({ attentionState: "seen" });

    const waiting = store.createWorkspaceRun({
      kind: "agent",
      projectId: project.id,
      conversationId: conversation.id,
      label: "Approval",
      detail: "Approve command",
      status: "waiting",
      port: null,
    });
    expect(waiting.attentionState).toBe("unseen");
    expect(store.markWorkspaceRunSeen(waiting.id).attentionState).toBe("seen");
    expect(() => store.acknowledgeWorkspaceRun(waiting.id)).toThrow(/waiting/iu);
    expect(() => store.dismissWorkspaceRun(waiting.id)).toThrow(/active/iu);

    const importedCompletion = store.createWorkspaceRun({
      kind: "agent",
      projectId: project.id,
      conversationId: conversation.id,
      label: "Imported completion",
      detail: "Created already complete.",
      status: "succeeded",
      port: null,
    });
    expect(importedCompletion.finishedAt).toBeNull();
    expect(store.acknowledgeWorkspaceRun(importedCompletion.id).attentionState).toBe("acknowledged");
    store.dismissWorkspaceRun(importedCompletion.id);
    expect(store.workspaceRun(importedCompletion.id).attentionState).toBe("dismissed");
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    expect(reopened.workspaceRun(failure.id).attentionState).toBe("seen");
    expect(reopened.acknowledgeWorkspaceRun(failure.id).attentionState).toBe("acknowledged");
    reopened.dismissWorkspaceRun(failure.id);
    expect(reopened.workspaceRun(failure.id)).toMatchObject({
      status: "failed",
      attentionState: "dismissed",
      detail: "Remote rejected the push.",
    });
    reopened.close();

    const reopenedAgain = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    expect(reopenedAgain.workspaceRun(failure.id).attentionState).toBe("dismissed");
    reopenedAgain.close();
  });

  it("does not let a background assistant stream steal selection or fabricate a view", async () => {
    const { store } = await createStore();
    const project = store.snapshot().projects[0]!;
    const background = store.createConversation(project.id, "Background");
    const backgroundViewedAt = background.lastViewedAt;
    const foreground = store.createConversation(project.id, "Foreground");

    store.createMessage(background.id, "Partial response", "assistant");
    store.createMessage(background.id, "Provider note", "system");
    expect(store.snapshot().activeConversationId).toBe(foreground.id);
    expect(store.conversation(background.id).lastViewedAt).toBe(backgroundViewedAt);

    store.createMessage(background.id, "Follow up", "user");
    expect(store.snapshot().activeConversationId).toBe(background.id);
    expect(store.conversation(background.id).lastViewedAt).toEqual(expect.any(String));
    store.close();
  });

  it("does not mark a selected conversation viewed merely because its run completed", async () => {
    const { store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    const viewedAt = conversation.lastViewedAt;
    store.updateConversation(conversation.id, { status: "running" });
    store.updateConversation(conversation.id, { status: "completed" });
    expect(store.snapshot().activeConversationId).toBe(conversation.id);
    expect(store.conversation(conversation.id).lastViewedAt).toBe(viewedAt);
    store.close();
  });

  it("omits malformed complete review payloads instead of partially casting legacy columns", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    const summary = {
      conversationId: conversation.id,
      fingerprint: "2".repeat(64),
      providerId: "claude" as const,
      harnessId: "claude-agent-sdk",
      backendProfileId: "legacy:claude:claude-agent-sdk",
      model: "claude-sonnet-4-5",
      overall: "A valid complete summary.",
      classifications: [],
      files: [{
        path: "src/a.ts",
        summary: "Updates a value.",
        classifications: [],
        hunks: [{
          hunkId: "hunk-a",
          summary: "Changes the value.",
          classifications: [],
        }],
      }],
      generatedAt: "2026-07-22T11:00:00.000Z",
    };
    store.upsertReviewSummary(summary);
    store.close();

    const database = new Database(databasePath);
    database.prepare("UPDATE diff_review_summaries SET summary_json = ? WHERE conversation_id = ?")
      .run(JSON.stringify({ ...summary, classifications: undefined }), conversation.id);
    database.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().reviewSummaries).toEqual([]);
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

    reopened.reconcileReviewTargets(conversation.id, ".", undefined, {
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

  it("keeps identical review targets independent across repository roots", async () => {
    const { store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    for (const repositoryPath of [".", "modules/example"]) {
      store.setReviewState({
        conversationId: conversation.id,
        repositoryPath,
        scope: "file",
        path: "src/review.ts",
        hunkId: null,
        targetFingerprint: "a".repeat(64),
        reviewed: true,
      });
    }

    store.reconcileReviewTargets(conversation.id, ".", undefined, {
      files: {},
      hunks: {},
      notes: {},
    });

    expect(store.snapshot().reviewStates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repositoryPath: ".",
        reviewed: false,
        stale: true,
      }),
      expect.objectContaining({
        repositoryPath: "modules/example",
        reviewed: true,
        stale: false,
      }),
    ]));
    store.close();
  });

  it("loads review notes by repository and target path for reconciliation", async () => {
    const { store } = await createStore();
    const conversation = store.snapshot().conversations[0]!;
    const fingerprint = "a".repeat(64);
    const rootTarget = store.createReviewNote({
      conversationId: conversation.id,
      repositoryPath: ".",
      path: "src/target.ts",
      hunkId: null,
      lineIds: [],
      targetFingerprint: fingerprint,
      body: "Root target",
    });
    store.createReviewNote({
      conversationId: conversation.id,
      repositoryPath: ".",
      path: "src/other.ts",
      hunkId: null,
      lineIds: [],
      targetFingerprint: fingerprint,
      body: "Root other",
    });
    store.createReviewNote({
      conversationId: conversation.id,
      repositoryPath: "modules/example",
      path: "src/target.ts",
      hunkId: null,
      lineIds: [],
      targetFingerprint: fingerprint,
      body: "Nested target",
    });

    expect(store.reviewNotesFor(
      conversation.id,
      ".",
      "src/target.ts",
    )).toEqual([rootTarget]);
    expect(store.reviewNotesFor(
      conversation.id,
      "modules/example",
      "src/target.ts",
    )).toEqual([
      expect.objectContaining({ body: "Nested target" }),
    ]);
    store.close();
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
      scope: {
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfileId: "builtin:openai",
        modelId: "provider-catalog",
        executable: "/usr/local/bin/codex",
        version: "1.2.3",
        backendConfigurationRevision: 0,
        authState: "authenticated",
      },
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
      scope: expect.objectContaining({
        providerId: "codex",
        backendProfileId: "builtin:openai",
        executable: "/usr/local/bin/codex",
      }),
      models: [expect.objectContaining({ id: "gpt-test" })],
      rateLimits: [expect.objectContaining({ id: "five-hour", usedPercent: 25 })],
    })]);
    reopened.close();
  });

  it("persists multiple exact metadata scopes for one harness provider without collisions", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const base = {
      modelsUpdatedAt: "2026-07-25T10:00:00.000Z",
      modelsLastAttemptedAt: "2026-07-25T10:00:00.000Z",
      modelsProvenance: "provider" as const,
      modelsStale: false,
      rateLimits: [],
      rateLimitsUpdatedAt: null,
      rateLimitsLastAttemptedAt: null,
      rateLimitsProvenance: null,
      rateLimitsStale: false,
    };
    store.saveProviderMetadata({
      ...base,
      scope: {
        providerId: "claude",
        harnessId: "claude-agent-sdk",
        backendProfileId: "builtin:anthropic",
        modelId: "provider-catalog",
        executable: "/usr/local/bin/claude",
        version: "2.1.0",
        backendConfigurationRevision: 0,
        authState: "authenticated",
      },
      models: [{
        id: "claude-native",
        label: "Claude native",
        description: "Native Anthropic model",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [],
        defaultReasoningEffort: "",
      }],
    });
    store.saveProviderMetadata({
      ...base,
      scope: {
        providerId: "claude",
        harnessId: "claude-agent-sdk",
        backendProfileId: "builtin:kimi-code",
        modelId: "k3",
        executable: "/usr/local/bin/claude",
        version: "2.1.0",
        backendConfigurationRevision: 4,
        authState: "configured",
      },
      models: [{
        id: "k3",
        label: "K3",
        description: "Kimi coding model",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [],
        defaultReasoningEffort: "",
      }],
    });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    const records = reopened.loadProviderMetadata();
    expect(records).toHaveLength(2);
    expect(records).toContainEqual(expect.objectContaining({
      scope: expect.objectContaining({
        backendProfileId: "builtin:anthropic",
        modelId: "provider-catalog",
        authState: "authenticated",
      }),
      models: [expect.objectContaining({ id: "claude-native" })],
    }));
    expect(records).toContainEqual(expect.objectContaining({
      scope: expect.objectContaining({
        backendProfileId: "builtin:kimi-code",
        modelId: "k3",
        backendConfigurationRevision: 4,
        authState: "configured",
      }),
      models: [expect.objectContaining({ id: "k3" })],
      rateLimits: [],
    }));
    reopened.close();
  });

  it("migrates the legacy provider metadata cache into the canonical native scope", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    store.close();
    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE provider_metadata_scoped_cache");
    legacy.prepare("DELETE FROM schema_migrations WHERE version >= 26").run();
    legacy.prepare(`
      INSERT INTO provider_metadata_cache (
        provider_id, executable, version, auth_state,
        models_json, models_updated_at, models_last_attempted_at,
        models_provenance, models_stale, rate_limits_json,
        rate_limits_updated_at, rate_limits_last_attempted_at,
        rate_limits_provenance, rate_limits_stale
      ) VALUES (
        @providerId, @executable, @version, @authState,
        @modelsJson, @updatedAt, @updatedAt,
        'provider', 0, @rateLimitsJson,
        @updatedAt, @updatedAt, 'provider', 0
      )
    `).run({
      providerId: "claude",
      executable: "/usr/local/bin/claude",
      version: "2.1.0",
      authState: "authenticated",
      modelsJson: JSON.stringify([{
        id: "claude-native",
        label: "Claude native",
        description: "Native Anthropic model",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [],
        defaultReasoningEffort: "",
      }]),
      rateLimitsJson: JSON.stringify([{
        id: "five-hour",
        label: "Claude · 5 hour",
        usedPercent: 20,
        remainingPercent: 80,
        windowMinutes: 300,
        resetsAt: "2026-07-25T15:00:00.000Z",
      }]),
      updatedAt: "2026-07-25T10:00:00.000Z",
    });
    legacy.close();

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.loadProviderMetadata()).toEqual([expect.objectContaining({
      scope: {
        providerId: "claude",
        harnessId: "claude-agent-sdk",
        backendProfileId: "builtin:anthropic",
        modelId: "provider-catalog",
        executable: "/usr/local/bin/claude",
        version: "2.1.0",
        backendConfigurationRevision: 0,
        authState: "authenticated",
      },
      models: [expect.objectContaining({ id: "claude-native" })],
      rateLimits: [expect.objectContaining({
        id: "five-hour",
        resetsAt: "2026-07-25T15:00:00.000Z",
      })],
    })]);
    migrated.close();
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
