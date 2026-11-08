import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DelegationLineagePanel,
  DelegationSurfaceProvider,
} from "../../src/renderer/src/components/orchestration/delegation-surface";
import type {
  DelegationCommandRunner,
  DelegationSurface,
} from "../../src/renderer/src/components/orchestration/delegation-model";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { conversationDelegationSchema, type ConversationDelegation } from "../../src/shared/orchestration-delegation";
import { PARENT_ID, childId, finished, parentDelegation, resultEvent, summary, taskId } from "./delegation-fixtures";

const quiet = { reportError: false };
const childTurn = "60606060-6060-4060-8060-606060606060";

function delivery(action: "dismissed" | "sent", taskIds: string[]) {
  return resultEvent({ kind: "delegation.delivery", parentConversationId: PARENT_ID, action, taskIds, generation: 2 });
}

function panel(delegation: ConversationDelegation, overrides: Partial<DelegationSurface> = {}) {
  const run = vi.fn<DelegationCommandRunner>();
  const open = vi.fn<(conversationId: string) => boolean>(() => true);
  render(<DelegationSurfaceProvider conversationId={PARENT_ID} delegation={delegation}
    conversations={undefined} run={run} openConversation={open} {...overrides}>
    <button type="button">Before</button>
    <DelegationLineagePanel />
  </DelegationSurfaceProvider>);
  return { run, open };
}

function row(title: string): HTMLElement {
  return screen.getByText(title, { selector: "strong" }).closest<HTMLElement>("li")!;
}

afterEach(cleanup);

