import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentApprovalRequest, AgentInputRequest, AgentPlan, ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
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

async function runtime(providerId: "codex" | "claude" = "codex") {
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
    },
    {
      scheduler: new FakeTurnScheduler(),
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
      id: () => `truth-id-${++sequence}`,
      turnTimeoutMs: 1_000,
    },
  );
  return { store, provider, controller, conversationId: conversation.id, events, settled };
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
