import { describe, expect, it, vi } from "vitest";

import { MAX_AGENT_PLAN_STEPS } from "../../src/shared/agent-plan";
import type { AgentPlan, SubagentTrace } from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import type {
  ProviderActivityEvent,
  ProviderSubagentEvent,
} from "../../src/server/provider/contracts";
import { defaultTurnScheduler } from "../../src/server/runtime/turns/turn-controller-support";
import {
  TurnProviderEventProjector,
} from "../../src/server/runtime/turns/turn-provider-event-projector";
import type {
  ActiveTurn,
  TurnControllerHooks,
} from "../../src/server/runtime/turns/turn-controller-types";

function event(
  sequence: number,
  providerStatus: string,
  status: ProviderSubagentEvent["status"],
  isLive: boolean,
): ProviderSubagentEvent {
  return {
    providerId: "codex",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    type: "subagent",
    sequence,
    providerTaskId: null,
    providerAgentId: "child-1",
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "spawn-1",
    providerRole: "reviewer",
    providerName: "State reviewer",
    providerStatus,
    status,
    isLive,
    description: "Preserve exact state.",
    progress: null,
    result: status === "interrupted" ? "Provider interrupted the child." : null,
  };
}

describe("TurnProviderEventProjector delegated-agent state", () => {
  it("persists and broadcasts exact queued and interrupted provider states", () => {
    const upsertSubagentTrace = vi.fn((
      input: Parameters<RuntimeStore["upsertSubagentTrace"]>[0],
    ) => ({
      changed: true,
      trace: {
        ...input,
        id: "trace-1",
        parentTraceId: null,
        providerStatus: input.providerStatus ?? null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:01.000Z",
      } as SubagentTrace,
    }));
    const broadcast = vi.fn();
    const projector = new TurnProviderEventProjector({
      store: { upsertSubagentTrace } as unknown as RuntimeStore,
      hooks: {
        broadcast,
        broadcastSnapshot: vi.fn(),
      } as unknown as TurnControllerHooks,
      agentPlans: new Map(),
      streams: {} as never,
      activities: {} as never,
      interactions: {} as never,
      scheduler: defaultTurnScheduler(),
      now: () => "2030-01-01T00:00:01.000Z",
      transition: () => false,
      observeSubagent: () => false,
    });
    const active = {
      conversation: { id: "conversation-1" },
      turn: {
        id: "turn-1",
        runId: "run-1",
        providerId: "codex",
      },
    } as ActiveTurn;

    projector.project(active, event(1, "pendingInit", "queued", true));
    projector.project(active, event(2, "interrupted", "interrupted", false));

    expect(upsertSubagentTrace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerStatus: "pendingInit",
        status: "queued",
        isLive: true,
      }),
    );
    expect(upsertSubagentTrace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerStatus: "interrupted",
        status: "interrupted",
        isLive: false,
      }),
    );
    expect(broadcast).toHaveBeenLastCalledWith({
      type: "agent.subagent.updated",
      trace: expect.objectContaining({
        providerStatus: "interrupted",
        status: "interrupted",
      }),
    });
  });

  it("does not feed a rejected late descendant revival into run state", () => {
    const terminalTrace = {
      ...event(2, "interrupted", "interrupted", false),
      id: "trace-1",
      parentTraceId: null,
      providerStatus: "interrupted",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:01.000Z",
    } as SubagentTrace;
    const observeSubagent = vi.fn();
    const broadcast = vi.fn();
    const projector = new TurnProviderEventProjector({
      store: {
        upsertSubagentTrace: vi.fn(() => ({
          changed: false,
          trace: terminalTrace,
        })),
      } as unknown as RuntimeStore,
      hooks: {
        broadcast,
        broadcastSnapshot: vi.fn(),
      } as unknown as TurnControllerHooks,
      agentPlans: new Map(),
      streams: {} as never,
      activities: {} as never,
      interactions: {} as never,
      scheduler: defaultTurnScheduler(),
      now: () => "2030-01-01T00:00:02.000Z",
      transition: () => false,
      observeSubagent,
    });
    const active = {
      conversation: { id: "conversation-1" },
      turn: {
        id: "turn-1",
        runId: "run-1",
        providerId: "codex",
      },
    } as ActiveTurn;

    projector.project(active, event(3, "running", "running", true));

    expect(broadcast).not.toHaveBeenCalled();
    expect(observeSubagent).not.toHaveBeenCalled();
  });
});

