import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentApprovalRequest, AgentInputRequest, AgentPlan, ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { AcpCompactionProjection } from "../../src/server/provider/acp-compaction-projection";
import { nativeModelSelection } from "../../src/shared/model-routing";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import type { TurnControllerHooks } from "../../src/server/runtime/turns/turn-controller-types";
import { FakeTurnProvider, FakeTurnScheduler } from "../support/fake-turn-provider";

const directories: string[] = [];
const providerInfo = (providerId: "codex" | "claude" = "codex"): ProviderInfo => {
  const field = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: providerId,
    label: providerId === "codex" ? "Codex" : "Claude",
    command: `fake-${providerId}`,
    available: true,
    version: "test",
    executable: "fake-codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "gpt-test",
      label: "GPT Test",
      description: "Fake model",
      isDefault: true,
      inputModalities: ["text", "image"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
      fastMode: null,
    }],
    rateLimits: [],
    metadataState: { models: field, rateLimits: field },
  };
};

async function runtime(
  providerId: "codex" | "claude" = "codex",
  hookOverrides: Partial<TurnControllerHooks> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "inertia-turn-truth-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspace, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Truth project", workspace);
  const conversation = store.createConversation(project.id, "Truth conversation", {
    providerId,
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
  });
  const provider = new FakeTurnProvider();
  const events: ServerEvent[] = [];
  const settled: string[] = [];
  let sequence = 0;
  const controller = new TurnController(
    store,
    provider,
    new Map<string, AgentApprovalRequest>(),
    new Map<string, AgentInputRequest>(),
    new Map<string, AgentPlan>(),
    {
      broadcast: (event) => {
        events.push(event);
      },
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo(providerId)],
      captureStructuredContext: ({ content }) => ({ visibleRequest: content }),
      onTurnSettled: (turn) => {
        settled.push(`${turn.status}:${turn.id}`);
      },
      ...hookOverrides,
    },
    {
      scheduler: new FakeTurnScheduler(),
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
      id: () => `truth-id-${++sequence}`,
      turnTimeoutMs: 1_000,
    },
  );
  return {
    store,
    provider,
    controller,
    projectId: project.id,
    conversationId: conversation.id,
    events,
    settled,
  };
}

