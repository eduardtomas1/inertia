import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { ResponseTimelineProps } from "../../src/renderer/src/components/ResponseTimeline";
import { finalAnswerAnchorTarget } from "../../src/renderer/src/components/response-timeline/final-answer-anchor";
import type { AgentActivity, AgentTurn, ChatMessage } from "../../src/shared/contracts";
import { chatMessageSchema } from "../../src/shared/contracts/chat-message-schema";

const conversationId = "16161616-1616-4161-8161-161616161616";
const turnId = "turn-sent-message";
const runId = "run-sent-message";
const DRAFT = [
  "## Release note",
  "",
  "Exports keep **UTF-8** in every locale.",
  "",
  "```ts",
  "write(file, \"utf8\");",
  "```",
  "",
  "<img src=x onerror=\"window.__sentMessageXss = true\">",
].join("\n");

function at(seconds: number): string {
  return `2030-06-01T10:00:${String(seconds).padStart(2, "0")}.000Z`;
}

type Phase = "running" | "settled" | "silent";

function agentTurn(phase: Phase): AgentTurn {
  const settled = phase !== "running";
  return {
    id: turnId,
    conversationId,
    runId,
    userMessageId: "request",
    terminalAssistantMessageId: phase === "settled" ? "answer" : null,
    providerId: "claude",
    modelSelection: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "native:claude:agent-sdk",
      backendProfileDisplayName: "Claude",
      backendConfigurationRevision: 1,
      modelId: "claude-test",
      alias: null,
      reasoningEffort: "high",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "native:claude:agent-sdk",
      backendConfigurationRevision: 1,
      endpointIdentity: null,
      modelIdentity: "claude-test",
    },
    harnessId: "claude-agent-sdk",
    backendProfileId: "native:claude:agent-sdk",
    model: "claude-test",
    modelAlias: null,
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: at(0),
    startedAt: at(1),
    completedAt: settled ? at(20) : null,
    status: settled ? "completed" : "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at(0),
    updatedAt: settled ? at(20) : at(12),
  };
}

function chatMessage(
  id: string,
  role: ChatMessage["role"],
  content: string,
  seconds: number,
  update: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, conversationId, turnId, role, content, attachments: [], createdAt: at(seconds), ...update };
}

function activity(id: string, title: string, seconds: number): AgentActivity {
  return {
    id, conversationId, runId, turnId, kind: "tool", title, detail: null, status: "completed", createdAt: at(seconds),
  };
}

const request = chatMessage("request", "user", "Draft the release note, then ask before publishing.", 0);
const preamble = chatMessage("preamble", "assistant", "Reading the changelog first.", 2);
const sent = chatMessage("sent", "system", DRAFT, 6, { sentToUser: true });
const answer = chatMessage("answer", "assistant", "Should I publish it?", 15);
const readTool = activity("tool-read", "Read CHANGELOG.md", 3);
const sendTool = activity("tool-send", "mcp__inertia-chat-manager__inertia_send_to_user", 5);
const afterTool = activity("tool-after", "Read docs/RELEASING.md", 8);

const noop = (): void => undefined;
const respond = async (): Promise<void> => undefined;

function props(
  phase: Phase,
  activities: AgentActivity[] = [readTool, sendTool, afterTool],
  messages: ChatMessage[] = [request, preamble, sent, ...(phase === "settled" ? [answer] : [])],
): ResponseTimelineProps {
  return {
    turns: [agentTurn(phase)],
    messages,
    activities,
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-sent-message",
    conversationId,
    streamingText: "",
    streamingReasoning: "",
    streamingChannel: null,
    approvals: [],
    inputRequests: [],
    showTimestamps: false,
    showThinking: false,
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: false,
    checkpointRestoreDisabled: false,
    onRespondToApproval: respond,
    onRespondToInput: respond,
    onRevertCheckpoint: noop,
    onOpenTurnDiff: noop,
    onCompareTurnArtifacts: noop,
    onOpenTurnFile: noop,
    onStop: noop,
  };
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

function sentRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-sent-message-id]")];
}

/** The turn's prose, work groups, message and answer, in document order. */
function order(): string[] {
  return [...element(`[data-turn-id='${turnId}']`).querySelectorAll<HTMLElement>(
    "[data-assistant-commentary-id], [data-activity-group], [data-sent-message-id], [data-terminal-answer-id]",
  )].map((node) => node.dataset.sentMessageId
    ? `sent:${node.dataset.sentMessageId}`
    : node.dataset.terminalAnswerId
      ? `answer:${node.dataset.terminalAnswerId}`
      : node.dataset.assistantCommentaryId
        ? `prose:${node.dataset.assistantCommentaryId}`
        : `work:${node.dataset.activityGroup}`);
}