describe("TurnProviderEventProjector reasoning order", () => {
  it("lands buffered reasoning before events that end thinking, not before thinking progress", () => {
    const calls: string[] = [];
    const base = {
      providerId: "claude" as const,
      conversationId: "conversation-1",
      runId: "run-1",
      turnId: "turn-1",
    };
    const activity = (
      kind: ProviderActivityEvent["kind"],
      phase: ProviderActivityEvent["phase"],
    ): ProviderActivityEvent => ({
      ...base,
      type: "activity",
      kind,
      phase,
      label: `${kind} ${phase}`,
      activityId: `${kind}-activity`,
    });
    const projector = new TurnProviderEventProjector({
      store: {
        upsertAgentPlan: vi.fn(() => calls.push("persist-plan")),
      } as unknown as RuntimeStore,
      hooks: {
        broadcast: vi.fn((message: { type: string }) => calls.push(message.type)),
        broadcastConversationShell: vi.fn(),
        broadcastSnapshot: vi.fn(),
      } as unknown as TurnControllerHooks,
      agentPlans: new Map(),
      streams: {
        closeAssistantSegment: vi.fn(() => {
          calls.push("close-assistant");
          return false;
        }),
        flush: vi.fn((_active: ActiveTurn, kind: string) => {
          calls.push(`flush-${kind}`);
          return true;
        }),
      } as never,
      activities: {
        record: vi.fn((_active: ActiveTurn, value: ProviderActivityEvent) => ({
          activity: { id: value.activityId },
          runsChanged: false,
        })),
        flushPending: vi.fn(() => calls.push("flush-activities")),
      } as never,
      interactions: {} as never,
      scheduler: defaultTurnScheduler(),
      now: () => "2030-01-01T00:00:01.000Z",
      transition: () => false,
      observeSubagent: () => false,
    });
    const active = {
      conversation: { id: "conversation-1" },
      turn: { id: "turn-1", runId: "run-1", providerId: "claude" },
    } as ActiveTurn;

    projector.project(active, activity("reasoning", "started"));
    projector.project(active, activity("reasoning", "started"));
    expect(calls).toEqual([
      "close-assistant",
      "agent.activity",
      "close-assistant",
      "agent.activity",
    ]);

    calls.length = 0;
    projector.project(active, activity("tool", "started"));
    projector.project(active, activity("reasoning", "completed"));
    projector.project(active, {
      ...base,
      type: "plan",
      explanation: null,
      steps: [{ step: "Verify ordering", status: "inProgress" }],
    });
    expect(calls).toEqual([
      "close-assistant",
      "flush-reasoning",
      "agent.activity",
      "close-assistant",
      "flush-reasoning",
      "agent.activity",
      "close-assistant",
      "flush-reasoning",
      "flush-activities",
      "persist-plan",
      "agent.plan.updated",
    ]);
  });
});