function identity(value: Awaited<ReturnType<typeof runtime>>) {
  const input = value.provider.input;
  if (!input?.runId || !input.turnId) throw new Error("Turn is not started.");
  return {
    providerId: input.providerId,
    conversationId: value.conversationId,
    runId: input.runId,
    turnId: input.turnId,
  } as const;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("TurnController terminal truthfulness", () => {
  it("settles a durable turn and releases admission when live adoption throws", async () => {
    const onStructuredContextCaptured = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("injected structured-context publication failure");
      });
    const value = await runtime("codex", { onStructuredContextCaptured });
    const checkpoint = value.store.addCheckpoint({
      conversationId: value.conversationId,
      ref: "refs/inertia/checkpoints/adoption-failure",
      label: "Before adoption failure",
      turnIndex: 1,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
    const firstAdmission = await value.controller.acquireTurnAdmission(
      value.conversationId,
      100,
    );
    expect(firstAdmission).not.toBeNull();

    expect(() => value.controller.queue({
      conversationId: value.conversationId,
      content: "Fail while adopting the durable turn.",
      checkpointId: checkpoint.id,
    }, undefined, firstAdmission!)).toThrow(
      "injected structured-context publication failure",
    );
    firstAdmission?.release();

    const failed = value.store.latestAgentTurnForConversation(value.conversationId);
    expect(failed).toMatchObject({
      status: "failed",
      terminalReason: "turn-adoption-failed",
      checkpointId: checkpoint.id,
    });
    expect(value.store.checkpoint(checkpoint.id).turnId).toBe(failed?.id);
    expect(value.store.unfinishedAgentTurns()).toEqual([]);
    expect(value.controller.isActive(value.conversationId)).toBe(false);

    const retryAdmission = await value.controller.acquireTurnAdmission(
      value.conversationId,
      100,
    );
    expect(retryAdmission).not.toBeNull();
    const retry = value.controller.queue({
      conversationId: value.conversationId,
      content: "Retry immediately after adoption cleanup.",
    }, undefined, retryAdmission!);
    expect(value.controller.failBeforeStart(
      value.conversationId,
      "End the retry fixture.",
    )).toBe(true);
    expect(value.store.agentTurn(retry.turn.id).status).toBe("failed");
    expect(value.controller.isActive(value.conversationId)).toBe(false);
    value.store.close();
  });

  it("settles a durable turn when the persistence handoff callback throws", async () => {
    const value = await runtime();
    const checkpoint = value.store.addCheckpoint({
      conversationId: value.conversationId,
      ref: "refs/inertia/checkpoints/persistence-handoff-failure",
      label: "Before persistence handoff failure",
      turnIndex: 1,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
    const admission = await value.controller.acquireTurnAdmission(
      value.conversationId,
      100,
    );
    expect(admission).not.toBeNull();
    expect(() => value.controller.queue({
      conversationId: value.conversationId,
      content: "Fail the persistence ownership callback.",
      checkpointId: checkpoint.id,
    }, () => {
      throw new Error("injected persistence handoff failure");
    }, admission!)).toThrow("injected persistence handoff failure");
    admission?.release();

    const failed = value.store.latestAgentTurnForConversation(
      value.conversationId,
    );
    expect(failed).toMatchObject({
      status: "failed",
      terminalReason: "turn-adoption-failed",
      checkpointId: checkpoint.id,
    });
    expect(value.store.checkpoint(checkpoint.id).turnId).toBe(failed?.id);
    expect(value.store.unfinishedAgentTurns()).toEqual([]);
    expect(value.controller.isActive(value.conversationId)).toBe(false);
    await expect(value.controller.acquireTurnAdmission(
      value.conversationId,
      100,
    )).resolves.not.toBeNull();
    value.store.close();
  });

  it("retains a recoverable checkpoint when live association itself fails", async () => {
    const value = await runtime();
    const checkpoint = value.store.addCheckpoint({
      conversationId: value.conversationId,
      ref: "refs/inertia/checkpoints/association-failure",
      label: "Before association failure",
      turnIndex: 1,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
    vi.spyOn(value.store, "associateCheckpointWithTurn")
      .mockImplementationOnce(() => {
        throw new Error("injected checkpoint association failure");
      });

    expect(() => value.controller.queue({
      conversationId: value.conversationId,
      content: "Fail while linking the checkpoint.",
      checkpointId: checkpoint.id,
    })).toThrow("injected checkpoint association failure");

    expect(value.store.latestAgentTurnForConversation(value.conversationId))
      .toMatchObject({
        status: "failed",
        terminalReason: "turn-adoption-failed",
        checkpointId: checkpoint.id,
      });
    expect(value.store.checkpoint(checkpoint.id).turnId).toBeNull();
    expect(value.store.unfinishedAgentTurns()).toEqual([]);
    expect(value.controller.isActive(value.conversationId)).toBe(false);
    value.store.close();
  });

  it("admits the next turn after a settled provider cleanup barrier drains", async () => {
    const value = await runtime();
    const firstAdmission = await value.controller.acquireTurnAdmission(
      value.conversationId,
      100,
    );
    expect(firstAdmission).not.toBeNull();
    const first = value.controller.queue({
      conversationId: value.conversationId,
      content: "Settle while exact provider cleanup is still pending.",
    }, undefined, firstAdmission!);
    expect(value.controller.start(first.turn.id)).toBe(true);
    value.provider.deferOwnedStop();
    expect(value.controller.cancel(value.conversationId)).toBe(true);

    value.provider.resolve({ status: "cancelled" });
    await flushPromises();
    expect(value.store.agentTurn(first.turn.id).status).toBe("cancelled");
    expect(value.controller.isActive(value.conversationId)).toBe(false);

    let admitted = false;
    const pendingAdmission = value.controller.acquireTurnAdmission(
      value.conversationId,
      1_000,
    ).then((lease) => {
      admitted = true;
      return lease;
    });
    await flushPromises();
    expect(admitted).toBe(false);

    value.provider.resolveOwnedStop();
    const retryAdmission = await pendingAdmission;
    expect(retryAdmission).not.toBeNull();
    const retry = value.controller.queue({
      conversationId: value.conversationId,
      content: "Retry from the next real admission.",
    }, undefined, retryAdmission!);
    expect(value.controller.start(retry.turn.id)).toBe(true);
    value.provider.resolve({ text: "Retry completed." });
    await flushPromises();
    expect(value.store.agentTurn(retry.turn.id).status).toBe("completed");
    expect(value.store.unfinishedAgentTurns()).toEqual([]);
    value.store.close();
  });

  it("settles both durable sides when the second paired adoption throws", async () => {
    const onStructuredContextCaptured = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("injected second-side adoption failure");
      });
    const value = await runtime("codex", { onStructuredContextCaptured });
    const launchId = randomUUID();
    const conversationIds = [randomUUID(), randomUUID()] as const;
    value.store.createPairedLaunch(launchId, [
      {
        ordinal: 0,
        projectId: value.projectId,
        plannedConversationId: conversationIds[0],
        plannedWorktreePath: null,
        plannedBranch: null,
        ownsWorktree: false,
      },
      {
        ordinal: 1,
        projectId: value.projectId,
        plannedConversationId: conversationIds[1],
        plannedWorktreePath: null,
        plannedBranch: null,
        ownsWorktree: false,
      },
    ]);
    const selection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-test",
      alias: "GPT Test",
      reasoningEffort: "high",
    });
    const pairedPlans: Parameters<
      RuntimeStore["createPairedConversations"]
    >[1] = [
      {
        projectId: value.projectId,
        title: "Pair 0",
        options: {
          id: conversationIds[0],
          providerId: "codex",
          modelSelection: selection,
          interactionMode: "build",
          accessMode: "supervised",
          activate: false,
        },
      },
      {
        projectId: value.projectId,
        title: "Pair 1",
        options: {
          id: conversationIds[1],
          providerId: "codex",
          modelSelection: selection,
          interactionMode: "build",
          accessMode: "supervised",
          activate: false,
        },
      },
    ];
    const conversations = value.store.createPairedConversations(
      launchId,
      pairedPlans,
    );

    expect(() => value.controller.queuePair(launchId, [
      { conversationId: conversations[0].id, content: "First paired side." },
      { conversationId: conversations[1].id, content: "Second paired side." },
    ])).toThrow("injected second-side adoption failure");
    for (const conversation of conversations) {
      expect(value.store.latestAgentTurnForConversation(conversation.id))
        .toMatchObject({
          status: "failed",
          terminalReason: "turn-adoption-failed",
        });
      expect(value.controller.isActive(conversation.id)).toBe(false);
    }
    expect(value.store.unfinishedAgentTurns()).toEqual([]);
    value.store.close();
  });

  it("keeps Claude starting until its provider emits running", async () => {
    const value = await runtime("claude");
    const queued = value.controller.queue({
      conversationId: value.conversationId,
      content: "Stage the selected skill before starting Claude.",
    });
    expect(value.controller.start(queued.turn.id)).toBe(true);
    expect(value.provider.input?.harnessId).toBe("claude-agent-sdk");
    expect(value.store.agentTurn(queued.turn.id).status).toBe("starting");

    value.provider.emit({ ...identity(value), type: "status", status: "running" });
    expect(value.store.agentTurn(queued.turn.id).status).toBe("running");
    value.provider.resolve();
    await flushPromises();
    value.store.close();
  });

  it("fails closed when a provider reports completion with live delegated work", async () => {
    const value = await runtime();
    const queued = value.controller.queue({
      conversationId: value.conversationId,
      content: "Do not complete before delegated work settles.",
    });
    expect(value.controller.start(queued.turn.id)).toBe(true);
    const base = identity(value);
    value.provider.emit({
      ...base,
      type: "subagent",
      sequence: 1,
      providerTaskId: "child-still-running",
      providerAgentId: "agent-still-running",
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: "tool-still-running",
      providerRole: "worker",
      providerName: null,
      providerStatus: "running",
      status: "running",
      isLive: true,
      description: "Finish delegated verification",
      progress: "Still verifying",
      result: null,
    });
    expect(value.store.agentTurn(queued.turn.id)?.runState?.state).toBe("delegated");

    value.provider.resolve({
      status: "completed",
      text: "I will notify you when the delegate finishes.",
    });
    await flushPromises();

    expect(value.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "provider-error",
      runState: { state: "failed" },
    });
    expect(value.store.conversationDetail(value.conversationId)?.subagents)
      .toContainEqual(expect.objectContaining({
        providerTaskId: "child-still-running",
        status: "lost",
        isLive: false,
      }));
    expect(value.events).toContainEqual(expect.objectContaining({
      type: "agent.failed",
      turnId: queued.turn.id,
      message: "The provider ended while delegated work was still running.",
    }));
    expect(value.events).not.toContainEqual(expect.objectContaining({
      type: "agent.completed",
      turnId: queued.turn.id,
      status: "completed",
    }));
    value.store.close();
  });

  it("persists one terminal-first ACP compaction row across mutable patches", async () => {
    const value = await runtime();
    const queued = value.controller.queue({
      conversationId: value.conversationId,
      content: "Exercise terminal-first compaction patches.",
    });
    expect(value.controller.start(queued.turn.id)).toBe(true);
    await flushPromises();

    const emitter = createAgentHarnessEmitter(
      "codex",
      value.conversationId,
      {
        onEvent: (event) => {
          if (event.type === "activity") value.provider.emit(event);
        },
      },
      queued.turn.runId,
      queued.turn.id,
    );
    const compactions = new AcpCompactionProjection(
      "Cursor",
      "cursor",
      emitter,
    );
    compactions.observeUpdate({
      compactionId: "compact-terminal-first",
      status: "failed",
      error: "first provider detail",
    });
    compactions.observeUpdate({
      compactionId: "compact-terminal-first",
      status: "failed",
    });
    compactions.observeUpdate({
      compactionId: "compact-terminal-first",
      status: "failed",
      error: "replacement provider detail",
    });
    compactions.observeUpdate({
      compactionId: "compact-terminal-first",
      status: "failed",
      error: null,
    });

    expect(value.store.conversationDetail(value.conversationId)?.activities
      .filter(({ turnId }) => turnId === queued.turn.id)).toEqual([
      expect.objectContaining({
        title: "Cursor could not compact session context",
        detail: "Status: failed",
        status: "failed",
      }),
    ]);

    value.provider.resolve();
    await flushPromises();
    value.store.close();
  });

  it("keeps a stopped command and its terminal event truthfully cancelled", async () => {
    const value = await runtime();
    const queued = value.controller.queue({
      conversationId: value.conversationId,
      content: "Stop while a command is still running.",
    });
    expect(value.controller.start(queued.turn.id)).toBe(true);
    await flushPromises();
    value.provider.emit({
      ...identity(value),
      type: "activity",
      kind: "command",
      phase: "started",
      label: "npm test",
      activityId: "command-before-stop",
      detail: "Command:\nnpm test",
    });
    value.provider.emit({
      ...identity(value),
      type: "reasoning-summary",
      text: "Still evaluating the command.",
    });

    expect(value.controller.cancel(value.conversationId)).toBe(true);

    const stoppingTurn = value.store.agentTurn(queued.turn.id);
    expect(stoppingTurn).toMatchObject({
      status: "running",
      runState: { state: "cancelling" },
      terminalReason: null,
    });
    const stoppingActivity = value.store.conversationDetail(value.conversationId)
      ?.activities.find(({ turnId }) => turnId === queued.turn.id);
    expect(stoppingActivity).toMatchObject({ status: "running", title: "npm test" });
    expect(value.events).not.toContainEqual(expect.objectContaining({
      type: "agent.completed",
      turnId: queued.turn.id,
    }));

    await flushPromises();
    const activity = value.store.conversationDetail(value.conversationId)
      ?.activities.find(({ turnId }) => turnId === queued.turn.id);
    expect(activity).toMatchObject({ status: "failed", title: "Interrupted · npm test" });
    expect(activity?.detail).toContain("Interrupted: Stopped");
    expect(value.store.conversationDetail(value.conversationId)?.reasonings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: "failed" })]));
    expect(value.store.workspaceRunsForConversation(value.conversationId))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        label: "Interrupted · npm test",
        status: "cancelled",
      })]));
    expect(value.events).toContainEqual({
      type: "agent.completed",
      conversationId: value.conversationId,
      runId: queued.turn.runId,
      turnId: queued.turn.id,
      status: "cancelled",
      terminalReason: "user-cancelled",
      terminalAssistantMessageId: null,
      terminalAssistantMessage: null,
    });
    value.store.close();
  });

  it("rejects duplicate accepted interaction responses without failing the active turn", async () => {
    const value = await runtime();
    const queued = value.controller.queue({
      conversationId: value.conversationId,
      content: "Wait for provider interaction acknowledgements.",
    });
    value.controller.start(queued.turn.id);
    const base = identity(value);
    value.provider.emit({
      ...base,
      type: "approval",
      request: {
        requestId: "approval-awaiting-provider",
        kind: "command",
        title: "Run tests",
        permissionRoots: [],
        availableDecisions: ["approve", "cancel"],
      },
    });
    expect(value.controller.respondToApproval(
      value.conversationId, "approval-awaiting-provider", "approve",
    )).toBe(true);
    expect(value.controller.respondToApproval(
      value.conversationId, "approval-awaiting-provider", "approve",
    )).toBe(false);
    expect(value.store.agentTurn(queued.turn.id).status).toBe("waiting-for-approval");
    value.provider.emit({
      ...base,
      type: "approval-resolved",
      requestId: "approval-awaiting-provider",
      decision: "approve",
    });

    value.provider.emit({
      ...base,
      type: "input",
      request: {
        requestId: "input-awaiting-provider",
        questions: [{
          id: "question-1",
          header: "Choice",
          question: "Which option?",
          isOther: false,
          isSecret: false,
          allowMultiple: false,
          options: [{ id: "one", label: "One", description: "" }],
        }],
        autoResolutionMs: null,
      },
    });
    expect(value.controller.respondToInput(
      value.conversationId, "input-awaiting-provider", { "question-1": ["one"] },
    )).toBe(true);
    expect(value.controller.respondToInput(
      value.conversationId, "input-awaiting-provider", { "question-1": ["one"] },
    )).toBe(false);
    expect(value.store.agentTurn(queued.turn.id).status).toBe("waiting-for-input");
    value.provider.emit({ ...base, type: "input-resolved", requestId: "input-awaiting-provider" });
    expect(value.store.agentTurn(queued.turn.id).status).toBe("running");
    expect(value.settled).not.toContain(`failed:${queued.turn.id}`);

    value.provider.resolve();
    await flushPromises();
    value.store.close();
  });
});
