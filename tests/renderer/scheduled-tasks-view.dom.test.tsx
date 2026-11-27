import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ScheduledTasksView,
  type ScheduledTasksViewProps,
} from "../../src/renderer/src/components/ScheduledTasksView";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { ServerEvent } from "../../src/shared/contracts";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskSummary,
} from "../../src/shared/scheduled-tasks";
import {
  conversation,
  conversationId,
  firstProjectId,
  ok,
  secondProjectId,
  sent,
  snapshot,
  stamp,
} from "./tasks-fixtures";

const taskOneId = "10000000-0000-4000-8000-000000000001";
const taskTwoId = "20000000-0000-4000-8000-000000000002";
const runOneId = "30000000-0000-4000-8000-000000000001";
const runTwoId = "40000000-0000-4000-8000-000000000002";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: taskOneId,
    projectId: firstProjectId,
    title: "Morning repo check",
    prompt: "Check CI status and summarize failures.",
    schedule: { type: "interval", everyMs: 1_800_000 },
    boundConversationId: null,
    freshSession: false,
    modelSelection: null,
    interactionMode: "build",
    accessMode: "supervised",
    enabled: true,
    nextRunAt: "2026-10-12T09:30:00.000Z",
    lastRunAt: "2026-10-12T09:00:00.000Z",
    lastRunStatus: "completed",
    lastConversationId: conversationId,
    lastTurnId: "turn-1",
    lastError: null,
    consecutiveFailures: 0,
    createdBy: "user",
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function makeRun(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  return {
    id: runOneId,
    taskId: taskOneId,
    claimKey: "claim-1",
    trigger: "schedule",
    scheduledFor: "2026-10-12T09:00:00.000Z",
    state: "completed",
    conversationId,
    turnId: "turn-1",
    queueItemId: null,
    error: null,
    claimedAt: "2026-10-12T09:00:00.000Z",
    finishedAt: "2026-10-12T09:01:00.000Z",
    ...overrides,
  };
}

function listResult(tasks: ScheduledTaskSummary[]): ServerEvent {
  return {
    type: "request.result",
    requestId: "req-list",
    result: { kind: "scheduled-tasks.list", tasks },
  };
}

function taskResult(task: ScheduledTask, recentRuns: ScheduledTaskRun[] = []): ServerEvent {
  return {
    type: "request.result",
    requestId: "req-task",
    result: { kind: "scheduled-task", task, recentRuns },
  };
}

type RequestFn = (command: CommandWithoutId, options?: { passive?: boolean }) => Promise<ServerEvent>;

