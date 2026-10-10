import { describe, expect, it, vi } from "vitest";
import type { AgentActivity, AgentApprovalRequest, AgentInputRequest, ChatMessage } from "../../src/shared/contracts/agent";
import { AGENT_RUN_STATES } from "../../src/shared/run-state";
import { emptyMascotStatus, MASCOT_CHAT_LIMIT, MASCOT_ROW_LIMIT, parseMascotStatus } from "../../src/shared/mascot";
import { mascotFeedViolation, parseMascotFeed } from "../../src/shared/mascot-feed";
import { mascotPublisher, mascotShell as conversation, mascotTestClock } from "../helpers/mascot-fixture";
import { MascotStatusPublisher } from "../../src/server/runtime/mascot-status";
import { mascotPreview } from "../../src/server/runtime/mascot-message";

const ids = (chats: readonly { conversationId: string | null }[]): Array<string | null> => chats.map(({ conversationId }) => conversationId);
const MINUTE = 60_000;
const owner = { conversationId: "chat", runId: "chat-run", turnId: "chat-turn" };

function input(id = "question"): AgentInputRequest {
  return { ...owner, id, providerId: "codex", autoResolutionMs: null, questions: [{
    id: "layout", header: "Layout", question: "Should the mascot follow all chats or only the selected chat?",
    isSecret: false, isOther: true, allowMultiple: false, options: [],
  }] };
}

function said(content: string, createdAt: string, id = "message"): { type: "agent.commentary.persisted"; message: ChatMessage } {
  return { type: "agent.commentary.persisted", message: {
    id, conversationId: "chat", turnId: "chat-turn", role: "assistant", attachments: [], content, createdAt,
  } as ChatMessage };
}

function did(activity: Partial<AgentActivity> & Pick<AgentActivity, "title">): { type: "agent.activity"; activity: AgentActivity } {
  return { type: "agent.activity", activity: { ...owner, id: "activity", kind: "command", detail: null, status: "running",
    createdAt: "2026-09-06T10:01:00.000Z", ...activity } };
}

