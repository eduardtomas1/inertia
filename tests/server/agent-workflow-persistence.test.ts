import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import type { AgentGoal } from "../../src/shared/contracts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("agent workflow persistence", () => {
  it("restores provider-bound and local goals across a runtime restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-workflows-"));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "workspace");
    const databasePath = join(directory, "inertia.sqlite");
    await mkdir(workspace);
    const store = new RuntimeStore(databasePath, workspace);
    const project = store.createProject("Workflows", workspace);
    const conversation = store.createConversation(project.id, "Goal");
    const native: AgentGoal = {
      conversationId: conversation.id,
      source: "codex-native",
      providerSessionId: "thread-1",
      objective: "Keep workflow state authoritative",
      status: "blocked",
      tokenBudget: 20_000,
      tokensUsed: 4_000,
      timeUsedSeconds: 90,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:30.000Z",
      synchronizedAt: "2030-01-01T00:01:30.000Z",
    };
    const local: AgentGoal = {
      ...native,
      source: "inertia-local",
      providerSessionId: null,
      objective: "A local note never injected into the provider",
      status: "active",
      tokenBudget: null,
      tokensUsed: null,
      timeUsedSeconds: null,
      synchronizedAt: null,
    };
    store.upsertAgentGoal(native);
    store.upsertAgentGoal(local);
    store.close();

    const reopened = new RuntimeStore(databasePath, workspace);
    expect(reopened.agentGoals(conversation.id)).toEqual([native, local]);
    expect(reopened.conversationDetail(conversation.id)?.goals)
      .toEqual([native, local]);
    expect(reopened.clearAgentGoal(
      conversation.id,
      "inertia-local",
    )).toBe(true);
    expect(reopened.agentGoals(conversation.id)).toEqual([native]);
    reopened.close();
  });

  it("rejects stale native goal writes and tombstones a cleared session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-goal-ordering-"));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const store = new RuntimeStore(
      join(directory, "inertia.sqlite"),
      workspace,
    );
    const project = store.createProject("Workflows", workspace);
    const conversation = store.createConversation(project.id, "Goal");
    const current: AgentGoal = {
      conversationId: conversation.id,
      source: "codex-native",
      providerSessionId: "thread-1",
      objective: "Current objective",
      status: "active",
      tokenBudget: 20_000,
      tokensUsed: 4_000,
      timeUsedSeconds: 90,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:02:00.000Z",
      synchronizedAt: "2030-01-01T00:02:00.000Z",
    };
    expect(store.mergeNativeAgentGoal(current)).toEqual({
      goal: current,
      changed: true,
    });

    expect(store.mergeNativeAgentGoal({
      ...current,
      objective: "Stale objective",
      updatedAt: "2030-01-01T00:01:00.000Z",
      synchronizedAt: "2030-01-01T00:03:00.000Z",
    })).toEqual({
      goal: current,
      changed: false,
    });
    expect(store.mergeNativeAgentGoal({
      ...current,
      objective: "Authoritative but older objective",
      updatedAt: "2030-01-01T00:01:30.000Z",
      synchronizedAt: "2030-01-01T00:03:30.000Z",
    }, true)).toEqual({
      goal: current,
      changed: false,
    });
    expect(store.clearAgentGoal(
      conversation.id,
      "codex-native",
      "2030-01-01T00:03:00.800Z",
    )).toBe(true);
    expect(store.mergeNativeAgentGoal({
      ...current,
      objective: "Delayed objective",
      synchronizedAt: "2030-01-01T00:04:00.000Z",
    })).toEqual({
      goal: null,
      changed: false,
    });
    expect(store.mergeNativeAgentGoal({
      ...current,
      objective: "Unconfirmed same-second objective",
      updatedAt: "2030-01-01T00:03:00.000Z",
      synchronizedAt: "2030-01-01T00:04:30.000Z",
    })).toEqual({
      goal: null,
      changed: false,
    });

    const recreated = {
      ...current,
      objective: "Explicitly recreated",
      updatedAt: "2030-01-01T00:03:00.000Z",
      synchronizedAt: "2030-01-01T00:05:00.000Z",
    };
    expect(store.mergeNativeAgentGoal(recreated, true)).toEqual({
      goal: recreated,
      changed: true,
    });
    store.close();
  });

  it("persists distinct same-second native revisions but ignores exact replays", async () => {
    const directory = await mkdtemp(join(
      tmpdir(),
      "inertia-goal-same-second-",
    ));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "workspace");
    const databasePath = join(directory, "inertia.sqlite");
    await mkdir(workspace);
    const store = new RuntimeStore(databasePath, workspace);
    const project = store.createProject("Workflows", workspace);
    const conversation = store.createConversation(project.id, "Goal");
    const active: AgentGoal = {
      conversationId: conversation.id,
      source: "codex-native",
      providerSessionId: "thread-1",
      objective: "Finish the provider workflow",
      status: "active",
      tokenBudget: 20_000,
      tokensUsed: 4_000,
      timeUsedSeconds: 90,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:02:00.000Z",
      synchronizedAt: "2030-01-01T00:02:00.000Z",
    };
    expect(store.mergeNativeAgentGoal(active)).toEqual({
      goal: active,
      changed: true,
    });
    expect(store.mergeNativeAgentGoal({
      ...active,
      synchronizedAt: "2030-01-01T00:02:01.000Z",
    })).toEqual({
      goal: active,
      changed: false,
    });

    const completed: AgentGoal = {
      ...active,
      status: "complete",
      tokensUsed: 4_500,
      timeUsedSeconds: 95,
      synchronizedAt: "2030-01-01T00:02:02.000Z",
    };
    expect(store.mergeNativeAgentGoal(completed)).toEqual({
      goal: completed,
      changed: true,
    });
    expect(store.agentGoals(conversation.id)).toEqual([completed]);
    store.close();

    const reopened = new RuntimeStore(databasePath, workspace);
    expect(reopened.agentGoals(conversation.id)).toEqual([completed]);
    reopened.close();
  });
});
