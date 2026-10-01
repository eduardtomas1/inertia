import { describe, expect, it } from "vitest";
import { taskBoardCards, canSettleBoardCard } from "../../src/renderer/src/utils/taskBoard";
import { boardProject, conversation, project } from "./task-board-fixtures";
import type { WorkspaceRun } from "../../src/shared/contracts";

const now = Date.parse("2026-09-01T12:00:00.000Z");
const later = "2026-09-02T12:00:00.000Z";
const chats = [
  conversation({ id: "ready", projectId: "p" }),
  conversation({ id: "working", projectId: "p", status: "running" }),
  conversation({ id: "approval", projectId: "p", status: "needs-input", attentionKind: "approval" }),
  conversation({ id: "completed", projectId: "p", status: "completed" }),
  conversation({ id: "failed", projectId: "p", status: "failed" }),
  conversation({ id: "done", projectId: "p", status: "completed", settledAt: later }),
];
const input = { conversations: chats, projects: [boardProject], runs: [], projectId: null, query: "", includeSnoozed: false, now };

describe("task board state", () => {
  it("distinguishes agent completion from settled work and blocks settling active turns", () => {
    const cards = taskBoardCards(input);
    expect(Object.fromEntries(cards.map((card) => [card.conversation.id, card.column]))).toEqual({
      ready: "ready", working: "working", approval: "review", completed: "review", failed: "review", done: "done",
    });
    expect(cards.filter(canSettleBoardCard).map((card) => card.conversation.id).sort()).toEqual(["completed", "done", "failed", "ready"]);
  });

  it("uses canonical running agents ahead of stale conversation completion", () => {
    const chat = conversation({ id: "active", projectId: "p", status: "completed", settledAt: later });
    const run: WorkspaceRun = { id: "run", kind: "agent", conversationId: chat.id, projectId: "p", status: "running", attentionState: "acknowledged", actionId: null, label: "Agent", detail: null, canStop: true, port: null, startedAt: later, finishedAt: null };
    const [card] = taskBoardCards({ ...input, conversations: [chat], runs: [run] });
    expect(card?.column).toBe("working");
    expect(canSettleBoardCard(card!)).toBe(false);
  });

  it("filters project, archive, and snooze state while keeping urgent work visible and pins first", () => {
    const conversations = [
      ...chats,
      conversation({ id: "archived", projectId: "p", archivedAt: later }),
      conversation({ id: "snoozed", projectId: "p", snoozedUntil: later }),
      conversation({ id: "urgent", projectId: "p", snoozedUntil: later, status: "needs-input" }),
      conversation({ id: "pinned", projectId: "p", pinnedAt: later, branch: "feat/notes" }),
      conversation({ id: "other", projectId: "other" }),
    ];
    const projects = [boardProject, project({ id: "other", name: "Other", path: "/other" })];
    const cards = taskBoardCards({ ...input, conversations, projects, projectId: "p" });
    expect(cards[0]?.conversation.id).toBe("pinned");
    expect(cards.map(({ conversation: chat }) => chat.id)).toEqual(expect.arrayContaining(["urgent"]));
    for (const excluded of ["archived", "snoozed", "other"]) {
      expect(cards.map(({ conversation: chat }) => chat.id)).not.toContain(excluded);
    }
    expect(taskBoardCards({ ...input, conversations, query: "FEAT/notes" }).map((card) => card.conversation.id)).toEqual(["pinned"]);
    expect(taskBoardCards({ ...input, conversations, includeSnoozed: true }).some((card) => card.conversation.id === "snoozed")).toBe(true);
    expect(taskBoardCards({ ...input, conversations, now: Date.parse(later) }).some((card) => card.conversation.id === "snoozed")).toBe(true);
  });
});
