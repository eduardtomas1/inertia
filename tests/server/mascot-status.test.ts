import { describe, expect, it, vi } from "vitest";
import type { AgentInputRequest, AgentApprovalRequest } from "../../src/shared/contracts/agent";
import type { ConversationShell } from "../../src/shared/contracts/app";
import { AGENT_RUN_STATES, agentTurnStatusForRunState, type AgentRunState } from "../../src/shared/run-state";
import { MascotStatusPublisher } from "../../src/server/runtime/mascot-status";
import { emptyMascotStatus, MASCOT_CHAT_LIMIT, parseMascotStatus } from "../../src/shared/mascot";

function conversation(id: string, state: AgentRunState): ConversationShell {
  return {
    id, projectId: "project", title: "Improve the desktop mascot", status: "idle",
    archivedAt: null, lastViewedAt: null,
    latestTurn: {
      id: `${id}-turn`, runId: `${id}-run`,
      status: agentTurnStatusForRunState(state),
      runState: { state, revision: 1, providerState: "PRIVATE PROVIDER TEXT" },
      completedAt: "2026-09-06T10:00:00.000Z",
      requestedAt: "2026-09-06T09:00:00.000Z",
      updatedAt: "2026-09-06T10:00:00.000Z",
    },
  } as ConversationShell;
}

describe("authoritative mascot status", () => {
  it.each(AGENT_RUN_STATES)("preserves exact %s state and full turn identity", (phase) => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    publisher.replace([conversation("chat", phase)]);
    const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(phase);
    const status = {
      phase, projectId: "project", conversationId: "chat", runId: "chat-run", turnId: "chat-turn",
      chatTitle: "Improve the desktop mascot", projectName: null, message: null, progress: null, steps: null,
      since: terminal ? "2026-09-06T10:00:00.000Z" : "2026-09-06T09:00:00.000Z",
      activeCount: terminal ? 0 : 1,
    };
    expect(publish).toHaveBeenLastCalledWith(status, [status], null, phase.startsWith("waiting-") ? 1 : 0);
    expect(JSON.stringify(publish.mock.calls)).not.toContain("PRIVATE");
  });

  it("prioritizes actionable requests over live work and unseen outcomes", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    publisher.replace([
      conversation("complete", "completed"), conversation("failure", "failed"),
      conversation("working", "running"), conversation("approval", "waiting-for-approval"),
    ]);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "waiting-for-approval", activeCount: 2 });
    publisher.update({ ...conversation("approval", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "running", activeCount: 1 });
    publisher.update({ ...conversation("working", "running"), archivedAt: "2026-09-06T11:00:00.000Z" });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "failed", activeCount: 0 });
  });

  it("does not replay seen results, invent completion for cancellation, or retain deleted chats", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    publisher.replace([{ ...conversation("old", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" }]);
    expect(publish).toHaveBeenLastCalledWith(emptyMascotStatus(), [expect.objectContaining({ conversationId: "old", phase: "completed" })], null, 0);
    publisher.update(conversation("cancelled", "cancelled"));
    expect(publish.mock.lastCall?.[0].phase).toBe("cancelled");
    publisher.replace([]);
    expect(publish).toHaveBeenLastCalledWith(emptyMascotStatus(), [], null, 0);
  });

  it("deduplicates shell/snapshot updates including streamed text metadata changes", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    const chat = conversation("chat", "running");
    publisher.replace([chat]);
    publisher.update({ ...chat, latestTurn: { ...chat.latestTurn!, updatedAt: "2026-09-06T12:00:00.000Z" } });
    publisher.replace([chat]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not switch live chat ownership when ordinary activity updates its timestamp", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    const first = conversation("a", "running");
    const second = conversation("b", "running");
    publisher.replace([first, second]);
    publisher.update({ ...second, latestTurn: { ...second.latestTurn!, updatedAt: "2026-09-06T12:00:00.000Z" } });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ conversationId: "a", activeCount: 2 });
    publisher.update(conversation("b", "waiting-for-input"));
    expect(publish.mock.lastCall?.[0]).toMatchObject({ conversationId: "b", phase: "waiting-for-input" });
  });
});

