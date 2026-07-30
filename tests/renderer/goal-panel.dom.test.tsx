import {
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  GoalPanel,
  type GoalPanelProps,
} from "../../src/renderer/src/components/GoalPanel";
import type {
  AgentGoal,
  AgentPlan,
  AgentSkillSummary,
  AgentTurn,
  AgentWorkflowState,
  SubagentTrace,
} from "../../src/shared/contracts";

function goal(update: Partial<AgentGoal> = {}): AgentGoal {
  return {
    conversationId: "conversation-1",
    source: "codex-native",
    providerSessionId: "thread-1",
    objective: "Ship truthful workflow controls",
    status: "active",
    tokenBudget: 10_000,
    tokensUsed: 2_500,
    timeUsedSeconds: 42,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:42.000Z",
    synchronizedAt: "2030-01-01T00:00:42.000Z",
    ...update,
  };
}

function skill(update: Partial<AgentSkillSummary> = {}): AgentSkillSummary {
  return {
    id: "skill-1",
    conversationId: "conversation-1",
    name: "security-review",
    description: "Review the repository security posture.",
    shortDescription: "Review security posture",
    scope: "repo",
    enabled: true,
    source: "codex-native",
    ...update,
  };
}

function workflow(
  update: Partial<AgentWorkflowState> = {},
): AgentWorkflowState {
  return {
    conversationId: "conversation-1",
    goals: [goal()],
    goalCapability: {
      kind: "codex-native",
      available: true,
      label: "Codex native goal",
    },
    skills: [skill()],
    skillsCapability: {
      kind: "codex-native",
      available: true,
      label: "Codex skills",
    },
    goalRefreshWarning: null,
    skillDiscovery: {
      truncated: false,
      warningCount: 0,
      synchronizedAt: "2030-01-01T00:00:42.000Z",
    },
    refreshedAt: "2030-01-01T00:00:42.000Z",
    ...update,
  };
}

const plan: AgentPlan = {
  conversationId: "conversation-1",
  runId: "run-1",
  turnId: "turn-1",
  explanation: "Make the provider boundaries explicit.",
  steps: [
    { step: "Inspect provider contracts", status: "completed" },
    { step: "Wire truthful controls", status: "inProgress" },
  ],
};

function turn(update: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: "turn-1",
    conversationId: "conversation-1",
    runId: "run-1",
    userMessageId: "message-1",
    terminalAssistantMessageId: null,
    providerId: "claude",
    modelSelection: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:claude",
      backendProfileDisplayName: "Claude",
      backendConfigurationRevision: 0,
      modelId: "sonnet",
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:claude",
      backendConfigurationRevision: 0,
      endpointIdentity: "native:claude",
      modelIdentity: null,
    },
    harnessId: "claude-agent-sdk",
    backendProfileId: "builtin:claude",
    model: "sonnet",
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: "2030-01-01T00:00:00.000Z",
    startedAt: "2030-01-01T00:00:00.000Z",
    completedAt: null,
    status: "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 0,
    association: "authoritative",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...update,
  };
}

function trace(update: Partial<SubagentTrace> = {}): SubagentTrace {
  const status = update.status ?? "running";
  return {
    id: "trace-1",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    providerId: "claude",
    providerTaskId: "task-1",
    providerAgentId: "agent-1",
    parentTraceId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "tool-1",
    providerRole: "researcher",
    providerName: "Audit",
    providerStatus: null,
    status,
    isLive: update.isLive ?? [
      "queued", "spawned", "running", "waiting",
    ].includes(status),
    description: "Inspect provider boundaries",
    progress: "Reading capability contracts",
    result: null,
    sequence: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:10.000Z",
    ...update,
  };
}

function renderPanel(props: Partial<GoalPanelProps> = {}): void {
  render(
    <GoalPanel
      workflow={workflow()}
      plan={plan}
      subagents={[trace()]}
      turns={[turn()]}
      now={Date.parse("2030-01-01T00:00:42.000Z")}
      {...props}
    />,
  );
}