afterEach(() => {
  cleanup();
  delete (window as { __sentMessageXss?: boolean }).__sentMessageXss;
});

describe("a message the agent showed mid-turn", () => {
  it("is valid transcript data", () => {
    expect(chatMessageSchema(sent)).toBe(true);
  });

  it("renders as the agent's Markdown at its place between prose and tool activity while the turn runs", () => {
    render(<ResponseTimeline {...props("running")} />);

    expect(order()).toEqual([
      "prose:preamble",
      "work:activity-group:tool-read",
      "sent:sent",
      "work:activity-group:tool-after",
    ]);
    const [row] = sentRows();
    expect(row!.getAttribute("aria-label")).toBe("Agent message");
    expect(row!.classList.contains("is-answer")).toBe(true);
    expect(row!.querySelector(".turn-sent-message-label")?.textContent).toBe("Sent mid-turn");
    expect(row!.querySelector("h2, h3")?.textContent).toBe("Release note");
    expect(row!.querySelector("strong")?.textContent).toBe("UTF-8");
    expect(row!.textContent).toContain("write(file, \"utf8\");");
    // The same sanitizing Markdown renderer as replies: no handler survives.
    expect(row!.querySelector("[onerror]")).toBeNull();
    expect((window as { __sentMessageXss?: boolean }).__sentMessageXss).toBeUndefined();
    // Its tool row reads as what it did.
    expect(element("[data-activity-group='activity-group:tool-read']").textContent).toContain("Showed a message");
    expect(element("[data-active-work-region]").contains(row!)).toBe(true);
  });

  it("stays in view when the settled turn folds its work, above the answer and apart from it", () => {
    render(<ResponseTimeline {...props("settled")} />);

    const toggle = element(".turn-fold-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-activity-group]")).toBeNull();
    expect(order()).toEqual(["sent:sent", "answer:answer"]);
    expect(sentRows()[0]!.textContent).toContain("Exports keep UTF-8 in every locale.");

    const final = element("[data-turn-layer='final-answer']");
    expect(final.textContent).toContain("Should I publish it?");
    expect(final.textContent).not.toContain("Release note");
    expect(finalAnswerAnchorTarget(element("[data-terminal-answer-id='answer']"))).toBe(final);
    expect(final.contains(sentRows()[0]!)).toBe(false);

    fireEvent.click(toggle);
    expect(element(".turn-fold-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(sentRows()).toHaveLength(1);
    expect(element("[data-turn-id] .turn-fold-body").contains(sentRows()[0]!)).toBe(false);
  });

  it("survives a fresh mount of the persisted chat", () => {
    const first = render(<ResponseTimeline {...props("settled")} />);
    expect(sentRows()).toHaveLength(1);
    first.unmount();
    expect(sentRows()).toHaveLength(0);

    render(<ResponseTimeline {...props("settled")} />);
    expect(order()).toEqual(["sent:sent", "answer:answer"]);
  });

  it("keeps a quiet settled turn's message in view with the usual spacing", () => {
    render(<ResponseTimeline {...props("settled", [], [request, sent, answer])} />);

    expect(document.querySelector(".turn-fold-toggle")).toBeNull();
    expect(element("[data-turn-layer='agent-execution']").classList.contains("is-quiet-settled")).toBe(false);
    expect(order()).toEqual(["sent:sent", "answer:answer"]);
  });

  it("does not count as a reply when the turn ended without one", () => {
    render(<ResponseTimeline {...props("silent")} />);

    expect(document.querySelector("[data-turn-layer='final-answer']")).toBeNull();
    expect(document.querySelector("[data-turn-jump-target='final']")).toBeNull();
    expect(element("[data-turn-id] .turn-fold-row").textContent).toMatch(/^Worked/u);
    expect(sentRows()).toHaveLength(1);
  });

  it("is never drawn as a system notice", () => {
    const notice = chatMessage("notice", "system", "Provider reconnected.", 7);
    render(<ResponseTimeline {...props("settled", undefined, [request, preamble, sent, notice, answer])} />);

    const notices = [...document.querySelectorAll("[data-turn-work-notice]")];
    expect(notices.map((node) => node.textContent)).toEqual(["Provider reconnected."]);
    expect(sentRows()).toHaveLength(1);
  });
});
