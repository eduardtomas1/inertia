import { describe, expect, it } from "vitest";

import {
  deriveTaskStatus,
  TASK_START_GRACE_MS,
  taskCanHandOffAgain,
  taskStatusRank,
  tasksSummary,
  type TaskStatusInput,
} from "../../src/renderer/src/components/tasks/taskStatus";
import { compareOpenTasks } from "../../src/renderer/src/components/tasks/taskModel";
import type { ConversationLatestTurnSummary } from "../../src/shared/contracts";
import type { Todo } from "../../src/shared/todos";

function todo(id: string, title: string, overrides: Partial<Todo> = {}): Todo {
  return {
    id,
    title,
    note: "",
    priority: null,
    dueDate: null,
    dueTime: null,
    projectId: null,
    completedAt: null,
    conversationId: null,
    linkedAt: null,
    createdAt: "2026-10-12T07:00:00.000Z",
    updatedAt: "2026-10-12T07:00:00.000Z",
    ...overrides,
  };
}

const now = Date.parse("2026-10-12T09:00:00.000Z");
const chat = "44444444-4444-4444-8444-444444444444";
const oldLink = "2026-10-12T08:00:00.000Z";
const freshLink = new Date(now - TASK_START_GRACE_MS + 5_000).toISOString();

type Turn = Pick<ConversationLatestTurnSummary, "status" | "terminalReason">;

function input(overrides: {
  completedAt?: string | null;
  conversationId?: string | null;
  linkedAt?: string | null;
  status?: TaskStatusInput["status"];
  archivedAt?: string | null;
  turn?: Turn | null;
  shell?: boolean;
  starting?: boolean;
} = {}): TaskStatusInput {
  return {
    todo: {
      completedAt: overrides.completedAt ?? null,
      conversationId: overrides.conversationId === undefined ? chat : overrides.conversationId,
      linkedAt: overrides.linkedAt === undefined ? oldLink : overrides.linkedAt,
    },
    status: overrides.status === undefined ? "working" : overrides.status,
    shell: overrides.shell === false ? null : {
      archivedAt: overrides.archivedAt ?? null,
      latestTurn: (overrides.turn ?? null) as ConversationLatestTurnSummary | null,
    },
    now,
    starting: overrides.starting ?? false,
  };
}

const failedTurn: Turn = { status: "failed", terminalReason: "provider-error" };

describe("deriveTaskStatus", () => {
  it.each([
    ["done wins over everything", input({ completedAt: oldLink, starting: true }), "done", null, null, "done"],
    ["unlinked to-do", input({ conversationId: null, status: null, shell: false }), "todo", null, null, "to-do"],
    ["starting while the request is in flight", input({ conversationId: null, starting: true }), "starting", "Starting…", "muted", "working"],
    ["starting within the grace with no chat yet", input({ linkedAt: freshLink, status: null, shell: false }), "starting", "Starting…", "muted", "working"],
    ["parked once the grace is over and the chat is missing", input({ status: null, shell: false }), "parked", "Not started", "muted", "to-do"],
    ["starting within the grace with an idle chat", input({ linkedAt: freshLink, status: "idle" }), "starting", "Starting…", "muted", "working"],
    ["parked with an idle chat that never ran", input({ status: "idle" }), "parked", "Not started", "muted", "to-do"],
    ["archived before working", input({ archivedAt: oldLink }), "archived", "Chat archived", "muted", "to-do"],
    ["approval", input({ status: "approval" }), "needs", "Needs your OK", "approval", "needs-you"],
    ["question", input({ status: "input" }), "needs", "Asked you a question", "input", "needs-you"],
    ["usage limit", input({ status: "limited" }), "needs", "Hit a usage limit", "approval", "needs-you"],
    ["working", input(), "working", "Working…", "working", "working"],
    ["failed", input({ status: "failed", turn: failedTurn }), "failed", "Failed", "failed", "needs-you"],
    ["ready for review", input({ status: "completed" }), "review", "Ready for you", "completed", "needs-you"],
    ["stopped", input({ status: "idle", turn: { status: "cancelled", terminalReason: null } }), "stopped", "Stopped", "muted", "to-do"],
  ] as const)("%s", (_name, value, kind, word, tone, bucket) => {
    const status = deriveTaskStatus(value);
    expect([status.kind, status.word, status.tone, status.bucket]).toEqual([kind, word, tone, bucket]);
  });

  it("keeps the failure code out of the reason and carries the need kind", () => {
    expect(deriveTaskStatus(input({ status: "failed", turn: failedTurn })).reason).toBeNull();
    expect(deriveTaskStatus(input({ status: "input" })).need).toBe("input");
  });

  it("offers a second hand-off only for chats that are not running", () => {
    expect(["failed", "stopped", "archived", "parked"].every((kind) =>
      taskCanHandOffAgain(kind as Parameters<typeof taskCanHandOffAgain>[0]))).toBe(true);
    expect(["todo", "starting", "working", "needs", "review", "done"].some((kind) =>
      taskCanHandOffAgain(kind as Parameters<typeof taskCanHandOffAgain>[0]))).toBe(false);
  });
});

describe("task ordering and summary", () => {
  it("ranks needs, failed, review, working, starting, then to-do kinds together", () => {
    const order = ["needs", "failed", "review", "working", "starting", "todo", "done"] as const;
    expect(order.map(taskStatusRank)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(["stopped", "archived", "parked"].map((kind) => taskStatusRank(kind as "todo"))).toEqual([5, 5, 5]);
  });

  it("puts overdue first, most overdue first, then priority, due and creation", () => {
    const today = new Date(2026, 9, 12, 16, 0);
    const plain = deriveTaskStatus(input({ conversationId: null, status: null, shell: false }));
    const rows = [
      todo("10000000-0000-4000-8000-000000000001", "Urgent later", { priority: "urgent", dueDate: "2026-10-20" }),
      todo("10000000-0000-4000-8000-000000000002", "Past time today", { dueDate: "2026-10-12", dueTime: "15:00" }),
      todo("10000000-0000-4000-8000-000000000003", "Long overdue", { dueDate: "2026-10-01" }),
      todo("10000000-0000-4000-8000-000000000004", "Later time today", { dueDate: "2026-10-12", dueTime: "18:00" }),
      todo("10000000-0000-4000-8000-000000000005", "Today untimed", { dueDate: "2026-10-12" }),
      todo("10000000-0000-4000-8000-000000000006", "No date"),
    ].map((entry) => ({ todo: entry, status: plain }));
    rows.sort((left, right) => compareOpenTasks(left, right, today));
    expect(rows.map(({ todo: entry }) => entry.title)).toEqual([
      "Long overdue",
      "Past time today",
      "Urgent later",
      "Today untimed",
      "Later time today",
      "No date",
    ]);
  });

  it("writes the summary line", () => {
    const of = (...values: TaskStatusInput[]) => values.map(deriveTaskStatus);
    expect(tasksSummary(of(input({ status: "approval" })), 0)).toBe("1 needs you");
    expect(tasksSummary(of(
      input({ status: "approval" }),
      input({ status: "completed" }),
      input(),
      input({ conversationId: null, starting: true }),
      input({ conversationId: null, status: null, shell: false }),
      input({ archivedAt: oldLink }),
    ), 3)).toBe("2 need you · 2 working · 2 to do");
    expect(tasksSummary([], 4)).toBe("All done");
    expect(tasksSummary([], 0)).toBe("Add anything you need to do");
  });
});
