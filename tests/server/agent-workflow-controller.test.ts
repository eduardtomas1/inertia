import { describe, expect, it, vi } from "vitest";

import type {
  AgentGoal,
  Conversation,
} from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import type { ProviderManager } from "../../src/server/providers";

const controlRequest = vi.hoisted(() => vi.fn());

vi.mock("../../src/server/codex/control-client", async (importOriginal) => ({
  ...await importOriginal<
    typeof import("../../src/server/codex/control-client")
  >(),
  withCodexControlClient: async (
    _options: unknown,
    runWithClient: (client: {
      request(method: string, params?: Record<string, unknown>):
        Promise<Record<string, unknown>>;
    }) => Promise<unknown>,
  ) => await runWithClient({ request: controlRequest }),
}));

import {
  AgentWorkflowController,
  parseCodexGoal,
} from "../../src/server/runtime/agent-workflow-controller";

function conversation(update: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation-1",
    projectId: "project-1",
    title: "Workflow",
    providerId: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      backendProfileDisplayName: "OpenAI",
      backendConfigurationRevision: 0,
      modelId: "gpt-test",
      alias: null,
      reasoningEffort: "high",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: null,
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: "main",
    worktreePath: null,
    providerSessionId: "thread-1",
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...update,
  };
}

function nativeGoal(update: Partial<AgentGoal> = {}): AgentGoal {
  return {
    conversationId: "conversation-1",
    source: "codex-native",
    providerSessionId: "thread-1",
    objective: "Keep workflows truthful",
    status: "active",
    tokenBudget: 40_000,
    tokensUsed: 2_000,
    timeUsedSeconds: 42,
    createdAt: "2027-01-15T08:00:00.000Z",
    updatedAt: "2027-01-15T08:00:10.000Z",
    synchronizedAt: "2030-01-01T00:00:00.000Z",
    ...update,
  };
}

function harness(options: {
  current?: Conversation;
  goals?: AgentGoal[];
  now?: Date;
  claudeSkills?: Array<{
    name: string;
    description: string;
    argumentHint: string;
  }>;
  claudeSkillsImplementation?: (
    forceReload: boolean,
  ) => Promise<Array<{
    name: string;
    description: string;
    argumentHint: string;
  }>>;
} = {}): {
  controller: AgentWorkflowController;
  goals: AgentGoal[];
  clear: ReturnType<typeof vi.fn>;
  providers: ProviderManager;
} {
  const current = options.current ?? conversation();
  const goals = [...(options.goals ?? [])];
  const clear = vi.fn((
    conversationId: string,
    source: AgentGoal["source"],
  ) => {
    const index = goals.findIndex((goal) =>
      goal.conversationId === conversationId && goal.source === source);
    if (index < 0) return false;
    goals.splice(index, 1);
    return true;
  });
  const store = {
    conversation: vi.fn(() => current),
    conversationPath: vi.fn(() => "/workspace/project"),
    agentGoals: vi.fn(() => [...goals]),
    upsertAgentGoal: vi.fn((goal: AgentGoal) => {
      clear(goal.conversationId, goal.source);
      goals.push(goal);
      return goal;
    }),
    mergeNativeAgentGoal: vi.fn((
      goal: AgentGoal,
      authoritativeMutation = false,
    ) => {
      const existing = goals.find(({ source }) => source === "codex-native");
      if (
        existing
        && !authoritativeMutation
        && existing.providerSessionId === goal.providerSessionId
        && existing.updatedAt >= goal.updatedAt
      ) {
        return { goal: existing, changed: false };
      }
      clear(goal.conversationId, goal.source);
      goals.push(goal);
      return { goal, changed: true };
    }),
    clearAgentGoal: clear,
  } as unknown as RuntimeStore;
  const providers = {
    codexControlContext: vi.fn(async () => ({
      executable: "/fake/codex",
      environment: {},
      cwd: "/workspace/project",
    })),
    claudeSkills: vi.fn(async (_cwd: string, forceReload: boolean) =>
      options.claudeSkillsImplementation
        ? await options.claudeSkillsImplementation(forceReload)
        : options.claudeSkills ?? []),
  } as unknown as ProviderManager;
  return {
    controller: new AgentWorkflowController(
      store,
      providers,
      () => options.now ?? new Date("2030-01-01T00:00:00.000Z"),
    ),
    goals,
    clear,
    providers,
  };
}

function providerGoal(threadId = "thread-1"): Record<string, unknown> {
  return {
    threadId,
    objective: "Keep workflows truthful",
    status: "active",
    tokenBudget: 40_000,
    tokensUsed: 2_000,
    timeUsedSeconds: 42,
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_010,
  };
}

