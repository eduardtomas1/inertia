import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActivityCenter } from "../../src/renderer/src/components/ActivityCenter";
import * as activityCenterModel from "../../src/renderer/src/utils/activityCenter";
import type {
  Conversation,
  Project,
  WorkspaceRun,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

const project: Project = {
  id: "project-1",
  name: "Inertia",
  path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia",
  repositoryIdentity: null,
  repositoryRoot: "/workspace/inertia",
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 128,
  color: "#5661d8",
  status: "working",
  createdAt: "2026-07-28T08:00:00.000Z",
  updatedAt: "2026-07-28T08:00:00.000Z",
};

const conversation: Conversation = {
  id: "conversation-1",
  projectId: project.id,
  title: "Quota and activity",
  providerId: "codex",
  modelSelection: nativeModelSelection({ providerId: "codex" }),
  continuationIdentity: null,
  model: "",
  reasoningEffort: "",
  interactionMode: "build",
  accessMode: "supervised",
  status: "running",
  attentionKind: null,
  branch: "main",
  worktreePath: null,
  providerSessionId: null,
  archivedAt: null,
  settledAt: null,
  completedAt: null,
  lastViewedAt: null,
  createdAt: "2026-07-28T08:00:00.000Z",
  updatedAt: "2026-07-28T08:00:00.000Z",
};

function run(overrides: Partial<WorkspaceRun>): WorkspaceRun {
  return {
    id: "run-agent",
    kind: "agent",
    projectId: project.id,
    conversationId: conversation.id,
    actionId: null,
    label: "Codex · GPT-5",
    detail: conversation.title,
    status: "running",
    attentionState: "acknowledged",
    canStop: true,
    port: null,
    startedAt: "2026-07-28T08:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("ActivityCenter agent operation disclosure", () => {
  it("owns its elapsed clock only while the activity center is visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-28T08:00:10.000Z");
    const props = {
      runs: [run({})],
      projects: [project],
      conversations: [conversation],
      onClose: vi.fn(),
      onOpenThread: vi.fn(),
      onOpenLocation: vi.fn(),
      onOpenTerminal: vi.fn(),
      onOpenPreview: vi.fn(),
      onStop: vi.fn(),
      onRerun: vi.fn(),
      onMarkSeen: vi.fn(),
      onAcknowledge: vi.fn(),
      onDismiss: vi.fn(),
    };
    const presentation = vi.spyOn(
      activityCenterModel,
      "activityRunPresentation",
    );
    const view = render(<ActivityCenter open {...props} />);

    expect(screen.getByText("Running · 10s")).toBeInTheDocument();
    expect(presentation).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("Running · 11s")).toBeInTheDocument();
    expect(presentation).toHaveBeenCalledTimes(1);

    view.rerender(<ActivityCenter open={false} {...props} />);
    expect(vi.getTimerCount()).toBe(0);
    presentation.mockRestore();
    vi.useRealTimers();
  });

  it("shows only three latest operations until the accessible disclosure opens", async () => {
    const user = userEvent.setup();
    const operations = Array.from({ length: 5 }, (_, index) => run({
      id: `operation-${index + 1}`,
      kind: "check",
      actionId: null,
      label: `Operation ${index + 1}`,
      status: index === 4 ? "running" : "succeeded",
      canStop: false,
      startedAt: `2026-07-28T08:00:0${index + 1}.000Z`,
      finishedAt: index === 4
        ? null
        : `2026-07-28T08:00:0${index + 1}.500Z`,
    }));

    render(
      <ActivityCenter
        open
        now={Date.parse("2026-07-28T08:00:10.000Z")}
        runs={[run({}), ...operations]}
        projects={[project]}
        conversations={[conversation]}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
        onOpenLocation={vi.fn()}
        onOpenTerminal={vi.fn()}
        onOpenPreview={vi.fn()}
        onStop={vi.fn()}
        onRerun={vi.fn()}
        onMarkSeen={vi.fn()}
        onAcknowledge={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByText("Operation 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Operation 2")).not.toBeInTheDocument();
    expect(screen.getByText("Operation 3")).toBeInTheDocument();
    expect(screen.getByText("Operation 5")).toBeInTheDocument();

    const disclosure = screen.getByRole("button", {
      name: "+2 earlier operations",
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Operation 1")).toBeInTheDocument();
    expect(screen.getByText("Operation 2")).toBeInTheDocument();
    expect(screen.getByRole("list", {
      name: "All operations for Codex · GPT-5",
    })).toBeInTheDocument();
  });
});