function mountView(
  initialTasks: ScheduledTaskSummary[],
  overrides: Partial<ScheduledTasksViewProps> = {},
) {
  const defaultSnapshot = snapshot([], {
    conversations: [conversation({ id: conversationId, projectId: firstProjectId, title: "Daily ops thread" })],
  });
  const request = vi.fn<RequestFn>(async (command) => {
    if (command.type === "scheduled-task.list") {
      return listResult(initialTasks);
    }
    if (command.type === "scheduled-task.create") {
      return taskResult(makeTask({
        id: taskTwoId,
        projectId: command.payload.projectId,
        title: command.payload.title,
        prompt: command.payload.prompt,
        schedule: command.payload.schedule,
        boundConversationId: command.payload.boundConversationId ?? null,
        freshSession: command.payload.freshSession ?? false,
        accessMode: command.payload.accessMode ?? "supervised",
        interactionMode: command.payload.interactionMode ?? "build",
        lastConversationId: null,
        lastRunAt: null,
        lastRunStatus: null,
      }));
    }
    if (command.type === "scheduled-task.update") {
      const existing = initialTasks.find((entry) => entry.task.id === command.payload.taskId)?.task ?? makeTask();
      return taskResult({ ...existing, ...command.payload.patch });
    }
    if (command.type === "scheduled-task.run-now") {
      const existing = initialTasks.find((entry) => entry.task.id === command.payload.taskId)?.task ?? makeTask();
      const manualRun = makeRun({ id: runTwoId, trigger: "manual", state: "running" });
      return {
        type: "request.result",
        requestId: "req-run",
        result: {
          kind: "scheduled-task.ran",
          task: { ...existing, lastRunStatus: "running", lastConversationId: conversationId },
          run: manualRun,
          conversationId,
        },
      };
    }
    return ok();
  });
  const onOpenConversation = vi.fn();
  const onError = vi.fn();
  const props: ScheduledTasksViewProps = {
    snapshot: defaultSnapshot,
    status: "online",
    projectScopeId: null,
    refreshNonce: 0,
    request,
    onOpenConversation,
    onError,
    ...overrides,
  };
  const view = render(<ScheduledTasksView {...props} />);
  return {
    ...view,
    request: (overrides.request ?? request) as ReturnType<typeof vi.fn<RequestFn>>,
    onOpenConversation,
    onError,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScheduledTasksView", () => {
  it("loads and renders scheduled tasks from scheduled-task.list", async () => {
    const { request, onOpenConversation } = mountView([
      { task: makeTask(), recentRuns: [makeRun()] },
    ], { projectScopeId: firstProjectId });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Morning repo check" })).toBeVisible();
    });

    expect(sent(request, "scheduled-task.list")).toEqual([
      { type: "scheduled-task.list", payload: { projectId: firstProjectId } },
    ]);
    expect(screen.getByText("Every 30 minutes")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.getByText("Inertia")).toBeVisible();
    expect(
      screen.getByText("Schedules run locally while Inertia is open. Missed recurring runs are skipped on startup."),
    ).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open latest chat" }));
    expect(onOpenConversation).toHaveBeenCalledWith(expect.objectContaining({ id: conversationId }));
  });

  it("creates an interval task, a fixed-time weekday task, and a one-shot task", async () => {
    const user = userEvent.setup();
    const { request } = mountView([]);

    await waitFor(() => {
      expect(screen.getByText("No scheduled tasks yet")).toBeVisible();
    });

    // 1. Interval task
    await user.click(screen.getByRole("button", { name: "New schedule" }));
    await user.type(screen.getByLabelText("Title"), "Hourly health check");
    await user.type(screen.getByLabelText("Prompt"), "Verify local health checks.");
    await user.clear(screen.getByLabelText("Every"));
    await user.type(screen.getByLabelText("Every"), "2");
    await user.selectOptions(screen.getByLabelText("Unit"), "hours");
    await user.selectOptions(screen.getByLabelText("Thread target"), "shared-fresh");
    await user.selectOptions(screen.getByLabelText("Access mode"), "auto-edit");
    await user.selectOptions(screen.getByLabelText("Interaction mode"), "plan");
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => {
      expect(sent(request, "scheduled-task.create")).toHaveLength(1);
    });
    expect(sent(request, "scheduled-task.create")[0]?.payload).toEqual({
      projectId: firstProjectId,
      title: "Hourly health check",
      prompt: "Verify local health checks.",
      schedule: { type: "interval", everyMs: 7_200_000 },
      boundConversationId: null,
      freshSession: true,
      accessMode: "auto-edit",
      interactionMode: "plan",
    });

    // 2. Fixed-time weekday task
    await user.click(screen.getByRole("button", { name: "New schedule" }));
    await user.selectOptions(screen.getByLabelText("Project"), secondProjectId);
    await user.type(screen.getByLabelText("Title"), "Weekday standup prep");
    await user.type(screen.getByLabelText("Prompt"), "Summarize yesterday commits.");
    await user.click(screen.getByRole("radio", { name: "Daily" }));
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "08:30" } });
    await user.click(screen.getByRole("button", { name: "Weekdays" }));
    await user.click(screen.getByRole("button", { name: "Friday" }));
    expect(screen.getByRole("button", { name: "Friday" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => {
      expect(sent(request, "scheduled-task.create")).toHaveLength(2);
    });
    expect(sent(request, "scheduled-task.create")[1]?.payload).toMatchObject({
      projectId: secondProjectId,
      title: "Weekday standup prep",
      schedule: { type: "fixed_time", timeOfDay: "08:30", weekdays: [1, 2, 3, 4] },
    });

    // 3. One-shot task
    await user.click(screen.getByRole("button", { name: "New schedule" }));
    await user.type(screen.getByLabelText("Title"), "Release cutover");
    await user.type(screen.getByLabelText("Prompt"), "Run release verification checklist.");
    await user.click(screen.getByRole("radio", { name: "Once" }));
    fireEvent.change(screen.getByLabelText("Run at (local time)"), {
      target: { value: "2026-12-01T14:15" },
    });
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => {
      expect(sent(request, "scheduled-task.create")).toHaveLength(3);
    });
    const oncePayload = sent(request, "scheduled-task.create")[2]?.payload;
    expect(oncePayload?.schedule).toEqual({
      type: "once",
      runAt: new Date("2026-12-01T14:15").toISOString(),
    });
  });

  it("pauses and resumes a task via scheduled-task.update", async () => {
    const user = userEvent.setup();
    const { request } = mountView([{ task: makeTask({ enabled: true }), recentRuns: [] }]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();
    });
    expect(sent(request, "scheduled-task.update")[0]).toEqual({
      type: "scheduled-task.update",
      payload: { taskId: taskOneId, patch: { enabled: false } },
    });

    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
    });
    expect(sent(request, "scheduled-task.update")[1]).toEqual({
      type: "scheduled-task.update",
      payload: { taskId: taskOneId, patch: { enabled: true } },
    });

    // Edit populates form and submits scheduled-task.update
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const titleInput = screen.getByLabelText("Title");
    expect(titleInput).toHaveValue("Morning repo check");
    await user.clear(titleInput);
    await user.type(titleInput, "Updated morning check");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Updated morning check" })).toBeVisible();
    });
    expect(sent(request, "scheduled-task.update")[2]?.payload).toMatchObject({
      taskId: taskOneId,
      patch: { title: "Updated morning check" },
    });
  });

  it("runs a task now via scheduled-task.run-now and opens the returned chat", async () => {
    const user = userEvent.setup();
    const { request, onOpenConversation } = mountView([
      { task: makeTask({ lastConversationId: null }), recentRuns: [] },
    ]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run now" })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Run now" }));

    await waitFor(() => {
      expect(sent(request, "scheduled-task.run-now")).toEqual([
        { type: "scheduled-task.run-now", payload: { taskId: taskOneId } },
      ]);
    });
    expect(onOpenConversation).toHaveBeenCalledWith(expect.objectContaining({ id: conversationId }));
    expect(screen.getByRole("button", { name: "Recent runs (1)" })).toBeVisible();
  });

  it("deletes a task with inline 2-step confirmation via scheduled-task.delete", async () => {
    const user = userEvent.setup();
    const { request } = mountView([{ task: makeTask(), recentRuns: [] }]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(sent(request, "scheduled-task.delete")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Confirm delete" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => {
      expect(sent(request, "scheduled-task.delete")).toEqual([
        { type: "scheduled-task.delete", payload: { taskId: taskOneId } },
      ]);
    });
    expect(screen.queryByRole("heading", { name: "Morning repo check" })).toBeNull();
  });

  it("displays recent runs, failure badges, and surfaces list errors cleanly", async () => {
    const user = userEvent.setup();
    mountView([
      {
        task: makeTask({
          lastRunStatus: "failed",
          lastError: "Provider quota exceeded",
          consecutiveFailures: 3,
        }),
        recentRuns: [
          makeRun({ id: runOneId, trigger: "manual", state: "failed", error: "Quota limit hit" }),
          makeRun({ id: runTwoId, trigger: "schedule", state: "completed", error: null }),
        ],
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Provider quota exceeded")).toBeVisible();
    });
    expect(screen.getByText("3 failures")).toBeVisible();
    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.getByText(/Last run Failed/i)).toBeVisible();

    const toggle = screen.getByRole("button", { name: "Recent runs (2)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const runsRegion = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(within(runsRegion).getByText("Manual")).toBeVisible();
    expect(within(runsRegion).getByText("Quota limit hit")).toBeVisible();
    expect(within(runsRegion).getByText("Scheduled")).toBeVisible();
    const runOpenButtons = within(runsRegion).getAllByRole("button", { name: "Open chat" });
    expect(runOpenButtons.length).toBe(2);

    // Error surfacing on list failure
    const failingRequest = vi.fn<RequestFn>(async () => ({
      type: "request.error",
      requestId: "req-fail",
      message: "Database unavailable",
    }));
    const { onError } = mountView([], { request: failingRequest });
    await waitFor(() => {
      expect(screen.getByText("Database unavailable")).toBeVisible();
    });
    expect(onError).toHaveBeenCalledWith("Database unavailable");
  });

  it("disables mutating controls when offline", async () => {
    const { rerender, request } = mountView([{ task: makeTask(), recentRuns: [] }]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    });

    const defaultSnapshot = snapshot([], {
      conversations: [conversation({ id: conversationId, projectId: firstProjectId })],
    });
    rerender(
      <ScheduledTasksView
        snapshot={defaultSnapshot}
        status="offline"
        projectScopeId={null}
        refreshNonce={0}
        request={request}
        onOpenConversation={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "New schedule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("S56: shows Skipped outcome without a Failed badge for a cancelled scheduled run", async () => {
    mountView([{
      task: makeTask({
        enabled: true,
        lastRunStatus: "skipped",
        lastRunAt: "2026-11-26T09:05:00.000Z",
        lastError: "Removed from the chat queue.",
        consecutiveFailures: 0,
      }),
      recentRuns: [],
    }]);

    await waitFor(() => {
      expect(screen.getByText("Morning repo check")).toBeVisible();
    });
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.getByText(/Last run Skipped/i)).toBeVisible();
  });

  it("S82: renaming a task with a 90-second interval preserves its original schedule by omitting schedule from the update patch", async () => {
    const user = userEvent.setup();
    const { request } = mountView([{
      task: makeTask({
        title: "Sub-minute interval job",
        schedule: { type: "interval", everyMs: 90_000 },
      }),
      recentRuns: [],
    }]);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sub-minute interval job" })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const titleInput = screen.getByLabelText("Title");
    await user.clear(titleInput);
    await user.type(titleInput, "Renamed 90s job");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(sent(request, "scheduled-task.update")).toHaveLength(1);
    });
    const updatePayload = sent(request, "scheduled-task.update")[0]?.payload as {
      taskId: string;
      patch: Record<string, unknown>;
    };
    expect(updatePayload.taskId).toBe(taskOneId);
    expect(updatePayload.patch.title).toBe("Renamed 90s job");
    expect("schedule" in updatePayload.patch).toBe(false);
  });

  it("R1-B2 + R1-B3: manages focus across inline delete confirmation and omits role=alert from persisted errors", async () => {
    const user = userEvent.setup();
    mountView([{
      task: makeTask({
        lastRunStatus: "failed",
        lastError: "Stored previous failure",
        consecutiveFailures: 1,
      }),
      recentRuns: [makeRun({ state: "failed", error: "Stored run error" })],
    }]);

    await waitFor(() => {
      expect(screen.getByText("Stored previous failure")).toBeVisible();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Recent runs \(1\)/i }));
    expect(screen.getByText("Stored run error")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    await user.click(deleteBtn);
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancelBtn);
    await user.click(cancelBtn);
    const restoredDeleteBtn = screen.getByRole("button", { name: "Delete" });
    expect(document.activeElement).toBe(restoredDeleteBtn);
  });

  it("S91: Run now opens a newly created chat once it arrives in snapshot", async () => {
    const user = userEvent.setup();
    const createdConvId = "99999999-9999-4999-8999-999999999999";
    const onOpenConversation = vi.fn();
    const request = vi.fn(async (command: { type: string }) => {
      if (command.type === "scheduled-task.list") {
        return {
          type: "request.result" as const,
          requestId: "req-list",
          result: {
            kind: "scheduled-tasks.list" as const,
            tasks: [{ task: makeTask({ boundConversationId: null, lastConversationId: null }), recentRuns: [] }],
          },
        };
      }
      if (command.type === "scheduled-task.run-now") {
        return {
          type: "request.result" as const,
          requestId: "req-run",
          result: {
            kind: "scheduled-task.ran" as const,
            task: makeTask({ boundConversationId: null, lastConversationId: createdConvId, lastRunStatus: "queued" }),
            run: makeRun({ conversationId: createdConvId, state: "queued" }),
            conversationId: createdConvId,
          },
        };
      }
      throw new Error(`Unexpected command ${command.type}`);
    });

    const initialSnapshot = snapshot([], {
      conversations: [conversation({ id: conversationId, projectId: firstProjectId })],
    });
    const view = render(
      <ScheduledTasksView
        snapshot={initialSnapshot}
        status="online"
        projectScopeId={null}
        refreshNonce={0}
        request={request as never}
        onOpenConversation={onOpenConversation}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run now" })).toBeVisible();
    });
    await user.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith({ type: "scheduled-task.run-now", payload: { taskId: taskOneId } });
    });
    expect(onOpenConversation).not.toHaveBeenCalled();

    const createdConversation = conversation({
      id: createdConvId,
      projectId: firstProjectId,
      title: "Morning repo check",
    });
    view.rerender(
      <ScheduledTasksView
        snapshot={{
          ...initialSnapshot,
          conversations: [...initialSnapshot.conversations, createdConversation],
        }}
        status="online"
        projectScopeId={null}
        refreshNonce={0}
        request={request as never}
        onOpenConversation={onOpenConversation}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(onOpenConversation).toHaveBeenCalledWith(expect.objectContaining({ id: createdConvId }));
    });
  });
});