describe("AgentWorkflowController", () => {
  it("requires the exact native provider thread when parsing a goal", () => {
    expect(parseCodexGoal(
      "conversation-1",
      "thread-1",
      providerGoal("thread-other"),
    )).toBeNull();
    expect(parseCodexGoal(
      "conversation-1",
      "thread-1",
      providerGoal(),
    )).toMatchObject({
      source: "codex-native",
      providerSessionId: "thread-1",
      objective: "Keep workflows truthful",
    });
  });

  it("rejects malformed required usage and nullable budget fields", () => {
    const valid = providerGoal();
    expect(parseCodexGoal(
      "conversation-1",
      "thread-1",
      { ...valid, tokensUsed: undefined },
    )).toBeNull();
    expect(parseCodexGoal(
      "conversation-1",
      "thread-1",
      { ...valid, timeUsedSeconds: -1 },
    )).toBeNull();
    expect(parseCodexGoal(
      "conversation-1",
      "thread-1",
      { ...valid, tokenBudget: "unbounded" },
    )).toBeNull();
    expect(parseCodexGoal(
      "conversation-1",
      "thread-1",
      { ...valid, tokenBudget: null },
    )).toMatchObject({ tokenBudget: null });
  });

  it("drops a persisted native goal when the conversation session rotates", () => {
    const runtime = harness({
      current: conversation({ providerSessionId: "thread-2" }),
      goals: [nativeGoal()],
    });

    expect(runtime.controller.state("conversation-1").goals).toEqual([]);
    expect(runtime.clear).toHaveBeenCalledWith(
      "conversation-1",
      "codex-native",
    );
  });

  it("patches native status without resending a stale objective or budget", async () => {
    controlRequest.mockImplementation(async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      expect(method).toBe("thread/goal/set");
      expect(params).toEqual({
        threadId: "thread-1",
        status: "paused",
      });
      return {
        goal: {
          ...providerGoal(),
          objective: "Externally updated objective",
          status: "paused",
        },
      };
    });
    const runtime = harness({ goals: [nativeGoal()] });

    const updated = await runtime.controller.setGoal({
      conversationId: "conversation-1",
      source: "codex-native",
      status: "paused",
    });

    expect(updated.objective).toBe("Externally updated objective");
    expect(updated.status).toBe("paused");
  });

  it("serializes native goal mutations for one provider thread", async () => {
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    controlRequest.mockImplementation(async (
      _method: string,
      params: Record<string, unknown>,
    ) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      if (params.status === "paused") await firstResponse;
      activeRequests -= 1;
      return {
        goal: {
          ...providerGoal(),
          status: params.status,
          updatedAt: params.status === "paused"
            ? 1_800_000_020
            : 1_800_000_030,
        },
      };
    });
    const runtime = harness({ goals: [nativeGoal()] });
    const initialCallCount = controlRequest.mock.calls.length;

    const first = runtime.controller.setGoal({
      conversationId: "conversation-1",
      source: "codex-native",
      status: "paused",
    });
    const second = runtime.controller.setGoal({
      conversationId: "conversation-1",
      source: "codex-native",
      status: "active",
    });
    await vi.waitFor(() =>
      expect(controlRequest).toHaveBeenCalledTimes(initialCallCount + 1));
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(controlRequest).toHaveBeenCalledTimes(initialCallCount + 2);
    expect(maximumActiveRequests).toBe(1);
    expect(runtime.goals).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
  });

  it("does not let a stale empty refresh clear a newer live goal", async () => {
    let settleRefresh!: (value: Record<string, unknown>) => void;
    controlRequest.mockImplementation(() =>
      new Promise<Record<string, unknown>>((resolve) => {
        settleRefresh = resolve;
      }));
    const runtime = harness();
    const initialCallCount = controlRequest.mock.calls.length;

    const refreshing = runtime.controller.refresh("conversation-1");
    await vi.waitFor(() =>
      expect(controlRequest).toHaveBeenCalledTimes(initialCallCount + 1));
    const live = nativeGoal({
      objective: "A newer live objective",
      updatedAt: "2030-01-01T00:02:00.000Z",
    });
    runtime.goals.push(live);
    settleRefresh({ goal: null });

    await expect(refreshing).resolves.toMatchObject({
      goals: [live],
    });
    expect(runtime.clear).not.toHaveBeenCalledWith(
      "conversation-1",
      "codex-native",
      expect.any(String),
      "thread-1",
    );
  });

  it("preserves the persisted goal when refresh returns malformed data", async () => {
    const persisted = nativeGoal();
    controlRequest.mockResolvedValue({
      goal: {
        ...providerGoal(),
        status: "not-a-goal-status",
      },
    });
    const runtime = harness({ goals: [persisted] });

    await expect(runtime.controller.refresh("conversation-1"))
      .rejects.toThrow("malformed goal response");

    expect(runtime.goals).toEqual([persisted]);
    expect(runtime.clear).not.toHaveBeenCalledWith(
      "conversation-1",
      "codex-native",
      expect.any(String),
      "thread-1",
    );
  });

  it("does not clear a replacement thread after the provider request settles", async () => {
    let settleClear!: () => void;
    const clearResponse = new Promise<Record<string, unknown>>((resolve) => {
      settleClear = () => resolve({});
    });
    controlRequest.mockReturnValue(clearResponse);
    const current = conversation();
    const persisted = nativeGoal();
    const runtime = harness({ current, goals: [persisted] });

    const clearing = runtime.controller.clearGoal(
      "conversation-1",
      "codex-native",
    );
    await vi.waitFor(() =>
      expect(controlRequest).toHaveBeenCalledWith("thread/goal/clear", {
        threadId: "thread-1",
      }));
    current.providerSessionId = "thread-2";
    settleClear();

    await expect(clearing).resolves.toBe(false);
    expect(runtime.goals).toEqual([persisted]);
    expect(runtime.clear).not.toHaveBeenCalled();
  });

  it("never accepts skills returned for another cwd", async () => {
    controlRequest.mockResolvedValue({
      data: [{
        cwd: "/workspace/other",
        skills: [{
          name: "wrong-project",
          path: "/workspace/other/.codex/skills/wrong/SKILL.md",
          description: "Wrong workspace",
          scope: "repo",
          enabled: true,
        }],
        errors: [],
      }],
    });
    const runtime = harness();

    await expect(runtime.controller.listSkills(
      "conversation-1",
      false,
    )).rejects.toThrow("did not return skills for this project");
  });

  it("keeps discovered paths privileged behind bounded opaque capabilities", async () => {
    const skillPath = "/workspace/project/.codex/skills/review/SKILL.md";
    controlRequest.mockResolvedValue({
      data: [{
        cwd: "/workspace/project",
        skills: [{
          name: "review",
          path: skillPath,
          description: "Review this project.",
          scope: "repo",
          enabled: true,
        }],
        errors: [],
      }],
    });
    const runtime = harness();

    const [summary] = await runtime.controller.listSkills(
      "conversation-1",
      false,
    );

    expect(summary).toEqual(expect.objectContaining({
      name: "review",
      source: "codex-native",
      enabled: true,
    }));
    expect(summary).not.toHaveProperty("path");
    await expect(runtime.controller.resolveSkills(
      "conversation-1",
      [summary!.id],
    )).resolves.toEqual([{
      source: "codex-native",
      name: "review",
      path: skillPath,
    }]);
  });

  it("force-revalidates an opaque skill immediately before provider use", async () => {
    const skillPath = "/workspace/project/.codex/skills/review/SKILL.md";
    controlRequest.mockResolvedValueOnce({
      data: [{
        cwd: "/workspace/project",
        skills: [{
          name: "review",
          path: skillPath,
          description: "Review this project.",
          scope: "repo",
          enabled: true,
        }],
        errors: [],
      }],
    }).mockResolvedValueOnce({
      data: [{
        cwd: "/workspace/project",
        skills: [],
        errors: [],
      }],
    });
    const runtime = harness();
    const [summary] = await runtime.controller.listSkills(
      "conversation-1",
      false,
    );

    await expect(runtime.controller.resolveSkills(
      "conversation-1",
      [summary!.id],
    )).rejects.toThrow("no longer available");
    expect(runtime.controller.state("conversation-1").skills).toEqual([]);
  });

  it("labels non-Codex goals as explicitly Inertia-owned", async () => {
    const runtime = harness({
      current: conversation({
        providerId: "claude",
        providerSessionId: "claude-session",
        modelSelection: {
          ...conversation().modelSelection,
          harnessId: "claude-agent-sdk",
        },
      }),
    });

    const created = await runtime.controller.setGoal({
      conversationId: "conversation-1",
      source: "inertia-local",
      objective: "Track this locally",
      status: "active",
    });

    expect(created).toMatchObject({
      source: "inertia-local",
      providerSessionId: null,
      objective: "Track this locally",
    });
    expect(runtime.controller.state("conversation-1")).toMatchObject({
      goalCapability: {
        kind: "inertia-local",
        reason: "This provider does not expose a native thread-goal API.",
      },
      skillsCapability: { kind: "claude-native" },
    });
  });

  it("discovers and revalidates Claude SDK skills without exposing paths", async () => {
    const runtime = harness({
      current: conversation({
        providerId: "claude",
        providerSessionId: "claude-session",
        modelSelection: {
          ...conversation().modelSelection,
          harnessId: "claude-agent-sdk",
        },
      }),
      claudeSkills: [{
        name: "security-review",
        description: "Review the repository security posture.",
        argumentHint: "<scope>",
      }],
    });

    const [summary] = await runtime.controller.listSkills(
      "conversation-1",
      false,
    );
    expect(summary).toMatchObject({
      source: "claude-native",
      scope: "provider",
      shortDescription: "<scope>",
    });
    expect(summary).not.toHaveProperty("path");
    await expect(runtime.controller.resolveSkills(
      "conversation-1",
      [summary!.id],
    )).resolves.toEqual([{
      source: "claude-native",
      name: "security-review",
    }]);
  });

  it("coalesces equivalent skill discovery and serializes a stronger reload", async () => {
    let releaseInitial!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    let activeDiscoveries = 0;
    let maximumActiveDiscoveries = 0;
    const runtime = harness({
      current: conversation({
        providerId: "claude",
        providerSessionId: "claude-session",
        modelSelection: {
          ...conversation().modelSelection,
          harnessId: "claude-agent-sdk",
        },
      }),
      claudeSkillsImplementation: async (forceReload) => {
        activeDiscoveries += 1;
        maximumActiveDiscoveries = Math.max(
          maximumActiveDiscoveries,
          activeDiscoveries,
        );
        if (!forceReload) await initialGate;
        activeDiscoveries -= 1;
        return [{
          name: forceReload ? "fresh-skill" : "cached-skill",
          description: "A bounded provider skill.",
          argumentHint: "",
        }];
      },
    });

    const initial = runtime.controller.listSkills("conversation-1", false);
    const coalesced = runtime.controller.listSkills("conversation-1", false);
    const forced = runtime.controller.listSkills("conversation-1", true);
    await vi.waitFor(() =>
      expect(runtime.providers.claudeSkills).toHaveBeenCalledTimes(1));
    releaseInitial();

    await expect(Promise.all([initial, coalesced, forced])).resolves.toEqual([
      [expect.objectContaining({ name: "cached-skill" })],
      [expect.objectContaining({ name: "cached-skill" })],
      [expect.objectContaining({ name: "fresh-skill" })],
    ]);
    expect(runtime.providers.claudeSkills).toHaveBeenCalledTimes(2);
    expect(maximumActiveDiscoveries).toBe(1);
    expect(runtime.controller.state("conversation-1").skills).toEqual([
      expect.objectContaining({ name: "fresh-skill" }),
    ]);
  });

  it("does not publish skills discovered for a replaced provider route", async () => {
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const current = conversation({
      providerId: "claude",
      providerSessionId: "claude-session",
      modelSelection: {
        ...conversation().modelSelection,
        harnessId: "claude-agent-sdk",
      },
    });
    const runtime = harness({
      current,
      claudeSkillsImplementation: async () => {
        await discoveryGate;
        return [{
          name: "old-route-skill",
          description: "This route has already been replaced.",
          argumentHint: "",
        }];
      },
    });

    const pending = runtime.controller.listSkills("conversation-1", false);
    await vi.waitFor(() =>
      expect(runtime.providers.claudeSkills).toHaveBeenCalledTimes(1));
    current.modelSelection = {
      ...current.modelSelection,
      backendConfigurationRevision: 1,
    };
    releaseDiscovery();

    await expect(pending).rejects.toThrow(
      "provider route changed while skills were refreshing",
    );
    expect(runtime.controller.state("conversation-1").skills).toEqual([]);
  });

  it("does not project skill discovery metadata across provider routes", async () => {
    const current = conversation({
      providerId: "claude",
      providerSessionId: "claude-session",
      modelSelection: {
        ...conversation().modelSelection,
        harnessId: "claude-agent-sdk",
      },
    });
    const runtime = harness({
      current,
      claudeSkills: [{
        name: "route-bound",
        description: "Only available on this route.",
        argumentHint: "",
      }],
    });

    await runtime.controller.listSkills("conversation-1", false);
    expect(runtime.controller.state("conversation-1").skillDiscovery)
      .toMatchObject({ synchronizedAt: expect.any(String) });

    current.modelSelection = {
      ...current.modelSelection,
      backendConfigurationRevision: 1,
    };
    expect(runtime.controller.state("conversation-1")).toMatchObject({
      skills: [],
      skillDiscovery: {
        truncated: false,
        warningCount: 0,
        synchronizedAt: null,
      },
    });
  });
});