describe("TurnProviderEventProjector plan updates", () => {
  function planProjector() {
    const upsertAgentPlan = vi.fn();
    const broadcast = vi.fn();
    const agentPlans = new Map<string, AgentPlan>();
    const projector = new TurnProviderEventProjector({
      store: { upsertAgentPlan } as unknown as RuntimeStore,
      hooks: {
        broadcast,
        broadcastConversationShell: vi.fn(),
        broadcastSnapshot: vi.fn(),
      } as unknown as TurnControllerHooks,
      agentPlans,
      streams: {
        closeAssistantSegment: vi.fn(() => false),
        flush: vi.fn(() => true),
      } as never,
      activities: { flushPending: vi.fn() } as never,
      interactions: {} as never,
      scheduler: defaultTurnScheduler(),
      now: () => "2030-01-01T00:00:01.000Z",
      transition: () => false,
      observeSubagent: () => false,
    });
    const active = {
      conversation: { id: "conversation-1" },
      turn: { id: "turn-1", runId: "run-1", providerId: "cursor" },
    } as ActiveTurn;
    const plan = (
      explanation: string | null,
      steps: AgentPlan["steps"],
    ) => projector.project(active, {
      providerId: "cursor",
      conversationId: "conversation-1",
      runId: "run-1",
      turnId: "turn-1",
      type: "plan",
      explanation,
      steps,
    });
    return { plan, upsertAgentPlan, broadcast, agentPlans, active, projector };
  }

  it("keeps the plan document when a checklist update arrives without one", () => {
    const { plan, upsertAgentPlan, broadcast } = planProjector();
    plan("# Plan\n- Inspect\n- Ship", [
      { step: "Inspect", status: "pending" },
      { step: "Ship", status: "pending" },
    ]);
    plan(null, [
      { step: "Inspect", status: "completed" },
      { step: "Ship", status: "inProgress" },
    ]);

    const expected = {
      conversationId: "conversation-1",
      runId: "run-1",
      turnId: "turn-1",
      explanation: "# Plan\n- Inspect\n- Ship",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Ship", status: "inProgress" },
      ],
    };
    expect(upsertAgentPlan).toHaveBeenLastCalledWith(expected);
    expect(broadcast).toHaveBeenLastCalledWith({ type: "agent.plan.updated", plan: expected });
  });

  it("keeps reported step statuses when a document arrives without steps", () => {
    const { plan, upsertAgentPlan } = planProjector();
    plan(null, [{ step: "Inspect", status: "completed" }]);
    plan("Review the final diff.", []);

    expect(upsertAgentPlan).toHaveBeenLastCalledWith(expect.objectContaining({
      explanation: "Review the final diff.",
      steps: [{ step: "Inspect", status: "completed" }],
    }));
  });

  it("clears the steps when the provider reports an empty checklist", () => {
    const { plan, upsertAgentPlan } = planProjector();
    plan("# Plan", [{ step: "Inspect", status: "completed" }]);
    plan(null, []);

    expect(upsertAgentPlan).toHaveBeenLastCalledWith(expect.objectContaining({
      explanation: "# Plan",
      steps: [],
    }));
  });

  it("clears the document when the provider removes the plan", () => {
    const { plan, upsertAgentPlan, broadcast } = planProjector();
    plan("# Plan", [{ step: "Inspect", status: "completed" }]);
    plan("", []);

    const expected = expect.objectContaining({ explanation: null, steps: [] });
    expect(upsertAgentPlan).toHaveBeenLastCalledWith(expected);
    expect(broadcast).toHaveBeenLastCalledWith({ type: "agent.plan.updated", plan: expected });
  });

  it("stores and broadcasts the same bounded checklist", () => {
    const { plan, upsertAgentPlan, broadcast, agentPlans } = planProjector();
    const steps = Array.from({ length: 80 }, (_, index) => ({ step: `Step ${index + 1}`, status: "pending" as const }));
    plan(null, steps);

    const live = agentPlans.get("conversation-1")!;
    expect(live.steps).toEqual(steps.slice(0, MAX_AGENT_PLAN_STEPS));
    expect(upsertAgentPlan).toHaveBeenLastCalledWith(live);
    expect(broadcast).toHaveBeenLastCalledWith({ type: "agent.plan.updated", plan: live });
  });

  it("does not carry a plan from another run into a new one", () => {
    const { plan, upsertAgentPlan, agentPlans } = planProjector();
    agentPlans.set("conversation-1", {
      conversationId: "conversation-1",
      runId: "run-0",
      turnId: "turn-0",
      explanation: "# Earlier plan",
      steps: [{ step: "Earlier", status: "pending" }],
    });
    plan(null, [{ step: "Inspect", status: "inProgress" }]);

    expect(upsertAgentPlan).toHaveBeenLastCalledWith(expect.objectContaining({
      runId: "run-1",
      explanation: null,
      steps: [{ step: "Inspect", status: "inProgress" }],
    }));
  });
});