describe("mascot chat list", () => {
  it("ranks switchable chats, keeps seen results available, and adds project context", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    const seen = { ...conversation("seen", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" };
    const live = conversation("live", "running");
    live.latestTurn = { ...live.latestTurn!, startedAt: "2026-09-06T09:30:00+00:00" };
    publisher.replace([seen, live, conversation("question", "waiting-for-input"), { ...conversation("archived", "running"), archivedAt: "2026-09-06T11:00:00.000Z" }], [{ id: "project", name: "Inertia" }]);
    const [status, chats] = publish.mock.lastCall!;
    expect(status).toMatchObject({ conversationId: "question", projectName: "Inertia", activeCount: 2 });
    expect(chats.map(({ conversationId }: { conversationId: string }) => conversationId)).toEqual(["question", "live", "seen"]);
    expect(chats[1]).toMatchObject({ since: "2026-09-06T09:30:00.000Z", activeCount: 2 });
    expect(chats[2]).toMatchObject({ phase: "completed", since: "2026-09-06T10:00:00.000Z" });
    for (const chat of chats) expect(parseMascotStatus(chat)).toEqual(chat);
    publisher.replace(Array.from({ length: 12 }, (_, index) => conversation(`chat-${index}`, "running")));
    expect(publish.mock.lastCall?.[1]).toHaveLength(MASCOT_CHAT_LIMIT);
  });

  it("keeps a focused chat listed beyond the cap and echoes the focus", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    const pinned = { ...conversation("pinned", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" };
    const busy = Array.from({ length: 10 }, (_, index) => conversation(`busy-${index}`, "running"));
    publisher.replace([pinned, ...busy]);
    expect(publish.mock.lastCall?.[1].map(({ conversationId }: { conversationId: string }) => conversationId)).not.toContain("pinned");
    publisher.focus("pinned");
    const [, chats, focus] = publish.mock.lastCall!;
    expect(focus).toBe("pinned");
    expect(chats).toHaveLength(MASCOT_CHAT_LIMIT);
    expect(chats.at(-1)).toMatchObject({ conversationId: "pinned", phase: "completed" });
    publisher.replace(busy);
    expect(publish.mock.lastCall?.[1].map(({ conversationId }: { conversationId: string }) => conversationId)).not.toContain("pinned");
    expect(publish.mock.lastCall?.[2]).toBe("pinned");
    publisher.focus(null);
    expect(publish.mock.lastCall?.[2]).toBeNull();
  });

  it("publishes the true number of chats that need you beside the capped list", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    const pinned = { ...conversation("pinned", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" };
    const questions = Array.from({ length: 6 }, (_, index) => conversation(`question-${index}`, "waiting-for-input"));
    const approvals = Array.from({ length: 5 }, (_, index) => conversation(`approval-${index}`, "waiting-for-approval"));
    publisher.replace([pinned, ...questions, ...approvals, conversation("busy", "running")]);
    publisher.focus("pinned");
    const [status, chats, focus, attention] = publish.mock.lastCall!;
    expect(chats).toHaveLength(MASCOT_CHAT_LIMIT);
    expect(chats.filter(({ phase }: { phase: string }) => phase.startsWith("waiting-"))).toHaveLength(MASCOT_CHAT_LIMIT - 1);
    expect(focus).toBe("pinned");
    expect(attention).toBe(11);
    expect(status.activeCount).toBe(12);
    publisher.replace([pinned, conversation("busy", "running")]);
    expect(publish.mock.lastCall?.[3]).toBe(0);
  });

  it("reads project names from the snapshot and caches lookups for unknown projects", () => {
    const publish = vi.fn();
    const lookup = vi.fn((id: string) => id === "new" ? "Fresh project" : null);
    const publisher = new MascotStatusPublisher(publish, undefined, lookup);
    publisher.replace([conversation("a", "running"), conversation("b", "running")], [{ id: "project", name: "Inertia" }]);
    expect(publish.mock.lastCall?.[1].map(({ projectName }: { projectName: string }) => projectName)).toEqual(["Inertia", "Inertia"]);
    expect(lookup).not.toHaveBeenCalled();
    publisher.update({ ...conversation("c", "running"), projectId: "new" });
    publisher.update({ ...conversation("d", "running"), projectId: "new" });
    expect(lookup).toHaveBeenCalledOnce();
    expect(publish.mock.lastCall?.[1]).toContainEqual(expect.objectContaining({ conversationId: "d", projectName: "Fresh project" }));
  });

  it("names many snapshot chats without a project query per chat and follows renames and removals", () => {
    const publish = vi.fn();
    const lookup = vi.fn((id: string) => `Stored ${id}`);
    const publisher = new MascotStatusPublisher(publish, undefined, lookup);
    const chats = Array.from({ length: 60 }, (_, index) => ({
      ...conversation(`chat-${String(index).padStart(2, "0")}`, "running"), projectId: `project-${index % 3}`,
    }));
    const projects = [{ id: "project-0", name: "Alpha" }, { id: "project-1", name: "Beta" }, { id: "project-2", name: "Gamma" }];
    publisher.replace(chats, projects);
    publisher.replace(chats.map((chat) => ({ ...chat, title: `${chat.title} again` })), projects);
    expect(lookup).not.toHaveBeenCalled();
    expect(publish.mock.lastCall?.[1].map(({ projectName }: { projectName: string }) => projectName))
      .toEqual(["Alpha", "Beta", "Gamma", "Alpha", "Beta", "Gamma", "Alpha", "Beta"]);
    publisher.replace(chats, [{ id: "project-0", name: "Renamed" }, ...projects.slice(1)]);
    expect(publish.mock.lastCall?.[1][0]).toMatchObject({ conversationId: "chat-00", projectName: "Renamed" });
    publisher.replace(chats.filter(({ projectId }) => projectId !== "project-0"), projects.slice(1));
    expect(publish.mock.lastCall?.[1].map(({ projectName }: { projectName: string }) => projectName)).not.toContain("Renamed");
    publisher.replace(chats.slice(0, 2), []);
    expect(lookup.mock.calls).toEqual([["project-0"], ["project-1"]]);
    publisher.update({ ...chats[0]!, title: "Updated" });
    publisher.replace(chats.slice(0, 2), [{ id: "project-0", name: "Alpha again" }, { id: "project-1", name: "Beta" }]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(publish.mock.lastCall?.[1][0]).toMatchObject({ conversationId: "chat-00", projectName: "Alpha again" });
  });

  it("keeps plan steps with their turn and clears them when the turn ends", () => {
    const publish = vi.fn();
    let shell = conversation("chat", "running");
    const publisher = new MascotStatusPublisher(publish, () => shell);
    publisher.replace([shell]);
    publisher.observe({ type: "agent.plan.updated", plan: { ...owner, explanation: null, steps: [
      { step: "Sketch", status: "completed" }, { step: "Build", status: "inProgress" }, { step: "Ship", status: "pending" },
    ] } });
    expect(publish.mock.lastCall?.[0].steps).toEqual({ completed: 1, total: 3 });
    publisher.replace([shell]);
    expect(publish.mock.lastCall?.[1][0].steps).toEqual({ completed: 1, total: 3 });
    shell = conversation("chat", "completed");
    publisher.observe({ type: "agent.completed", ...owner, status: "completed", terminalReason: "completed", terminalAssistantMessage: null });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "completed", steps: null, progress: null });
  });
});

const owner = { conversationId: "chat", runId: "chat-run", turnId: "chat-turn" };
function input(id = "question"): AgentInputRequest {
  return { ...owner, id, providerId: "codex", autoResolutionMs: null, questions: [{
    id: "layout", header: "Layout", question: "Should the mascot follow all chats or only the selected chat?",
    isSecret: false, isOther: true, allowMultiple: false, options: [],
  }] };
}

describe("mascot context", () => {
  it("shows public commentary, activity, and measured plan progress without retaining reasoning or command output", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    publisher.replace([conversation("chat", "running")]);
    publisher.observe({ type: "agent.commentary.persisted", message: {
      id: "message", conversationId: "chat", turnId: "chat-turn", role: "assistant", attachments: [],
      content: "I’m checking the bubble layout and keyboard behavior.", createdAt: "2026-09-06T12:00:00.000Z",
    } });
    expect(publish.mock.lastCall?.[0].message).toBe("I’m checking the bubble layout and keyboard behavior.");
    publisher.observe({ type: "agent.plan.updated", plan: { ...owner, explanation: null, steps: [
      { step: "Update the bubble", status: "completed" }, { step: "Check keyboard access", status: "inProgress" },
    ] } });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ message: "Check keyboard access", progress: "1 of 2 steps complete" });
    const activity = { ...owner, id: "activity", title: "Run mascot_status tests", detail: "PRIVATE OUTPUT",
      kind: "command" as const, status: "running" as const, createdAt: "2026-09-06T12:01:00.000Z" };
    publisher.observe({ type: "agent.activity", activity });
    expect(publish.mock.lastCall?.[0].message).toBe("Run mascot_status tests");
    publisher.observe({ type: "agent.activity", activity: { ...activity, kind: "reasoning", title: "PRIVATE REASONING" } });
    publisher.observe({ type: "agent.reasoning", ...owner, text: "PRIVATE REASONING" });
    publisher.replace([conversation("chat", "running")]);
    expect(publish.mock.lastCall?.[0].message).toBe("Run mascot_status tests");
    expect(JSON.stringify(publish.mock.calls)).not.toContain("PRIVATE");
  });

  it("keeps questions actionable through background updates and clears only the resolved request", () => {
    const publish = vi.fn();
    let shell = conversation("chat", "running");
    const publisher = new MascotStatusPublisher(publish, () => shell);
    publisher.replace([shell]);
    shell = conversation("chat", "waiting-for-input");
    publisher.observe({ type: "agent.input.requested", request: input() });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "waiting-for-input", message: input().questions[0]!.question });
    const second = input("second");
    second.questions[0]!.question = "Which color should the bubble use?";
    publisher.observe({ type: "agent.input.requested", request: second });
    publisher.observe({ type: "agent.input.resolved", ...owner, requestId: "old-request" });
    expect(publish.mock.lastCall?.[0].message).toBe(input().questions[0]!.question);
    publisher.observe({ type: "agent.input.resolved", ...owner, requestId: "question" });
    expect(publish.mock.lastCall?.[0].message).toBe(second.questions[0]!.question);
    publisher.observe({ type: "agent.input.resolved", ...owner, requestId: "second" });
    expect(publish.mock.lastCall?.[0].message).toBeNull();
    shell = conversation("chat", "running");
    publisher.update(shell);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "running", message: null });
  });

  it("shows approval purpose, suppresses secret question content, and counts multiple questions", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    publisher.replace([conversation("chat", "waiting-for-approval")]);
    const request: AgentApprovalRequest = { ...owner, id: "approve", providerId: "codex", kind: "command",
      title: "Run the test suite", reason: "Verify the mascot changes", detail: "PRIVATE DETAIL", command: "PRIVATE COMMAND",
      cwd: null, networkScope: null, permissionRoots: [], availableDecisions: ["approve", "deny"] };
    publisher.observe({ type: "agent.approval.requested", request });
    expect(publish.mock.lastCall?.[0].message).toBe("Run the test suite — Verify the mascot changes");
    publisher.update(conversation("chat", "waiting-for-input"));
    const secret = input();
    secret.questions[0] = { ...secret.questions[0]!, isSecret: true, question: "PRIVATE SECRET PROMPT" };
    secret.questions.push(input().questions[0]!);
    publisher.observe({ type: "agent.input.requested", request: secret });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ message: "Sensitive information is needed. Answer privately in the chat.", progress: "2 questions to answer" });
    expect(JSON.stringify(publish.mock.calls)).not.toContain("PRIVATE");
  });

  it("rejects stale turn/run context, clears old previews on a new turn, and bounds plain text", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    publisher.replace([conversation("chat", "waiting-for-input")]);
    const request = input();
    request.questions[0]!.question = "\u202e**" + "A".repeat(10_000);
    publisher.observe({ type: "agent.input.requested", request });
    const status = publish.mock.lastCall?.[0];
    expect(status.message.length).toBe(280);
    expect(status.message.endsWith("…")).toBe(true);
    expect(parseMascotStatus(status)).toEqual(status);
    publisher.observe({ type: "agent.input.requested", request: { ...input(), runId: "stale" } });
    expect(publish.mock.lastCall?.[0]).toEqual(status);
    publisher.update({ ...conversation("chat", "running"), latestTurn: { ...conversation("chat", "running").latestTurn!, id: "new-turn" } });
    publisher.observe({ type: "agent.input.requested", request: input() });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ turnId: "new-turn", message: null, progress: null });
  });

  it("previews only the exact final result and replaces old activity with failure details", () => {
    const publish = vi.fn();
    let shell = conversation("chat", "running");
    const publisher = new MascotStatusPublisher(publish, () => shell);
    publisher.replace([shell]);
    shell = conversation("chat", "completed");
    const completed = { type: "agent.completed" as const, ...owner, status: "completed" as const, terminalReason: "completed",
      terminalAssistantMessage: { id: "final", conversationId: "chat", turnId: "chat-turn", role: "assistant" as const,
        content: "The bubble now shows live progress, questions, and results. Tests passed.", attachments: [], createdAt: "2026-09-06T12:00:00.000Z" } };
    publisher.observe(completed);
    expect(publish.mock.lastCall?.[0].message).toBe(completed.terminalAssistantMessage.content);
    publisher.observe({ ...completed, terminalAssistantMessage: { ...completed.terminalAssistantMessage, turnId: "other-turn" } });
    expect(publish.mock.lastCall?.[0].message).toBeNull();
    shell = conversation("chat", "failed");
    publisher.observe({ type: "agent.failed", ...owner, status: "failed", terminalReason: "provider-failed", message: "The provider connection was lost." });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "failed", message: "The provider connection was lost.", progress: null });
    publisher.update({ ...shell, lastViewedAt: "2026-09-06T13:00:00.000Z" });
    expect(publish.mock.lastCall?.[0]).toEqual(emptyMascotStatus());
    expect(publish.mock.lastCall?.[1]).toEqual([expect.objectContaining({ phase: "failed", message: "The provider connection was lost." })]);
  });
});