describe("GoalPanel", () => {
  it("renders authoritative goal progress and its current plan relationship", () => {
    renderPanel();

    expect(screen.getByText("Codex native")).toBeInTheDocument();
    expect(screen.getByText("Ship truthful workflow controls")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", {
      name: "Goal token budget used",
    })).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("1 of 2 plan steps complete")).toBeInTheDocument();
    expect(screen.getByText("Wire truthful controls")).toBeInTheDocument();
    expect(screen.getByText(
      "Latest conversation plan · not linked to this goal",
    )).toBeInTheDocument();
  });

  it("labels local goals as Inertia-owned and never implies provider injection", () => {
    renderPanel({
      workflow: workflow({
        goals: [],
        goalCapability: {
          kind: "inertia-local",
          available: true,
          label: "Inertia local goal",
          reason: "This provider does not expose native goals.",
        },
        skills: [],
        skillsCapability: {
          kind: "unavailable",
          available: false,
          label: "Skills unavailable",
          reason: "This route does not expose structured skill input.",
        },
      }),
      onSetGoal: vi.fn(),
    });

    expect(screen.getByText(
      "Tracked by Inertia only; it is not injected into the provider.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "This route does not expose structured skill input.",
    )).toBeInTheDocument();
  });

  it("keeps local goals and skills visible when native refresh degrades", () => {
    const refreshWarning =
      "Codex native goal could not be refreshed. Showing saved goal data; local goals and skills remain available.";
    renderPanel({
      workflow: workflow({
        goals: [goal({
          source: "inertia-local",
          providerSessionId: null,
          objective: "Keep local evidence visible",
          synchronizedAt: null,
        })],
        goalRefreshWarning: refreshWarning,
      }),
    });

    expect(screen.getByText(refreshWarning)).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByText("Keep local evidence visible"))
      .toBeInTheDocument();
    expect(screen.getByText("security-review")).toBeInTheDocument();
  });

  it("creates, resumes, completes and clears only through explicit callbacks", async () => {
    const user = userEvent.setup();
    const onSetGoal = vi.fn(async () => undefined);
    const onClearGoal = vi.fn();
    const view = render(
      <GoalPanel
        workflow={workflow({
          goals: [],
          goalCapability: {
            kind: "inertia-local",
            available: true,
            label: "Inertia local goal",
            reason: "Provider does not expose native goals.",
          },
        })}
        plan={null}
        subagents={[]}
        turns={[]}
        onSetGoal={onSetGoal}
        onClearGoal={onClearGoal}
      />,
    );

    await user.type(screen.getByLabelText("Objective"), "  Keep the route honest  ");
    await user.click(screen.getByRole("button", {
      name: "Create inertia local goal",
    }));
    expect(onSetGoal).toHaveBeenCalledWith({
      source: "inertia-local",
      objective: "Keep the route honest",
      status: "active",
      tokenBudget: null,
    });

    view.rerender(
      <GoalPanel
        workflow={workflow({ goals: [goal({ status: "paused" })] })}
        plan={null}
        subagents={[]}
        turns={[]}
        onSetGoal={onSetGoal}
        onClearGoal={onClearGoal}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mark active" }));
    expect(onSetGoal).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "active",
    }));
    await user.click(screen.getByRole("button", {
      name: "Clear codex native goal",
    }));
    expect(onClearGoal).toHaveBeenCalledWith(expect.objectContaining({
      source: "codex-native",
    }));
  });

  it("selects only enabled discovered skills through the supplied callback", async () => {
    const user = userEvent.setup();
    const onToggleSkill = vi.fn();
    renderPanel({
      workflow: workflow({
        skills: [
          skill(),
          skill({
            id: "skill-2",
            name: "disabled-skill",
            enabled: false,
          }),
        ],
      }),
      selectedSkillIds: ["skill-1"],
      onToggleSkill,
    });

    const selected = screen.getByRole("button", {
      name: /security-review/i,
    });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    await user.click(selected);
    expect(onToggleSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "skill-1" }),
      false,
    );
    expect(screen.getByRole("button", {
      name: /disabled-skill/i,
    })).toBeDisabled();
  });

  it("shows provider-aware delegated actions without inventing direct controls", async () => {
    const user = userEvent.setup();
    const onStopSubagent = vi.fn();
    const onFollowUpSubagent = vi.fn();
    const claude = trace();
    const codex = trace({
      id: "trace-2",
      providerId: "codex",
      providerTaskId: "task-2",
      providerAgentId: "agent-2",
      providerName: "Codex audit",
    });
    renderPanel({
      subagents: [claude, codex],
      onStopSubagent,
      canFollowUpSubagent: (item) => item.providerId === "codex",
      onFollowUpSubagent,
    });

    expect(screen.getByRole("button", {
      name: "Stop Audit",
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Stop Codex audit",
    })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", {
      name: "Guide parent about Codex audit",
    }));
    expect(onFollowUpSubagent).toHaveBeenCalledWith(codex);
    await user.click(screen.getByRole("button", { name: "Stop Audit" }));
    expect(onStopSubagent).toHaveBeenCalledWith(claude);
  });

  it("keeps old successful delegated work behind a bounded disclosure", async () => {
    const user = userEvent.setup();
    const old = Array.from({ length: 8 }, (_, index) => trace({
      id: `trace-${index}`,
      providerTaskId: `task-${index}`,
      providerAgentId: `agent-${index}`,
      providerName: `Completed ${index}`,
      status: "completed",
      createdAt: `2030-01-01T00:00:0${index}.000Z`,
      updatedAt: `2030-01-01T00:00:1${index}.000Z`,
    }));
    renderPanel({ subagents: old });

    expect(screen.queryByText("Completed 0")).not.toBeInTheDocument();
    expect(screen.getByText("Completed 7")).toBeInTheDocument();
    const disclosure = screen.getByRole("button", {
      name: "Show 2 earlier delegated tasks",
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);
    expect(screen.getByText("Completed 0")).toBeInTheDocument();
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
  });

  it("surfaces bounded provider skill discovery quality without leaking details", () => {
    renderPanel({
      workflow: workflow({
        skillDiscovery: {
          truncated: true,
          warningCount: 2,
          synchronizedAt: "2030-01-01T00:00:42.000Z",
        },
      }),
    });

    expect(screen.getByText(
      "Showing the first 128 provider-reported skills.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Skill discovery reported 2 discovery warnings.",
    )).toBeInTheDocument();
  });

  it("uses instance-scoped relationships when two workflow panels are visible", () => {
    const { container } = render(
      <>
        <GoalPanel
          workflow={workflow()}
          plan={plan}
          subagents={[trace()]}
          turns={[turn()]}
        />
        <GoalPanel
          workflow={workflow({ conversationId: "conversation-2" })}
          plan={null}
          subagents={[]}
          turns={[]}
        />
      </>,
    );

    const ids = [...container.querySelectorAll<HTMLElement>("[id]")]
      .map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of container.querySelectorAll<HTMLElement>(
      "section[aria-labelledby]",
    )) {
      const headingId = section.getAttribute("aria-labelledby");
      expect(headingId).not.toBeNull();
      expect(container.ownerDocument.getElementById(headingId ?? ""))
        .not.toBeNull();
    }
  });

  it("surfaces workflow load failures and retries them explicitly", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn(async () => undefined);
    renderPanel({
      workflow: null,
      error: "The workflow service did not respond.",
      onRetry,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The workflow service did not respond.",
    );
    expect(screen.getByText("Agent workflow could not be loaded."))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("preserves a goal draft after rejection and clears it after success", async () => {
    const user = userEvent.setup();
    const rejected = vi.fn(async () => {
      throw new Error("Goal rejected");
    });
    const accepted = vi.fn(async () => undefined);
    const view = render(
      <GoalPanel
        workflow={workflow({
          goals: [],
          goalCapability: {
            kind: "inertia-local",
            available: true,
            label: "Inertia local goal",
            reason: "Provider does not expose native goals.",
          },
        })}
        plan={null}
        subagents={[]}
        turns={[]}
        onSetGoal={rejected}
      />,
    );
    const objective = screen.getByLabelText("Objective");
    await user.type(objective, "Keep this draft");
    await user.click(screen.getByRole("button", {
      name: "Create inertia local goal",
    }));
    await waitFor(() => expect(rejected).toHaveBeenCalledOnce());
    expect(objective).toHaveValue("Keep this draft");

    view.rerender(
      <GoalPanel
        workflow={workflow({
          goals: [],
          goalCapability: {
            kind: "inertia-local",
            available: true,
            label: "Inertia local goal",
            reason: "Provider does not expose native goals.",
          },
        })}
        plan={null}
        subagents={[]}
        turns={[]}
        onSetGoal={accepted}
      />,
    );
    await user.click(screen.getByRole("button", {
      name: "Create inertia local goal",
    }));
    await waitFor(() => expect(objective).toHaveValue(""));
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({
      objective: "Keep this draft",
    }));
  });

  it("enforces and explains the eight-skill per-turn limit", () => {
    const skills = Array.from({ length: 9 }, (_, index) => skill({
      id: `skill-${index}`,
      name: `skill-${index}`,
    }));
    renderPanel({
      workflow: workflow({ skills }),
      selectedSkillIds: skills.slice(0, 8).map(({ id }) => id),
      onToggleSkill: vi.fn(),
    });

    expect(screen.getByRole("button", { name: /skill-8/i })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Maximum 8 skills selected for one turn.",
    );
  });

  it("keeps compact delegated work bounded while preserving ancestors", () => {
    const parent = trace({
      id: "parent",
      providerTaskId: "parent-task",
      providerAgentId: "parent-agent",
      providerName: "Older parent",
      status: "completed",
      sequence: 1,
    });
    const child = trace({
      id: "recent-child",
      providerTaskId: "child-task",
      providerAgentId: "child-agent",
      parentTraceId: parent.id,
      providerName: "Recent child",
      status: "completed",
      sequence: 15,
    });
    const fillers = Array.from({ length: 13 }, (_, index) => trace({
      id: `filler-${index}`,
      providerTaskId: `filler-task-${index}`,
      providerAgentId: `filler-agent-${index}`,
      providerName: `Filler ${index}`,
      status: "completed",
      sequence: index + 2,
    }));
    renderPanel({ subagents: [parent, ...fillers, child] });

    expect(screen.getByText("Recent child")).toBeInTheDocument();
    expect(screen.getByText("Older parent")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Delegated agent tree" }).children)
      .toHaveLength(6);
  });

  it("keeps a deep live leaf visible with explicit omitted ancestor context", () => {
    const deep = Array.from({ length: 8 }, (_, index) => trace({
      id: `deep-${index}`,
      providerTaskId: `deep-task-${index}`,
      providerAgentId: `deep-agent-${index}`,
      parentTraceId: index === 0 ? null : `deep-${index - 1}`,
      providerName: `Deep ${index}`,
      status: "running",
      sequence: index + 1,
    }));
    renderPanel({ subagents: deep });

    expect(screen.getByText("Deep 7")).toBeInTheDocument();
    expect(screen.queryByText("Deep 0")).not.toBeInTheDocument();
    expect(screen.getByText("2 earlier ancestors compacted"))
      .toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Delegated agent tree" }).children)
      .toHaveLength(6);
  });

  it("reserves compact space for competing live branches", () => {
    const chain = (prefix: string, sequenceOffset: number) =>
      Array.from({ length: 5 }, (_, index) => trace({
        id: `${prefix}-${index}`,
        providerTaskId: `${prefix}-task-${index}`,
        providerAgentId: `${prefix}-agent-${index}`,
        parentTraceId: index === 0 ? null : `${prefix}-${index - 1}`,
        providerName: `${prefix} ${index}`,
        status: "running",
        sequence: sequenceOffset + index,
      }));
    renderPanel({
      subagents: [
        ...chain("Branch A", 1),
        ...chain("Branch B", 6),
      ],
    });

    expect(screen.getByText("Branch A 4")).toBeInTheDocument();
    expect(screen.getByText("Branch B 4")).toBeInTheDocument();
    expect(screen.getAllByText("2 earlier ancestors compacted")).toHaveLength(2);
    expect(screen.getByRole("list", { name: "Delegated agent tree" }).children)
      .toHaveLength(6);
  });

  it("collapses delegated history again when the conversation changes", async () => {
    const user = userEvent.setup();
    const old = Array.from({ length: 8 }, (_, index) => trace({
      id: `trace-${index}`,
      providerTaskId: `task-${index}`,
      providerAgentId: `agent-${index}`,
      providerName: `Completed ${index}`,
      status: "completed",
      sequence: index,
    }));
    const view = render(
      <GoalPanel
        workflow={workflow()}
        plan={null}
        subagents={old}
        turns={[]}
      />,
    );
    await user.click(screen.getByRole("button", {
      name: "Show 2 earlier delegated tasks",
    }));
    expect(screen.getByText("Completed 0")).toBeInTheDocument();

    view.rerender(
      <GoalPanel
        workflow={workflow({ conversationId: "conversation-2" })}
        plan={null}
        subagents={old.map((item) => ({
          ...item,
          conversationId: "conversation-2",
        }))}
        turns={[]}
      />,
    );
    expect(screen.queryByText("Completed 0")).not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Show 2 earlier delegated tasks",
    })).toHaveAttribute("aria-expanded", "false");
  });
});