describe("TurnProviderEventProjector read-only watcher turns", () => {
  function watcherProjector(readOnly: boolean) {
    const interactions = {
      openApproval: vi.fn(),
      denyForReadOnly: vi.fn(),
      openInput: vi.fn(),
      stopForReadOnly: vi.fn(),
    };
    const broadcast = vi.fn();
    const projector = new TurnProviderEventProjector({
      store: {} as RuntimeStore,
      hooks: { broadcast, broadcastSnapshot: vi.fn() } as unknown as TurnControllerHooks,
      agentPlans: new Map(),
      streams: { closeAssistantSegment: vi.fn(), flush: vi.fn() } as never,
      activities: {
        flushPending: vi.fn(),
        record: vi.fn(() => ({ activity: { id: "activity-1" }, runsChanged: false })),
      } as never,
      interactions: interactions as never,
      scheduler: defaultTurnScheduler(),
      now: () => "2030-01-01T00:00:01.000Z",
      transition: () => false,
      observeSubagent: () => false,
    });
    const active = {
      conversation: { id: "conversation-1" },
      turn: { id: "turn-1", runId: "run-1", providerId: "codex" },
      ...(readOnly ? { readOnlyWatcher: { linkId: "link-1", wakeId: "wake-1", deniedApprovals: 0 } } : {}),
    } as ActiveTurn;
    const identity = { providerId: "codex" as const, conversationId: "conversation-1", runId: "run-1", turnId: "turn-1" };
    const activity = (kind: ProviderActivityEvent["kind"], label: string, phase: ProviderActivityEvent["phase"] = "started") => {
      projector.project(active, { ...identity, type: "activity", kind, phase, label });
    };
    return { active, activity, broadcast, identity, interactions, projector };
  }

  it("declines approvals and stops on questions without opening a card", () => {
    const { active, identity, interactions, projector } = watcherProjector(true);
    const request = {
      requestId: "approval-1", kind: "command" as const, title: "Run tests",
      permissionRoots: [], availableDecisions: ["approve" as const, "deny" as const],
    };
    projector.project(active, { ...identity, type: "approval", request });
    projector.project(active, {
      ...identity,
      type: "input",
      request: { requestId: "input-1", questions: [{ id: "q", header: "", question: "Which file?", options: [] }] },
    } as never);

    expect(interactions.denyForReadOnly).toHaveBeenCalledWith(active, request);
    expect(interactions.openApproval).not.toHaveBeenCalled();
    expect(interactions.openInput).not.toHaveBeenCalled();
    expect(interactions.stopForReadOnly).toHaveBeenCalledWith(active, "input", "Which file?");
  });

  it("stops on a started write but not on commands, reads or settled writes", () => {
    const { active, activity, broadcast, interactions } = watcherProjector(true);
    activity("command", "rg TODO src");
    activity("tool", "Read src/export.ts");
    activity("tool", "Edit", "completed");
    expect(interactions.stopForReadOnly).not.toHaveBeenCalled();

    activity("tool", "File change");
    activity("tool", "Write");
    expect(interactions.stopForReadOnly).toHaveBeenNthCalledWith(1, active, "write-attempt", "File change");
    expect(interactions.stopForReadOnly).toHaveBeenNthCalledWith(2, active, "write-attempt", "Write");
    expect(broadcast).toHaveBeenCalledWith({ type: "agent.activity", activity: { id: "activity-1" } });
  });

  it("leaves ordinary turns on the normal approval and activity paths", () => {
    const { active, activity, identity, interactions, projector } = watcherProjector(false);
    activity("tool", "Edit");
    const request = {
      requestId: "approval-1", kind: "file-change" as const, title: "Edit",
      permissionRoots: [], availableDecisions: ["approve" as const, "deny" as const],
    };
    projector.project(active, { ...identity, type: "approval", request });
    expect(interactions.openApproval).toHaveBeenCalledWith(active, request);
    expect(interactions.denyForReadOnly).not.toHaveBeenCalled();
    expect(interactions.stopForReadOnly).not.toHaveBeenCalled();
  });
});
