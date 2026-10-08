/**
 * @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
 */
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { ResponseTimelineProps } from "../../src/renderer/src/components/ResponseTimeline";
import { startFinalAnswerAnchor } from "../../src/renderer/src/components/response-timeline/final-answer-anchor";
import type { FinalAnswerAutoScrollEvent } from "../../src/renderer/src/components/response-timeline/types";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

const conversationId = "15151515-1515-4151-8151-151515151515";
const turnId = "turn-answer-tail";
const runId = "run-answer-tail";
const renderId = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const ANSWER = "Q3 carried the year.";
const PREAMBLE = "Drawing the revenue chart.";

function at(seconds: number): string {
  return `2030-05-01T10:00:${String(seconds).padStart(2, "0")}.000Z`;
}

type Phase = "running" | "gap" | "settled";

function agentTurn(phase: Phase): AgentTurn {
  const settled = phase !== "running";
  return {
    id: turnId,
    conversationId,
    runId,
    userMessageId: "request",
    terminalAssistantMessageId: phase === "settled" ? "answer" : null,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      backendConfigurationRevision: 1,
      modelId: "gpt-5.6",
      alias: null,
      reasoningEffort: "high",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 1,
      endpointIdentity: null,
      modelIdentity: "gpt-5.6",
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: null,
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: at(0),
    startedAt: at(1),
    completedAt: settled ? at(9) : null,
    status: settled ? "completed" : "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at(0),
    updatedAt: settled ? at(9) : at(6),
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

function activity(id: string, kind: AgentActivity["kind"], title: string, seconds: number): AgentActivity {
  return {
    id,
    conversationId,
    runId,
    turnId,
    kind,
    title,
    detail: null,
    status: "completed",
    createdAt: at(seconds),
  };
}

const request = chatMessage("request", "user", "Chart revenue by quarter.", 0);
const preamble = chatMessage("preamble", "assistant", PREAMBLE, 3);
const renderTool = activity("tool-render", "tool", "inertia_render_html", 4);
const page = chatMessage("render", "system", "Rendered page: Revenue", 5, {
  htmlRender: { renderId, title: "Revenue", height: 360 },
});
const answer = chatMessage("answer", "assistant", ANSWER, 8);

const noop = (): void => undefined;
const respond = async (): Promise<void> => undefined;

function props(
  phase: Phase,
  messages: ChatMessage[],
  streamingText = "",
  activities: AgentActivity[] = [renderTool],
): ResponseTimelineProps {
  return {
    turns: [agentTurn(phase)],
    messages: [request, preamble, ...messages],
    activities,
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-answer-tail",
    conversationId,
    streamingText,
    streamingReasoning: "",
    streamingChannel: streamingText ? "text" : null,
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

function element(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

function precedes(left: Element, right: Element): boolean {
  return Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function layers(): Array<string | null> {
  return [...document.querySelectorAll("[data-turn-layer]")]
    .map((layer) => layer.getAttribute("data-turn-layer"));
}

function turnSection(): Element {
  return element(`[data-turn-id='${turnId}']`);
}

describe("the answer after a visual reply", () => {
  it("streams the answer below the page and keeps it out of the work rail", () => {
    render(<ResponseTimeline {...props("running", [page], ANSWER)} />);

    const figure = element("[data-testid='html-render']");
    const tail = element("[data-turn-layer='answer-tail']");
    const rail = element("[data-active-work-region]");
    expect(layers()).toEqual(["user-request", "agent-execution", "html-renders", "answer-tail"]);
    expect(precedes(figure, tail)).toBe(true);
    expect(tail.textContent).toContain(ANSWER);
    expect(rail.textContent).not.toContain(ANSWER);
    expect(rail.textContent).toContain(PREAMBLE);

    const row = tail.querySelector(`[data-assistant-commentary-id='live-commentary:${turnId}']`);
    expect(row?.getAttribute("aria-label")).toBe("Live agent update");
    expect(row?.querySelector("[data-stream-renderer='plain-text']")).not.toBeNull();
    expect(tail.hasAttribute("aria-live")).toBe(false);
    expect(tail.querySelector("[aria-live], [role='status']")).toBeNull();
    expect(document.querySelector("[data-turn-layer='final-answer']")).toBeNull();
    expect(document.querySelector("[data-turn-jump-target='final']")).toBeNull();
  });

  it("keeps the saved answer text in the same place before the turn settles", () => {
    const saved = chatMessage("answer", "assistant", ANSWER, 7);
    render(<ResponseTimeline {...props("running", [page, saved])} />);

    const tail = element("[data-turn-layer='answer-tail']");
    expect(precedes(element("[data-testid='html-render']"), tail)).toBe(true);
    expect(tail.querySelector("[data-assistant-commentary-id='answer']")?.textContent).toContain(ANSWER);
    expect(element("[data-active-work-region]").textContent).not.toContain(ANSWER);
    expect(document.querySelector("[data-turn-layer='final-answer']")).toBeNull();
  });

  it("swaps the tail for the saved answer in the same place without a reveal", () => {
    const view = render(<ResponseTimeline {...props("running", [page], ANSWER)} />);
    view.rerender(<ResponseTimeline {...props("settled", [page, answer])} />);

    expect(layers()).toEqual(["user-request", "agent-execution", "html-renders", "final-answer", "supporting-ledger"]);
    const final = element("[data-turn-layer='final-answer']");
    expect(precedes(element("[data-testid='html-render']"), final)).toBe(true);
    expect(final.textContent).toContain(ANSWER);
    expect(document.querySelector("[data-turn-layer='answer-tail']")).toBeNull();
    expect(turnSection().classList.contains("is-settling")).toBe(true);
    expect(turnSection().classList.contains("is-revealing-settled-answer")).toBe(false);
  });

  it("does not reveal the answer after a settlement gap that followed a visible tail", () => {
    const view = render(<ResponseTimeline {...props("running", [page], ANSWER)} />);
    view.rerender(<ResponseTimeline {...props("gap", [page], ANSWER)} />);

    expect(document.querySelector("[data-turn-layer='answer-tail']")).toBeNull();
    expect(document.body.textContent).not.toContain(ANSWER);

    view.rerender(<ResponseTimeline {...props("settled", [page, answer])} />);
    expect(element("[data-turn-layer='final-answer']").textContent).toContain(ANSWER);
    expect(turnSection().classList.contains("is-settling")).toBe(true);
    expect(turnSection().classList.contains("is-revealing-settled-answer")).toBe(false);
  });

  it("still reveals an answer that was never shown live", () => {
    const view = render(<ResponseTimeline {...props("running", [page])} />);
    expect(document.querySelector("[data-turn-layer='answer-tail']")).toBeNull();

    view.rerender(<ResponseTimeline {...props("settled", [page, answer])} />);
    expect(turnSection().classList.contains("is-revealing-settled-answer")).toBe(true);
  });

  it("returns the text to the work rail when work follows the page", () => {
    const followUp = activity("command-after", "command", "Run the report script", 6);
    render(<ResponseTimeline {...props("running", [page], ANSWER, [renderTool, followUp])} />);

    expect(document.querySelector("[data-turn-layer='answer-tail']")).toBeNull();
    const row = element(`[data-assistant-commentary-id='live-commentary:${turnId}']`);
    expect(element("[data-active-work-region]").contains(row)).toBe(true);
    expect(precedes(row, element("[data-testid='html-render']"))).toBe(true);
  });
});

describe("the settled answer anchor after a visual reply", () => {
  function placed(element: HTMLElement, scroller: HTMLElement, top: number, height: number): void {
    element.getBoundingClientRect = () => {
      const y = top - scroller.scrollTop;
      return { x: 0, y, top: y, bottom: y + height, left: 0, right: 800, width: 800, height, toJSON: () => ({}) } as DOMRect;
    };
  }

  async function anchoredScrollTop(withRenders: boolean): Promise<number> {
    const scroller = document.createElement("div");
    const root = document.createElement("div");
    const section = document.createElement("section");
    section.dataset.turnId = turnId;
    const renders = document.createElement("div");
    renders.dataset.turnLayer = "html-renders";
    const final = document.createElement("article");
    final.dataset.terminalAnswerId = "answer";
    section.append(...(withRenders ? [renders, final] : [final]));
    root.append(section);
    scroller.append(root);
    document.body.append(scroller);
    Object.defineProperty(scroller, "clientHeight", { value: 600 });
    Object.defineProperty(scroller, "scrollHeight", { value: 4_000 });
    scroller.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, toJSON: () => ({}) }) as DOMRect;
    placed(renders, scroller, 1_000, 360);
    placed(final, scroller, 1_400, 120);

    const events: FinalAnswerAutoScrollEvent[] = [];
    startFinalAnswerAnchor({
      conversationId,
      answerId: "answer",
      scrollElement: scroller,
      root,
      virtualized: false,
      getAnswerIndex: () => 0,
      scrollToIndex: vi.fn(),
      activeOwner: { current: null },
      cancelLayoutAnchorRestoration: vi.fn(),
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => expect(events.at(-1)?.status).toBe("positioned"));
    scroller.remove();
    return scroller.scrollTop;
  }

  it("lands on the top of the turn's renders so the page and answer arrive together", async () => {
    expect(await anchoredScrollTop(true)).toBe(992);
  });

  it("still lands on the answer itself when the turn has no renders", async () => {
    expect(await anchoredScrollTop(false)).toBe(1_392);
  });
});