describe("authoritative mascot status", () => {
  it.each(AGENT_RUN_STATES)("preserves exact %s state and full turn identity", (phase) => {
    const { publisher, publish, feed } = mascotPublisher();
    publisher.replace([conversation("chat", phase)]);
    const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(phase);
    const status = {
      phase, projectId: "project", conversationId: "chat", runId: "chat-run", turnId: "chat-turn",
      chatTitle: "Chat chat", projectName: null, message: null, progress: null, steps: null,
      since: terminal ? "2026-09-06T10:00:00.000Z" : "2026-09-06T09:00:00.000Z", quietSince: null,
      activeCount: terminal ? 0 : 1,
    };
    const shown = phase !== "cancelled";
    expect(feed()).toEqual({
      status: shown ? status : emptyMascotStatus(), chats: [status], rows: [], focus: null,
      counts: { chats: 1, attention: phase.startsWith("waiting-") ? 1 : 0, others: 0 }, request: null,
    });
    expect(mascotFeedViolation(feed())).toBeNull();
    expect(JSON.stringify(publish.mock.calls)).not.toContain("PRIVATE");
  });

  it("orders needs-you before unseen failures, unseen results, and working chats, and lists the rest as rows", () => {
    const { publisher, feed } = mascotPublisher();
    publisher.replace([
      conversation("complete", "completed"), conversation("failure", "failed"),
      conversation("working", "running"), conversation("approval", "waiting-for-approval"),
    ]);
    expect(feed().status).toMatchObject({ conversationId: "approval", phase: "waiting-for-approval", activeCount: 2 });
    expect(ids(feed().rows)).toEqual(["failure", "complete", "working"]);
    expect(feed().counts).toEqual({ chats: 4, attention: 1, others: 3 });
    publisher.update({ ...conversation("approval", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" });
    expect(feed().status).toMatchObject({ conversationId: "failure", phase: "failed", activeCount: 1 });
    expect(ids(feed().rows)).toEqual(["complete", "working"]);
    publisher.update({ ...conversation("failure", "failed"), lastViewedAt: "2026-09-06T11:00:00.000Z" });
    expect(feed().status).toMatchObject({ conversationId: "complete", phase: "completed" });
    publisher.update({ ...conversation("complete", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" });
    expect(feed().status).toMatchObject({ conversationId: "working", phase: "running" });
    expect(feed().rows).toEqual([]);
    expect(mascotFeedViolation(feed())).toBeNull();
  });

  it("shows a result or failure while other chats keep running instead of hiding it behind them", () => {
    const { publisher, feed } = mascotPublisher();
    publisher.replace([conversation("a", "running")]);
    publisher.update(conversation("b", "running", { requestedAt: "2026-09-06T09:10:00.000Z" }));
    expect(feed().status.conversationId).toBe("a");
    publisher.update(conversation("b", "completed"));
    expect(feed().status).toMatchObject({ conversationId: "b", phase: "completed" });
    expect(ids(feed().rows)).toEqual(["a"]);
    publisher.update(conversation("c", "failed"));
    expect(feed().status).toMatchObject({ conversationId: "c", phase: "failed" });
    expect(ids(feed().rows)).toEqual(["b", "a"]);
  });

  it("keeps the shown chat when another chat starts later or reaches the same priority", () => {
    const { publisher, feed } = mascotPublisher();
    publisher.replace([conversation("first", "running")]);
    publisher.update(conversation("later", "running", { requestedAt: "2026-09-06T10:20:00.000Z" }));
    expect(feed().status.conversationId).toBe("first");
    expect(ids(feed().rows)).toEqual(["later"]);
    publisher.update(conversation("first", "waiting-for-input"));
    publisher.update(conversation("later", "waiting-for-approval", { updatedAt: "2026-09-06T10:25:00.000Z" }));
    expect(feed().status).toMatchObject({ conversationId: "first", phase: "waiting-for-input" });
    expect(ids(feed().rows)).toEqual(["later"]);
    expect(feed().counts).toMatchObject({ attention: 2, others: 1 });
    publisher.update(conversation("first", "running"));
    expect(feed().status).toMatchObject({ conversationId: "later", phase: "waiting-for-approval" });
    expect(ids(feed().rows)).toEqual(["first"]);
    expect(mascotFeedViolation(feed())).toBeNull();
  });

  it("returns to the shown chat's equal-priority neighbours only when it resolves", () => {
    const { publisher, feed } = mascotPublisher();
    publisher.replace([conversation("done-a", "completed"), conversation("done-b", "completed", { updatedAt: "2026-09-06T10:05:00.000Z" })]);
    expect(feed().status.conversationId).toBe("done-b");
    publisher.update(conversation("done-c", "completed", { updatedAt: "2026-09-06T10:20:00.000Z" }));
    expect(feed().status.conversationId).toBe("done-b");
    publisher.update({ ...conversation("done-b", "completed", { updatedAt: "2026-09-06T10:05:00.000Z" }), lastViewedAt: "2026-09-06T10:21:00.000Z" });
    expect(feed().status.conversationId).toBe("done-c");
    expect(ids(feed().rows)).toEqual(["done-a"]);
  });

  it("does not replay seen results, hides cancelled work, and does not retain deleted chats", () => {
    const { publisher, publish, feed } = mascotPublisher();
    publisher.replace([{ ...conversation("old", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" }]);
    expect(feed()).toMatchObject({ status: emptyMascotStatus(), chats: [{ conversationId: "old", phase: "completed" }], rows: [], counts: { chats: 1, attention: 0, others: 0 } });
    publisher.update(conversation("cancelled", "cancelled"));
    expect(feed().status).toEqual(emptyMascotStatus());
    publisher.replace([]);
    expect(publish).toHaveBeenLastCalledWith({ status: emptyMascotStatus(), chats: [], rows: [], focus: null, counts: { chats: 0, attention: 0, others: 0 }, request: null });
  });

  it("deduplicates shell/snapshot updates including streamed text metadata changes", () => {
    const { publisher, publish } = mascotPublisher();
    const chat = conversation("chat", "running");
    publisher.replace([chat]);
    publisher.update({ ...chat, latestTurn: { ...chat.latestTurn!, updatedAt: "2026-09-06T12:00:00.000Z" } });
    publisher.replace([chat]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not switch live chat ownership when ordinary activity updates its timestamp", () => {
    const { publisher, publish, feed } = mascotPublisher();
    const first = conversation("a", "running");
    const second = conversation("b", "running");
    publisher.replace([first, second]);
    publisher.update({ ...second, latestTurn: { ...second.latestTurn!, updatedAt: "2026-09-06T12:00:00.000Z" } });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(feed().status).toMatchObject({ conversationId: "a", activeCount: 2 });
    publisher.update(conversation("b", "waiting-for-input"));
    expect(feed().status).toMatchObject({ conversationId: "b", phase: "waiting-for-input" });
  });
});

describe("mascot lifetimes", () => {
  it("lets an unseen result expire after 7 days and an unseen failure after 1 hour without another event", () => {
    const { publisher, feed, clock } = mascotPublisher();
    publisher.replace([conversation("done", "completed"), conversation("broken", "failed", { updatedAt: "2026-09-06T10:10:00.000Z" })]);
    expect(feed().status.conversationId).toBe("broken");
    expect(ids(feed().rows)).toEqual(["done"]);
    clock.advance(39 * MINUTE);
    expect(feed().status.conversationId).toBe("broken");
    clock.advance(MINUTE);
    expect(feed().status.conversationId).toBe("done");
    expect(feed()).toMatchObject({ rows: [], counts: { chats: 2, others: 0 } });
    clock.advance(7 * 24 * 60 * MINUTE - 71 * MINUTE);
    expect(feed().status.conversationId).toBe("done");
    clock.advance(MINUTE);
    expect(feed().status).toEqual(emptyMascotStatus());
    expect(feed().chats.map(({ phase }) => phase)).toEqual(["failed", "completed"]);
    expect(clock.pending()).toBe(0);
  });

  it("drops a question nobody answered for 24 hours from the bubble, rows and counts", () => {
    const { publisher, feed, clock } = mascotPublisher();
    publisher.replace([conversation("asked", "waiting-for-input"), conversation("busy", "running")]);
    expect(feed()).toMatchObject({ status: { conversationId: "asked" }, counts: { attention: 1, others: 1 } });
    clock.advance(23 * 60 * MINUTE + 29 * MINUTE);
    expect(feed().counts).toMatchObject({ attention: 1 });
    clock.advance(MINUTE);
    expect(feed()).toMatchObject({ status: { conversationId: "busy", activeCount: 2 }, rows: [], counts: { attention: 0, others: 0 } });
    expect(mascotFeedViolation(feed())).toBeNull();
  });

  it("keeps a valid feed with the chat still counted as active after a lone approval expires", async () => {
    const { parseRuntimeWorkerEvent } = await import("../../src/node/runtime-process-protocol");
    const { publisher, feed, clock } = mascotPublisher();
    publisher.replace([conversation("chat", "waiting-for-approval", { updatedAt: "2026-09-06T10:30:00.000Z" })]);
    clock.advance(24 * 60 * MINUTE);
    expect(feed()).toMatchObject({ status: { phase: "idle", conversationId: null, activeCount: 1 }, rows: [], counts: { attention: 0, others: 0 } });
    expect(feed().chats).toEqual([expect.objectContaining({ conversationId: "chat", activeCount: 1 })]);
    expect(mascotFeedViolation(feed())).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", ...feed() })).not.toBeNull();
  });

  it("marks a working chat quiet after 10 minutes without an update and clears it on the next one", () => {
    const shell = conversation("chat", "running");
    const { publisher, feed, clock } = mascotPublisher({ lookup: () => shell });
    publisher.replace([shell]);
    clock.advance(9 * MINUTE);
    publisher.observe({ type: "agent.reasoning", ...owner, text: "PRIVATE" });
    clock.advance(9 * MINUTE + 59_000);
    expect(feed().status.quietSince).toBeNull();
    clock.advance(1_000);
    expect(feed().status).toMatchObject({ phase: "running", quietSince: "2026-09-06T10:39:00.000Z" });
    expect(parseMascotStatus(feed().status)).toEqual(feed().status);
    publisher.observe({ type: "agent.text", ...owner, text: "More words" });
    expect(feed().status.quietSince).toBeNull();
    publisher.update(conversation("chat", "waiting-for-input"));
    clock.advance(60 * MINUTE);
    expect(feed().status).toMatchObject({ phase: "waiting-for-input", quietSince: null });
    expect(JSON.stringify(feed())).not.toContain("PRIVATE");
  });
});

describe("mascot chat list and rows", () => {
  it("ranks switchable chats, keeps seen results available, and adds project context", () => {
    const { publisher, feed } = mascotPublisher();
    const seen = { ...conversation("seen", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" };
    const live = conversation("live", "running");
    live.latestTurn = { ...live.latestTurn!, startedAt: "2026-09-06T09:30:00+00:00" };
    publisher.replace([seen, live, conversation("question", "waiting-for-input"), { ...conversation("archived", "running"), archivedAt: "2026-09-06T11:00:00.000Z" }], [{ id: "project", name: "Inertia" }]);
    const { status, chats, rows } = feed();
    expect(status).toMatchObject({ conversationId: "question", projectName: "Inertia", activeCount: 2 });
    expect(ids(chats)).toEqual(["question", "live", "seen"]);
    expect(ids(rows)).toEqual(["live"]);
    expect(chats[1]).toMatchObject({ since: "2026-09-06T09:30:00.000Z", activeCount: 2 });
    expect(chats[2]).toMatchObject({ phase: "completed", since: "2026-09-06T10:00:00.000Z" });
    for (const chat of chats) expect(parseMascotStatus(chat)).toEqual(chat);
    publisher.replace(Array.from({ length: 12 }, (_, index) => conversation(`chat-${index}`, "running")));
    expect(feed().chats).toHaveLength(MASCOT_CHAT_LIMIT);
  });

  it("lists up to five other chats by priority and counts the rest", () => {
    const { publisher, feed } = mascotPublisher();
    const busy = Array.from({ length: 8 }, (_, index) => conversation(`busy-${index}`, "running", { requestedAt: `2026-09-06T09:0${index}:00.000Z` }));
    publisher.replace([...busy, conversation("question", "waiting-for-input"), conversation("broken", "failed"), { ...conversation("seen", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" }]);
    expect(feed().status.conversationId).toBe("question");
    expect(ids(feed().rows)).toEqual(["broken", "busy-7", "busy-6", "busy-5", "busy-4"]);
    expect(feed().rows).toHaveLength(MASCOT_ROW_LIMIT);
    expect(feed().counts).toEqual({ chats: 11, attention: 1, others: 9 });
    expect(mascotFeedViolation(feed())).toBeNull();
  });

  it("leaves the pinned chat out of the rows and lists the chat that would otherwise be shown", () => {
    const { publisher, feed } = mascotPublisher();
    publisher.replace([conversation("question", "waiting-for-input"), conversation("busy", "running"), conversation("done", "completed")]);
    publisher.focus("busy", 1);
    expect(feed()).toMatchObject({ focus: "busy", status: { conversationId: "question" }, counts: { others: 2 } });
    expect(ids(feed().rows)).toEqual(["question", "done"]);
    expect(mascotFeedViolation(feed())).toBeNull();
  });

  it("keeps a focused chat listed beyond the cap and confirms the focus only while it is listed", () => {
    const { publisher, feed } = mascotPublisher();
    const pinned = { ...conversation("pinned", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" };
    const busy = Array.from({ length: 10 }, (_, index) => conversation(`busy-${index}`, "running"));
    publisher.replace([pinned, ...busy]);
    expect(ids(feed().chats)).not.toContain("pinned");
    publisher.focus("pinned", 1);
    expect(feed()).toMatchObject({ request: 1, focus: "pinned" });
    expect(feed().chats).toHaveLength(MASCOT_CHAT_LIMIT);
    expect(feed().chats.at(-1)).toMatchObject({ conversationId: "pinned", phase: "completed" });
    publisher.replace(busy);
    expect(ids(feed().chats)).not.toContain("pinned");
    expect(feed().focus).toBeNull();
    publisher.focus("missing", 2);
    expect(feed()).toMatchObject({ focus: null, counts: { chats: 10, attention: 0, others: 9 }, request: 2 });
    publisher.replace([pinned, ...busy]);
    publisher.focus("pinned", 3);
    publisher.replace(busy);
    publisher.replace([pinned, ...busy]);
    expect(feed()).toMatchObject({ focus: null, request: 3 });
  });

  it("publishes the true number of chats that need you beside the capped list", () => {
    const { publisher, feed } = mascotPublisher();
    const pinned = { ...conversation("pinned", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" };
    const questions = Array.from({ length: 6 }, (_, index) => conversation(`question-${index}`, "waiting-for-input"));
    const approvals = Array.from({ length: 5 }, (_, index) => conversation(`approval-${index}`, "waiting-for-approval"));
    publisher.replace([pinned, ...questions, ...approvals, conversation("busy", "running")]);
    publisher.focus("pinned", 1);
    const { status, chats, rows, focus, counts } = feed();
    expect(chats).toHaveLength(MASCOT_CHAT_LIMIT);
    expect(chats.filter(({ phase }) => phase.startsWith("waiting-"))).toHaveLength(MASCOT_CHAT_LIMIT - 1);
    expect(rows.every(({ phase }) => phase.startsWith("waiting-"))).toBe(true);
    expect(focus).toBe("pinned");
    expect(counts).toEqual({ chats: 13, attention: 11, others: 12 });
    expect(status.activeCount).toBe(12);
    publisher.replace([pinned, conversation("busy", "running")]);
    expect(feed().counts).toEqual({ chats: 2, attention: 0, others: 1 });
  });

  it("reads project names from the snapshot and caches lookups for unknown projects", () => {
    const lookup = (id: string): string | null => id === "new" ? "Fresh project" : null;
    let calls = 0;
    const { publisher, feed } = mascotPublisher({ projectName: (id) => { calls += 1; return lookup(id); } });
    publisher.replace([conversation("a", "running"), conversation("b", "running")], [{ id: "project", name: "Inertia" }]);
    expect(feed().chats.map(({ projectName }) => projectName)).toEqual(["Inertia", "Inertia"]);
    expect(calls).toBe(0);
    publisher.update({ ...conversation("c", "running"), projectId: "new" });
    publisher.update({ ...conversation("d", "running"), projectId: "new" });
    expect(calls).toBe(1);
    expect(feed().chats).toContainEqual(expect.objectContaining({ conversationId: "d", projectName: "Fresh project" }));
  });

  it("keeps plan steps with their turn and clears them when the turn ends", () => {
    let shell = conversation("chat", "running");
    const { publisher, feed } = mascotPublisher({ lookup: () => shell });
    publisher.replace([shell]);
    publisher.observe({ type: "agent.plan.updated", plan: { ...owner, explanation: null, steps: [
      { step: "Sketch", status: "completed" }, { step: "Build", status: "inProgress" }, { step: "Ship", status: "pending" },
    ] } });
    expect(feed().status).toMatchObject({ steps: { completed: 1, total: 3 }, message: "Build" });
    publisher.replace([shell]);
    expect(feed().chats[0]!.steps).toEqual({ completed: 1, total: 3 });
    shell = conversation("chat", "completed");
    publisher.observe({ type: "agent.completed", ...owner, status: "completed", terminalReason: "completed", terminalAssistantMessage: null });
    expect(feed().status).toMatchObject({ phase: "completed", steps: null, progress: null, message: null });
  });
});

describe("mascot bubble words", () => {
  it("keeps the agent's own words over the plan step and tool activity, and never shows a bare tool label", () => {
    const { publisher, feed, clock } = mascotPublisher();
    publisher.replace([conversation("chat", "running")]);
    publisher.observe(did({ kind: "status", title: "Turn started", createdAt: "2026-09-06T10:00:00.000Z" }));
    expect(feed().status.message).toBeNull();
    publisher.observe(did({ title: "Command", detail: "Command:\n/bin/zsh -lc 'rg -n mascot <workspace>/src'", createdAt: "2026-09-06T10:00:01.000Z" }));
    expect(feed().status.message).toBe("Running rg -n mascot src");
    clock.advance(2_000);
    publisher.observe(did({ id: "file", kind: "tool", title: "File change", detail: "Files:\nupdate: src/server/runtime/mascot-status.ts", createdAt: "2026-09-06T10:00:02.000Z" }));
    expect(feed().status.message).toBe("Editing mascot-status.ts");
    publisher.observe(did({ id: "file", kind: "tool", title: "File change", status: "completed", detail: "Files:\nupdate: src/server/runtime/mascot-status.ts", createdAt: "2026-09-06T10:00:02.000Z" }));
    clock.advance(2_000);
    expect(feed().status.message).toBe("Edited mascot-status.ts");
    publisher.observe({ type: "agent.plan.updated", plan: { ...owner, explanation: null, steps: [
      { step: "Update the bubble", status: "completed" }, { step: "Check keyboard access", status: "inProgress" },
    ] } });
    expect(feed().status).toMatchObject({ message: "Check keyboard access", progress: "1 of 2 steps complete" });
    publisher.observe(said("Thanks. I’m checking the bubble layout and keyboard behavior.", "2026-09-06T10:00:03.000Z"));
    expect(feed().status.message).toBe("I’m checking the bubble layout and keyboard behavior.");
    clock.advance(2_000);
    publisher.observe(did({ id: "next", title: "Command", detail: "Command:\nnpm test\n\nOutput:\nPRIVATE OUTPUT", createdAt: "2026-09-06T10:00:04.000Z" }));
    publisher.observe(did({ id: "think", kind: "reasoning", title: "PRIVATE REASONING", createdAt: "2026-09-06T10:00:05.000Z" }));
    clock.advance(2_000);
    expect(feed().status.message).toBe("I’m checking the bubble layout and keyboard behavior.");
    expect(JSON.stringify(feed())).not.toContain("PRIVATE");
  });

  it("holds each message for 1.5 seconds before a message of equal or lower value replaces it", () => {
    let shell = conversation("chat", "running");
    const { publisher, feed, clock } = mascotPublisher({ lookup: () => shell });
    publisher.replace([shell]);
    publisher.observe(did({ id: "one", title: "npm test", detail: "Command:\nnpm test", createdAt: "2026-09-06T10:00:01.000Z" }));
    expect(feed().status.message).toBe("Running npm test");
    clock.advance(500);
    publisher.observe(did({ id: "two", title: "Command", detail: "Command:\nnpm run lint", createdAt: "2026-09-06T10:00:02.000Z" }));
    expect(feed().status.message).toBe("Running npm test");
    clock.advance(999);
    expect(feed().status.message).toBe("Running npm test");
    clock.advance(1);
    expect(feed().status.message).toBe("Running npm run lint");
    publisher.observe(said("Lint is clean, so I’m writing the tests next.", "2026-09-06T10:00:03.000Z"));
    expect(feed().status.message).toBe("Lint is clean, so I’m writing the tests next.");
    shell = conversation("chat", "waiting-for-input");
    publisher.observe({ type: "agent.input.requested", request: input() });
    expect(feed().status.message).toBe(input().questions[0]!.question);
  });

  it("names the approval's command and reason and keeps question text", () => {
    const { publisher, feed } = mascotPublisher();
    publisher.replace([conversation("chat", "waiting-for-approval")]);
    const request: AgentApprovalRequest = { ...owner, id: "approve", providerId: "codex", kind: "command",
      title: "Approve command", reason: "Verify the mascot changes", detail: "PRIVATE DETAIL", command: "/bin/zsh -lc 'npm test -- --token=PRIVATE_SECRET_VALUE'",
      cwd: null, networkScope: null, permissionRoots: [], availableDecisions: ["approve", "deny"] };
    publisher.observe({ type: "agent.approval.requested", request });
    expect(feed().status.message).toBe("Approve command: npm test -- --token=[redacted] — Verify the mascot changes");
    publisher.update(conversation("chat", "waiting-for-input"));
    const secret = input();
    secret.questions[0] = { ...secret.questions[0]!, isSecret: true, question: "PRIVATE SECRET PROMPT" };
    secret.questions.push(input().questions[0]!);
    publisher.observe({ type: "agent.input.requested", request: secret });
    expect(feed().status).toMatchObject({ message: "Sensitive information is needed. Answer privately in the chat.", progress: "2 questions to answer" });
    expect(JSON.stringify(feed())).not.toContain("PRIVATE");
  });

  it("keeps questions actionable through background updates and clears only the resolved request", () => {
    let shell = conversation("chat", "running");
    const { publisher, feed } = mascotPublisher({ lookup: () => shell });
    publisher.replace([shell]);
    shell = conversation("chat", "waiting-for-input");
    publisher.observe({ type: "agent.input.requested", request: input() });
    expect(feed().status).toMatchObject({ phase: "waiting-for-input", message: input().questions[0]!.question });
    const second = input("second");
    second.questions[0]!.question = "Which color should the bubble use?";
    publisher.observe({ type: "agent.input.requested", request: second });
    publisher.observe({ type: "agent.input.resolved", ...owner, requestId: "old-request" });
    expect(feed().status.message).toBe(input().questions[0]!.question);
    publisher.observe({ type: "agent.input.resolved", ...owner, requestId: "question" });
    expect(feed().status.message).toBe(second.questions[0]!.question);
    publisher.observe({ type: "agent.input.resolved", ...owner, requestId: "second" });
    expect(feed().status.message).toBeNull();
  });

  it("rejects stale turn/run context, clears old previews on a new turn, and bounds plain text", () => {
    const { publisher, feed } = mascotPublisher();
    publisher.replace([conversation("chat", "waiting-for-input")]);
    const request = input();
    request.questions[0]!.question = "‮**" + "A".repeat(10_000);
    publisher.observe({ type: "agent.input.requested", request });
    const status = feed().status;
    expect(status.message!.length).toBe(280);
    expect(status.message!.endsWith("…")).toBe(true);
    expect(parseMascotStatus(status)).toEqual(status);
    publisher.observe({ type: "agent.input.requested", request: { ...input(), runId: "stale" } });
    expect(feed().status).toEqual(status);
    publisher.update(conversation("chat", "running", { turnId: "new-turn" }));
    publisher.observe({ type: "agent.input.requested", request: input() });
    expect(feed().status).toMatchObject({ turnId: "new-turn", message: null, progress: null });
  });

  it("does not describe the missing checkpoint notice as the chat's latest work", () => {
    const { publisher, feed } = mascotPublisher({ lookup: () => conversation("chat", "running") });
    publisher.replace([conversation("chat", "running")]);
    publisher.observe(did({ title: "npm test", detail: "Command:\nnpm test" }));
    publisher.observe(did({ id: "notice", kind: "tool", status: "completed", title: "No checkpoint for this turn",
      detail: "Checkpoint operation timed out.", createdAt: "2026-09-06T10:02:00.000Z" }));
    expect(feed().status.message).toBe("Running npm test");
    expect(JSON.stringify(feed())).not.toContain("No checkpoint");
  });

  it("previews the first sentence of the exact final result and the actual failure message", () => {
    let shell = conversation("chat", "running");
    const { publisher, feed } = mascotPublisher({ lookup: () => shell });
    publisher.replace([shell]);
    shell = conversation("chat", "completed");
    const completed = { type: "agent.completed" as const, ...owner, status: "completed" as const, terminalReason: "completed",
      terminalAssistantMessage: { id: "final", conversationId: "chat", turnId: "chat-turn", role: "assistant" as const,
        content: "## Summary\n\nI split the **status feed** into `MascotFeed` per chat. Tests passed.\n\n- Updated files", attachments: [], createdAt: "2026-09-06T12:00:00.000Z" } };
    publisher.observe(completed);
    expect(feed().status.message).toBe("I split the status feed into MascotFeed per chat.");
    publisher.observe({ ...completed, terminalAssistantMessage: { ...completed.terminalAssistantMessage, turnId: "other-turn" } });
    expect(feed().status.message).toBeNull();
    shell = conversation("chat", "failed");
    publisher.observe({ type: "agent.failed", ...owner, status: "failed", terminalReason: "provider-failed",
      message: "TimeoutError waiting for selector \"#submit\" after 30000ms in tests/login.test.ts:88." });
    expect(feed().status).toMatchObject({ phase: "failed", message: "TimeoutError waiting for selector \"#submit\" after 30000ms in tests/login.test.ts:88.", progress: null });
    publisher.update({ ...shell, lastViewedAt: "2026-09-06T13:00:00.000Z" });
    expect(feed().status).toEqual(emptyMascotStatus());
    expect(feed().chats).toEqual([expect.objectContaining({ phase: "failed", message: expect.stringContaining("TimeoutError") })]);
  });

  it("cancels its wake timer and stops publishing once closed", () => {
    const { publisher, publish, clock } = mascotPublisher();
    publisher.replace([conversation("done", "completed"), conversation("busy", "running")]);
    expect(clock.pending()).toBe(1);
    const published = publish.mock.calls.length;
    publisher.close();
    expect(clock.pending()).toBe(0);
    publisher.update(conversation("late", "failed"));
    clock.advance(8 * 24 * 60 * MINUTE);
    expect(publish).toHaveBeenCalledTimes(published);
    expect(clock.pending()).toBe(0);
  });

  it("does not arm a timer from a flush that was already queued when it closed", async () => {
    const publish = vi.fn();
    const clock = mascotTestClock();
    const publisher = new MascotStatusPublisher(publish, undefined, undefined, undefined, clock);
    publisher.replace([conversation("done", "completed")]);
    publisher.close();
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("uses the injected clock for every deadline", () => {
    const clock = mascotTestClock(Date.parse("2026-09-13T10:00:00.000Z"));
    const { publisher, feed } = mascotPublisher({ clock });
    publisher.replace([conversation("old", "completed")]);
    expect(feed().status).toEqual(emptyMascotStatus());
  });
});

describe("mascot message helpers", () => {
  it("takes the first prose sentence of a result, skipping headings, fences, rules, tables, quotes and list markers", async () => {
    const { mascotResultLine } = await import("../../src/server/runtime/mascot-message");
    expect(mascotResultLine("```ts\nconst hidden = true;\n```\n\n> **Done.** The tests pass.")).toBe("Done.");
    expect(mascotResultLine("# Title\n---\n| a | b |\n- Fixed the race in `server.ts`. Then more.")).toBe("Fixed the race in server.ts.");
    expect(mascotResultLine("1. Updated the docs")).toBe("Updated the docs");
    expect(mascotResultLine("## Only a heading")).toBeNull();
  });

  it("names a command approval's target only for commands and never a file approval's raw detail", async () => {
    const { mascotApprovalLine } = await import("../../src/server/runtime/mascot-message");
    expect(mascotApprovalLine({ kind: "command", title: "OpenCode wants to use bash", command: null, detail: "npm test", reason: null }))
      .toBe("OpenCode wants to use bash: npm test");
    expect(mascotApprovalLine({ kind: "file-change", title: "Approve file changes", command: null, detail: "Allow changes under /Users/someone/project", reason: null }))
      .toBe("Approve file changes");
    expect(mascotApprovalLine({ kind: "command", title: "Cursor requested permission", command: null, detail: "{\"input\":{\"command\":\"git push\"}}", reason: null }))
      .toBe("Cursor requested permission: git push");
    expect(mascotApprovalLine({ kind: "command", title: "Run", command: null, detail: "{broken", reason: null })).toBe("Run");
  });
});

describe("mascot prose", () => {
  it("keeps code blocks, file contents and image and emphasis markup out of the agent's words", async () => {
    const { mascotCommentaryLine, mascotResultLine } = await import("../../src/server/runtime/mascot-message");
    expect(mascotCommentaryLine("I'll update the config like this:\n```ts\nconst apiUrl = process.env.URL;\nexport default { apiUrl };\n```")).toBe("I'll update the config like this:");
    expect(mascotCommentaryLine("Here is the file I read.\n```\nDATABASE_URL=postgres://u:pw@host/db\n```")).toBe("Here is the file I read.");
    expect(mascotCommentaryLine("Here is the file I read.\n~~~\nDATABASE_URL=postgres://u:pw@host/db\n~~~\nNext I'll edit it.")).toBe("Here is the file I read. Next I'll edit it.");
    expect(mascotCommentaryLine("I read the settings file.\n\n    password = hunter2\n\tTOKEN=abc")).toBe("I read the settings file.");
    expect(mascotCommentaryLine("```\nonly code\n```")).toBeNull();
    expect(mascotResultLine("    rm -rf node_modules && npm ci\n\nDone.")).toBe("Done.");
    expect(mascotResultLine("![Screenshot of the page](/Users/me/shot.png)\n\nDone.")).toBe("Screenshot of the page");
    expect(mascotResultLine("*Fixed* the _login_ bug in `auth.ts`.")).toBe("Fixed the login bug in auth.ts.");
    expect(mascotResultLine("Renamed load_user_data to fetch_user and 2*3*4 stays.")).toBe("Renamed load_user_data to fetch_user and 2*3*4 stays.");
  });
});

describe("mascot activity titles", () => {
  it("scrubs paths and secrets from provider-authored titles before showing them", async () => {
    const { mascotActivityLine } = await import("../../src/server/runtime/mascot-message");
    expect(mascotActivityLine({ kind: "tool", title: "Read /Users/alice/.ssh/id_rsa", detail: null, status: "running" })).toBe("Read <path>");
    expect(mascotActivityLine({ kind: "command", title: "PGPASSWORD=hunter2 psql -h db", detail: null, status: "running" })).toBe("PGPASSWORD=[redacted] psql -h db");
  });
});

describe("mascot text bounds", () => {
  it("never cuts a character in half when it shortens text, and the boundary rejects a lone surrogate", async () => {
    const { mascotPreview, mascotCommand } = await import("../../src/server/runtime/mascot-message");
    const preview = mascotPreview(`${"a".repeat(278)}😀😀😀`)!;
    expect(preview).toBe(`${"a".repeat(278)}…`);
    expect(mascotPreview(`${"a".repeat(277)}😀😀😀`)).toBe(`${"a".repeat(277)}😀…`);
    expect(mascotCommand(`echo ${"b".repeat(53)}😀 done`)).toBe(`echo ${"b".repeat(53)}…`);
    const chat = { ...emptyMascotStatus(), phase: "running" as const, projectId: "p", conversationId: "c", runId: "r", turnId: "t", activeCount: 1 };
    expect(parseMascotStatus({ ...chat, message: "ok 😀" })).not.toBeNull();
    expect(parseMascotStatus({ ...chat, message: `${"a".repeat(278)}\ud83d…` })).toBeNull();
    expect(parseMascotStatus({ ...chat, chatTitle: "\ude00 title" })).toBeNull();
  });

  it("publishes well-formed text when a title or the agent's words were cut inside an emoji", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const title = `${"Please make the parser accept emoji in identifiers like this one".slice(0, 63)}😀`.slice(0, 64);
    const shell = { ...conversation("chat", "running"), title };
    const { publisher, feed } = mascotPublisher({ lookup: () => shell });
    publisher.replace([shell]);
    publisher.observe(said(`${"x".repeat(4_000)}. Short ${"y".repeat(85)}😀😀`, "2026-09-06T10:00:01.000Z"));
    const { status } = feed();
    expect(lone.test(status.chatTitle!)).toBe(false);
    expect(lone.test(status.message!)).toBe(false);
    expect(parseMascotFeed(JSON.parse(JSON.stringify(feed())) as Record<string, unknown>)).not.toBeNull();
    expect(mascotPreview("\ud83d and \ude00")).toBe("\ufffd and \ufffd");
    expect(mascotPreview(`${" ".repeat(4_095)}😀`)).toBeNull();
  });
});