describe("delegated work lineage section", () => {
  it("labels each task's status, work state and wake state", async () => {
    panel(parentDelegation([
      summary(1),
      summary(2, { workState: "waiting_for_children", completionWake: "settled_only", wakeArmed: false }),
      summary(3, { completionWake: "never", wakeArmed: false, needsAction: { kind: "question", turnId: childTurn } }),
      finished(4),
      finished(5, { delivery: { state: "delivered", generation: 1 } }),
      finished(6, { status: "failed", delivery: { state: "disposed", generation: 1 } }),
    ]));
    const section = await screen.findByRole("region", { name: "Delegated work" });
    expect(within(section).getByText("3 working · 1 ready")).toBeTruthy();
    const chip = (title: string) => row(title).querySelector(".delegation-chip")?.textContent;
    expect(chip("Task 1")).toBe("Working");
    expect(chip("Task 2")).toBe("Waiting for its own agents");
    expect(chip("Task 3")).toBe("Needs your answer");
    expect(chip("Task 4")).toBe("Result ready");
    expect(chip("Task 5")).toBe("Delivered");
    expect(chip("Task 6")).toBe("Dismissed");
    expect(row("Task 1")).toHaveTextContent("Will continue this chat");
    expect(row("Task 2")).toHaveTextContent("Waits for you");
    expect(row("Task 3")).toHaveTextContent("No automatic continue");
    expect(row("Task 4")).toHaveTextContent("Child chat 4");
    expect(row("Task 4")).toHaveTextContent("Codex · gpt-test · high");
    expect(row("Task 4")).toHaveTextContent("Preview 4");
    expect(row("Task 6")).toHaveTextContent("Failed");
    expect(within(row("Task 5")).queryByRole("button", { name: /Dismiss result/u })).toBeNull();
    expect(within(row("Task 4")).queryByRole("button", { name: /Cancel task/u })).toBeNull();
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((item) => item.dataset.taskId)).toEqual([6, 5, 4, 3, 2, 1].map(taskId));
  });

  it("shows Needs you only for a request on the task's own turn and names its kind", async () => {
    const needsInput = [1, 2, 3, 4].map((index) => ({ id: childId(index), title: `Child chat ${index}`, status: "needs-input" }));
    panel(parentDelegation([
      summary(1, { needsAction: { kind: "question", turnId: childTurn } }),
      summary(2, { needsAction: { kind: "approval", turnId: childTurn } }),
      summary(3, { needsAction: null }),
      finished(4),
    ]), { conversations: needsInput });
    await screen.findByRole("region", { name: "Delegated work" });
    const chip = (title: string) => row(title).querySelector(".delegation-chip");
    expect(chip("Task 1")).toHaveTextContent("Needs your answer");
    expect(chip("Task 1")).toHaveAttribute("data-tone", "attention");
    expect(chip("Task 2")).toHaveTextContent("Needs your approval");
    expect(chip("Task 2")).toHaveAttribute("data-tone", "attention");
    expect(chip("Task 3")).toHaveTextContent("Working");
    expect(chip("Task 4")).toHaveTextContent("Result ready");
    expect(screen.queryAllByText(/^Needs you/u)).toHaveLength(2);
  });

  it("asks before cancelling, backs out on Escape with focus returned, and cancels on confirmation", async () => {
    const { run } = panel(parentDelegation([summary(1)]));
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "Cancel task: Task 1" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const confirmation = screen.getByRole("group", { name: "Confirm cancelling Task 1" });
    expect(within(confirmation).getByRole("button", { name: "Cancel task" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Confirm cancelling Task 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel task: Task 1" })).toHaveFocus();
    expect(run).not.toHaveBeenCalled();
    run.mockResolvedValue(resultEvent({ kind: "delegation.task.cancel", taskId: taskId(1), status: "cancel_requested" }));
    await user.keyboard("{Enter}");
    await user.click(within(screen.getByRole("group", { name: "Confirm cancelling Task 1" })).getByRole("button", { name: "Cancel task" }));
    expect(run).toHaveBeenCalledWith(`delegation.task.cancel:${taskId(1)}`,
      { type: "delegation.task.cancel", payload: { taskId: taskId(1) } }, quiet);
    expect(await screen.findByRole("button", { name: "Cancel task: Task 1" })).toHaveFocus();
  });

  it("shows a server refusal inline and verbatim", async () => {
    const { run } = panel(parentDelegation([summary(1)]));
    run.mockRejectedValue(new RuntimeCommandError("Task 1 is not running, so there is nothing to cancel.", "rejected"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cancel task: Task 1" }));
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    expect((await within(row("Task 1")).findByRole("alert")).textContent)
      .toBe("Task 1 is not running, so there is nothing to cancel.");
  });

  it("dismisses one result and continues the chat with every ready result", async () => {
    const { run } = panel(parentDelegation([finished(1), finished(2)]));
    const user = userEvent.setup();
    run.mockResolvedValueOnce(delivery("dismissed", [taskId(2)]));
    await user.click(await screen.findByRole("button", { name: "Dismiss result of Task 2" }));
    expect(run).toHaveBeenLastCalledWith(`delegation.delivery.dismiss:${taskId(2)}`, { type: "delegation.delivery.dismiss",
      payload: { parentConversationId: PARENT_ID, taskIds: [taskId(2)] } }, quiet);
    run.mockResolvedValueOnce(delivery("sent", [taskId(1), taskId(2)]));
    await user.click(screen.getByRole("button", { name: "Continue with results" }));
    expect(run).toHaveBeenLastCalledWith(`delegation.delivery.send:${PARENT_ID}`, { type: "delegation.delivery.send",
      payload: { parentConversationId: PARENT_ID } }, quiet);
    expect((await screen.findByRole("status")).textContent).toBe("Sent 2 results to this chat.");
    run.mockRejectedValueOnce(new RuntimeCommandError("Results are already being delivered.", "rejected"));
    await user.click(screen.getByRole("button", { name: "Continue with results" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Results are already being delivered.");
  });

  it("offers Continue with results for a dismissed result and not for a delivered one", async () => {
    const { run } = panel(parentDelegation([
      finished(1, { wakeArmed: false, delivery: { state: "disposed", generation: 1 } }),
      finished(2, { delivery: { state: "delivered", generation: 1 } }),
    ]));
    const section = await screen.findByRole("region", { name: "Delegated work" });
    expect(row("Task 1").querySelector(".delegation-chip")).toHaveTextContent("Dismissed");
    expect(within(section).queryByText(/ready/u)).toBeNull();
    run.mockResolvedValueOnce(delivery("sent", [taskId(1)]));
    await userEvent.setup().click(within(section).getByRole("button", { name: "Continue with results" }));
    expect(run).toHaveBeenLastCalledWith(`delegation.delivery.send:${PARENT_ID}`, { type: "delegation.delivery.send",
      payload: { parentConversationId: PARENT_ID } }, quiet);
    expect((await screen.findByRole("status")).textContent).toBe("Sent 1 result to this chat.");
    cleanup();
    panel(parentDelegation([finished(3, { delivery: { state: "delivered", generation: 1 } })]));
    await screen.findByRole("region", { name: "Delegated work" });
    expect(screen.queryByRole("button", { name: "Continue with results" })).toBeNull();
  });

  it("toggles the automatic continue only where the task allows it", async () => {
    const { run } = panel(parentDelegation([summary(1), summary(2, { completionWake: "never", wakeArmed: false }),
      finished(3, { delivery: { state: "delivered", generation: 1 } })]));
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "Delegated work" });
    expect(within(row("Task 2")).queryByRole("checkbox")).toBeNull();
    expect(within(row("Task 3")).queryByRole("checkbox")).toBeNull();
    const toggle = within(row("Task 1")).getByRole("checkbox", { name: "Continue this chat when it finishes" });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription("Task 1");
    run.mockResolvedValue(resultEvent({ kind: "delegation.task", task: {} }));
    await user.click(toggle);
    expect(run).toHaveBeenCalledWith(`delegation.wake.set:${taskId(1)}`,
      { type: "delegation.wake.set", payload: { taskId: taskId(1), armed: false } }, quiet);
  });

  it("opens the child chat and reports a chat that is gone", async () => {
    const open = vi.fn((conversationId: string) => conversationId === childId(1));
    panel(parentDelegation([summary(1), summary(2)]), { openConversation: open });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open chat for Task 1" }));
    expect(open).toHaveBeenCalledWith(childId(1));
    await user.click(screen.getByRole("button", { name: "Open chat for Task 2" }));
    expect(within(row("Task 2")).getByRole("alert")).toHaveTextContent("That chat is not available.");
  });

  it("loads the full result on demand", async () => {
    const { run } = panel(parentDelegation([finished(1)]));
    run.mockResolvedValue(resultEvent({ kind: "delegation.task", task: { taskId: taskId(1),
      result: { turnId: "result-turn", status: "completed", text: "The complete result.", truncated: false, neutralized: false } } }));
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", { name: "Full result of Task 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("The complete result.")).toBeTruthy();
    expect(run).toHaveBeenCalledWith(`delegation.task.read:${taskId(1)}`,
      { type: "delegation.task.read", payload: { taskId: taskId(1) } }, quiet);
  });

  it("shows the child chat's lineage breadcrumb with its parent and status", async () => {
    const delegation = conversationDelegationSchema.parse({ asParent: null, asChild: {
      taskId: taskId(1), parentConversationId: PARENT_ID, parentTitle: "Release parser plan", status: "running",
      workState: "waiting_for_children" } });
    const open = vi.fn(() => true);
    const chats = [{ id: childId(1), title: "Child chat 1", status: "needs-input" }];
    render(<DelegationSurfaceProvider conversationId={childId(1)} delegation={delegation}
      conversations={chats} run={undefined} openConversation={open}><DelegationLineagePanel /></DelegationSurfaceProvider>);
    const crumb = await screen.findByRole("navigation", { name: "Delegation lineage" });
    expect(crumb).toHaveTextContent("Delegated by Release parser plan · Waiting for its own agents");
    await userEvent.setup().click(within(crumb).getByRole("button", { name: "Open parent chat Release parser plan" }));
    expect(open).toHaveBeenCalledWith(PARENT_ID);
    expect(screen.queryByRole("region", { name: "Delegated work" })).toBeNull();
  });

  it("keeps one row per task when a reconnect replays tasks or delivers a new generation", async () => {
    const run = vi.fn<DelegationCommandRunner>();
    const surface = (delegation: ConversationDelegation) => <DelegationSurfaceProvider conversationId={PARENT_ID}
      delegation={delegation} conversations={undefined} run={run} openConversation={undefined}>
      <DelegationLineagePanel />
    </DelegationSurfaceProvider>;
    const view = render(surface(parentDelegation([summary(1), summary(2), summary(1)],
      { generation: 1, phase: "queued", taskIds: [] })));
    const section = await screen.findByRole("region", { name: "Delegated work" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    view.rerender(surface(parentDelegation([finished(1, { updatedAt: "2026-10-31T11:00:00.000Z",
      delivery: { state: "delivered", generation: 2 } }), finished(2, { delivery: { state: "delivered", generation: 2 } }),
    summary(1)], { generation: 2, phase: "dispatched", taskIds: [taskId(1), taskId(2)] })));
    const rows = within(screen.getByRole("region", { name: "Delegated work" })).getAllByRole("listitem");
    expect(rows.map((item) => item.dataset.taskId)).toEqual([taskId(2), taskId(1)]);
    expect(rows.map((item) => item.querySelector(".delegation-chip")?.textContent)).toEqual(["Delivered", "Delivered"]);
  });

  it("renders nothing without delegated work", () => {
    panel(conversationDelegationSchema.parse({ asParent: { tasks: [], totalTasks: 0, mailbox: null }, asChild: null }));
    expect(screen.queryByRole("region", { name: "Delegated work" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Delegation lineage" })).toBeNull();
  });
});
