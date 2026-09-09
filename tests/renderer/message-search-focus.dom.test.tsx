import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMessageSearchDestination, useMessageSearchFocus } from "../../src/renderer/src/components/response-timeline/useMessageSearchFocus";
import { clearMessageSearchFocus, pendingMessageSearchFocus, requestMessageSearchFocus } from "../../src/renderer/src/utils/messageSearchFocus";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import { buildResponseTimeline, type ResponseTimelineItem } from "../../src/renderer/src/utils/responseTimeline";

const target = { projectId: "project", conversationId: "chat", turnId: null, messageId: "message" };
const message: ChatMessage = { id: "message", conversationId: "chat", turnId: null, role: "user", content: "needle", attachments: [], createdAt: "2026-09-07T00:00:00Z" };
afterEach(() => clearMessageSearchFocus());

describe("deferred message-search focus", () => {
  it.each(["user", "assistant"] as const)("focuses a saved %s message after a compaction receipt", (role) => {
    const focus = vi.fn();
    const reading = vi.fn();
    const user = { ...message, turnId: "turn" };
    const answer = { ...user, id: "answer", role: "assistant" as const };
    const receipt: ChatMessage = {
      ...message, id: "receipt", role: "system", content: "/compact",
      createdAt: "2026-09-06T00:00:00Z",
      compaction: { providerId: "codex", beforeTokens: null, afterTokens: null, instructionForwarded: false },
    };
    const turn = { id: user.turnId, conversationId: "chat", userMessageId: user.id,
      terminalAssistantMessageId: answer.id, association: "authoritative", status: "completed",
      requestedAt: user.createdAt, startedAt: user.createdAt, completedAt: user.createdAt } as AgentTurn;
    const messages = [receipt, user, answer];
    const timeline = buildResponseTimeline({ turns: [turn], messages, activities: [], reasonings: [], checkpoints: [] });
    expect(timeline.map(({ kind }) => kind)).toEqual(["compaction", "turn"]);
    const hit = role === "user" ? user : answer;
    requestMessageSearchFocus({ ...target, turnId: hit.turnId, messageId: hit.id });
    renderHook(() => useMessageSearchFocus(
      { conversationId: "chat", projectId: "project", messages }, timeline, reading, focus,
    ));
    expect(reading).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith(1, { messageId: hit.id, turnId: user.turnId });
    expect(pendingMessageSearchFocus("chat")).toBeNull();
  });

  it.each(["user", "assistant"] as const)("resolves a migrated inferred %s message through the real timeline projection", (role) => {
    const focus = vi.fn();
    const reading = vi.fn();
    const user = { ...message, turnId: "inferred-turn" };
    const answer = { ...user, id: "answer", role: "assistant" as const };
    const hit = role === "user" ? user : answer;
    const turn = { id: user.turnId, conversationId: "chat", userMessageId: user.id,
      terminalAssistantMessageId: answer.id, association: "inferred", status: "completed",
      requestedAt: user.createdAt, startedAt: user.createdAt, completedAt: user.createdAt } as AgentTurn;
    const timeline = buildResponseTimeline({ turns: [turn], messages: [user, answer], activities: [], reasonings: [], checkpoints: [] });
    expect(timeline[0]?.kind).toBe("compatibility");
    if (timeline[0]?.kind !== "compatibility") throw new Error("Expected recovered history.");
    expect(timeline[0].compatibility.messages).toEqual([]);
    expect(timeline[0].compatibility.inferredTurns).toHaveLength(1);
    requestMessageSearchFocus({ ...target, turnId: hit.turnId, messageId: hit.id });
    const hook = renderHook(({ messages, projectId }) => useMessageSearchFocus(
      { conversationId: "chat", projectId, messages }, timeline, reading, focus,
    ), { initialProps: { messages: [] as ChatMessage[], projectId: "project" } });
    expect(focus).not.toHaveBeenCalled();
    hook.rerender({ messages: [user, answer], projectId: "other" });
    expect(focus).not.toHaveBeenCalled();
    hook.rerender({ messages: [user, answer], projectId: "project" });
    expect(reading).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith(0, { messageId: hit.id, turnId: user.turnId });
    expect(pendingMessageSearchFocus("chat")).toBeNull();
    hook.rerender({ messages: [user, answer], projectId: "project" });
    expect(focus).toHaveBeenCalledOnce();
  });

  it("targets a follow-up by message identity instead of its enclosing turn", () => {
    const focus = vi.fn();
    const followUp = { ...message, id: "follow-up", turnId: "turn" };
    const timeline = [{ kind: "turn", turn: { id: "turn", userMessage: message } }] as ResponseTimelineItem[];
    renderHook(() => useMessageSearchFocus({ conversationId: "chat", projectId: "project", messages: [message, followUp] }, timeline, vi.fn(), focus));
    act(() => requestMessageSearchFocus({ ...target, turnId: "turn", messageId: followUp.id }));
    expect(focus).toHaveBeenCalledWith(0, { messageId: followUp.id, turnId: "turn" });
  });

  it.each(["work", "legacy", "ledger"])("expands %s history and waits for the exact message to mount", (kind) => {
    const row = document.createElement("section");
    row.innerHTML = kind === "work" ? '<div class="turn-work-log is-settled"><details></details></div>'
      : kind === "legacy" ? "<details></details>"
        : '<button class="turn-run-details-toggle" aria-expanded="false"></button>';
    const button = row.querySelector("button");
    const click = vi.fn(() => button?.setAttribute("aria-expanded", "true"));
    button?.addEventListener("click", click);
    const id = 'opaque-"[]\\-message';
    expect(resolveMessageSearchDestination(row, id)).toBeNull();
    if (button) expect(click).toHaveBeenCalledOnce();
    else expect(row.querySelector("details")?.open).toBe(true);
    const other = document.createElement("article");
    other.dataset.followUpMessageId = "other";
    row.append(other);
    expect(resolveMessageSearchDestination(row, id)).toBeNull();
    const exact = document.createElement("article");
    if (kind === "legacy") exact.dataset.messageSearchId = id;
    else exact.dataset.followUpMessageId = id;
    row.append(exact);
    expect(resolveMessageSearchDestination(row, id)).toBe(exact);
    if (button) expect(click).toHaveBeenCalledOnce();
  });

  it("opens recovered history before resolving the owning inferred turn", () => {
    const row = document.createElement("section");
    row.innerHTML = "<details></details>";
    expect(resolveMessageSearchDestination(row, "answer", "inferred-turn")).toBeNull();
    expect(row.querySelector("details")?.open).toBe(true);
    const nested = document.createElement("section");
    nested.dataset.turnId = "inferred-turn";
    const answer = document.createElement("article");
    answer.dataset.terminalAnswerId = "answer";
    nested.append(answer);
    row.querySelector("details")!.append(nested);
    expect(resolveMessageSearchDestination(row, "answer", "inferred-turn")).toBe(answer);
    expect(resolveMessageSearchDestination(row, "answer", "unrelated-turn")).toBeNull();
  });

  it("reveals the full matched request before focusing its collapsed preview", () => {
    const row = document.createElement("section");
    row.innerHTML = '<article data-message-search-id="request"><button class="turn-user-request-expand" aria-expanded="false"></button></article>';
    const button = row.querySelector("button")!;
    const expand = vi.fn(() => button.setAttribute("aria-expanded", "true"));
    button.addEventListener("click", expand);
    expect(resolveMessageSearchDestination(row, "request")).toBeNull();
    expect(expand).toHaveBeenCalledOnce();
    expect(resolveMessageSearchDestination(row, "request")).toBe(row.firstElementChild);
    expect(expand).toHaveBeenCalledOnce();
  });

  it("does not redirect another timeline or outlive the requesting navigation", () => {
    const focus = vi.fn();
    let current = true;
    const timeline = buildResponseTimeline({ turns: [], messages: [message], activities: [], reasonings: [], checkpoints: [] });
    renderHook(() => useMessageSearchFocus({ conversationId: "other", projectId: "project", messages: [message] }, timeline, vi.fn(), focus));
    act(() => requestMessageSearchFocus(target, () => current));
    expect(focus).not.toHaveBeenCalled();
    current = false;
    expect(pendingMessageSearchFocus("chat")).toBeNull();
  });
});
