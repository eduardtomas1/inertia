import { readFileSync } from "node:fs";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { ResponseTimelineProps } from "../../src/renderer/src/components/ResponseTimeline";
import { LiveElapsed } from "../../src/renderer/src/components/response-timeline/activity";
import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
  SubagentTrace,
  TurnGitArtifact,
} from "../../src/shared/contracts";

const conversationId = "16161616-1616-4161-8161-161616161616";
const css = readFileSync("src/renderer/src/styles.css", "utf8")
  .replace(/\r\n?/gu, "\n");

function at(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `2030-05-01T10:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000Z`;
}

function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} should exist`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

interface TurnFixture {
  id: string;
  status?: AgentTurn["status"];
  providerId?: AgentTurn["providerId"];
  completedAt?: string | null;
  answer?: string | null;
  request?: string;
  requestAttachments?: ChatMessage["attachments"];
  commentary?: Array<[string, string, number]>;
  activities?: Array<Partial<AgentActivity> & { id: string }>;
  reasoning?: string;
  start?: number;
}

function agentTurn(fixture: TurnFixture): AgentTurn {
  const start = fixture.start ?? 0;
  const status = fixture.status ?? "completed";
  const active = status === "running";
  const completedAt = fixture.completedAt === undefined
    ? active ? null : at(start + 62)
    : fixture.completedAt;
  return {
    id: fixture.id,
    conversationId,
    runId: `run-${fixture.id}`,
    userMessageId: `request-${fixture.id}`,
    terminalAssistantMessageId: fixture.answer === null || active ? null : `answer-${fixture.id}`,
    providerId: fixture.providerId ?? "codex",
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
    requestedAt: at(start),
    startedAt: at(start),
    completedAt,
    status,
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at(start),
    updatedAt: completedAt ?? at(start + 5),
  };
}

function message(
  turnId: string,
  id: string,
  role: ChatMessage["role"],
  content: string,
  seconds: number,
  attachments: ChatMessage["attachments"] = [],
): ChatMessage {
  return { id, conversationId, turnId, role, content, attachments, createdAt: at(seconds) };
}

function records(fixture: TurnFixture): {
  turn: AgentTurn;
  messages: ChatMessage[];
  activities: AgentActivity[];
  reasonings: AgentReasoning[];
} {
  const turn = agentTurn(fixture);
  const start = fixture.start ?? 0;
  const messages = [
    message(turn.id, turn.userMessageId, "user", fixture.request ?? "Tidy the parser.", start, fixture.requestAttachments),
    ...(fixture.commentary ?? []).map(([id, content, seconds]) =>
      message(turn.id, id, "assistant", content, start + seconds)),
  ];
  if (turn.terminalAssistantMessageId) {
    messages.push(message(turn.id, turn.terminalAssistantMessageId, "assistant", fixture.answer ?? "The parser is tidy.", start + 61));
  }
  const activities = (fixture.activities ?? []).map((activity, index): AgentActivity => ({
    conversationId,
    runId: turn.runId,
    turnId: turn.id,
    kind: "tool",
    title: "Read parser",
    detail: null,
    status: "completed",
    createdAt: at(start + 10 + index),
    ...activity,
  }));
  const reasonings: AgentReasoning[] = fixture.reasoning
    ? [{
        id: `reasoning-${turn.id}`,
        conversationId,
        runId: turn.runId,
        turnId: turn.id,
        content: fixture.reasoning,
        status: "completed",
        createdAt: at(start + 2),
      }]
    : [];
  return { turn, messages, activities, reasonings };
}

const noop = (): void => undefined;
const respond = async (): Promise<void> => undefined;

function props(
  fixtures: TurnFixture[],
  update: Partial<ResponseTimelineProps> = {},
): ResponseTimelineProps {
  const built = fixtures.map(records);
  return {
    turns: built.map(({ turn }) => turn),
    messages: built.flatMap(({ messages }) => messages),
    activities: built.flatMap(({ activities }) => activities),
    reasonings: built.flatMap(({ reasonings }) => reasonings),
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-fold",
    conversationId,
    streamingText: "",
    streamingReasoning: "",
    streamingChannel: null,
    approvals: [],
    inputRequests: [],
    showTimestamps: true,
    showThinking: true,
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: true,
    checkpointRestoreDisabled: false,
    onRespondToApproval: respond,
    onRespondToInput: respond,
    onRevertCheckpoint: noop,
    onOpenTurnDiff: noop,
    onCompareTurnArtifacts: noop,
    onOpenTurnFile: noop,
    onStop: noop,
    ...update,
  };
}

function gitArtifact(turnId: string): TurnGitArtifact {
  return {
    id: `artifact-${turnId}`,
    turnId,
    conversationId,
    runId: `run-${turnId}`,
    repositoryIdentity: "a".repeat(64),
    worktreeIdentity: "b".repeat(64),
    branch: "main",
    beforeCheckpointId: null,
    beforeFingerprint: "c".repeat(64),
    afterFingerprint: "d".repeat(64),
    status: "ready",
    completeness: "complete",
    patchState: "available",
    patchDigest: "e".repeat(64),
    capturedAt: at(62),
    terminalAssistantMessageId: null,
    failureReason: null,
    insertions: 3,
    deletions: 1,
    files: [{
      path: "src/parser.ts",
      previousPath: null,
      status: "M",
      insertions: 3,
      deletions: 1,
      binary: false,
      untracked: false,
      staged: false,
      unstaged: true,
      indexStatus: " ",
      worktreeStatus: "M",
    }],
  } as TurnGitArtifact;
}

const working: TurnFixture = {
  id: "turn-worked",
  requestAttachments: [{
    id: "11111111-1111-4111-8111-111111111111",
    name: "parser.png",
    path: "/workspace/parser.png",
    mimeType: "image/png",
    size: 2_048,
  }],
  commentary: [["interim", "Reading the parser before editing it.", 5]],
  activities: [
    { id: "read-parser" },
    { id: "run-tests", kind: "command", title: "Run tests", detail: "Command:\nnpm test" },
    { id: "compacted", kind: "status", title: "Context compacted", createdAt: at(30) },
  ],
  reasoning: "**Plan**\nRead first, then edit.",
};

function foldToggle(turnId: string): HTMLButtonElement {
  const section = document.querySelector<HTMLElement>(`[data-turn-id='${turnId}']`);
  if (!section) throw new Error(`Missing turn ${turnId}`);
  return within(section).getByRole("button", { name: /^(?:Worked|Stopped)/u }) as HTMLButtonElement;
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "inertia");
});

describe("finished-turn fold", () => {
  it("folds interim prose, routine work, thinking and settled subagents behind one row", () => {
    render(<ResponseTimeline {...props([working], {
      gitArtifacts: [gitArtifact(working.id)],
      subagents: [{ id: "trace-1", turnId: working.id, isLive: false, status: "completed" } as SubagentTrace],
    })} />);

    const toggle = foldToggle(working.id);
    expect(toggle).toHaveAccessibleName("Worked for 1m 2s");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.closest(".turn-fold-row")?.querySelector("time"))
      .toHaveAttribute("dateTime", at(0));
    expect(screen.queryByText("Reading the parser before editing it.")).not.toBeInTheDocument();
    expect(document.querySelector("[data-activity-group]")).toBeNull();
    expect(document.querySelector(".turn-thinking")).toBeNull();
    expect(document.querySelector(".subagent-group")).toBeNull();

    expect(screen.getByText("Tidy the parser.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Request attachments" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Final assistant answer" })).toHaveTextContent("The parser is tidy.");
    expect(document.querySelector(".turn-changed-files")).not.toBeNull();
    expect(document.querySelector(".context-compaction-separator")).not.toBeNull();
    const answer = screen.getByRole("article", { name: "Final assistant answer" });
    expect(toggle.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps a live or failed subagent in view while the rest of the work folds", () => {
    const view = render(<ResponseTimeline {...props([working], {
      subagents: [{ id: "trace-live", turnId: working.id, isLive: true, status: "running" } as SubagentTrace],
    })} />);

    expect(foldToggle(working.id)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "1 subagent, 1 working" })).toBeVisible();
    expect(document.querySelector(".turn-fold-body .subagent-group")).toBeNull();

    view.rerender(<ResponseTimeline {...props([working], {
      subagents: [{ id: "trace-failed", turnId: working.id, isLive: false, status: "failed" } as SubagentTrace],
    })} />);
    expect(foldToggle(working.id)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "1 subagent, 1 failed" })).toBeVisible();
    expect(document.querySelector(".turn-fold-body .subagent-group")).toBeNull();
  });

  it("moves a settled subagent group into the fold body, after the turn's work", async () => {
    const user = userEvent.setup();
    const trace = { id: "trace-done", turnId: working.id, isLive: false, status: "completed" } as SubagentTrace;
    render(<ResponseTimeline {...props([working], { subagents: [trace] })} />);

    expect(document.querySelector(".subagent-group")).toBeNull();
    await user.click(foldToggle(working.id));
    const body = document.getElementById(foldToggle(working.id).getAttribute("aria-controls")!)!;
    const group = within(body).getByRole("button", { name: "1 subagent, 1 done" });
    expect(document.querySelectorAll(".subagent-group")).toHaveLength(1);
    const stream = body.querySelector(".turn-execution-stream")!;
    expect(stream.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.closest(".subagent-group")).toHaveClass("is-idle");

    await user.click(foldToggle(working.id));
    expect(document.querySelector(".subagent-group")).toBeNull();
  });

  it("keeps the fold for a settled turn whose only work is its subagents", async () => {
    const user = userEvent.setup();
    const quiet: TurnFixture = { id: "turn-agents-only" };
    const trace = { id: "trace-only", turnId: quiet.id, isLive: false, status: "completed" } as SubagentTrace;
    render(<ResponseTimeline {...props([quiet], { subagents: [trace] })} />);

    expect(foldToggle(quiet.id)).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".subagent-group")).toBeNull();
    await user.click(foldToggle(quiet.id));
    expect(document.querySelector(".turn-fold-body .subagent-group")).not.toBeNull();
  });

  it("keeps a group that was live while watched outside the fold until the turn mounts again", async () => {
    const user = userEvent.setup();
    const live = { id: "trace-live", turnId: working.id, isLive: true, status: "running" } as SubagentTrace;
    const view = render(<ResponseTimeline {...props([working], { subagents: [live] })} />);

    await user.click(foldToggle(working.id));
    const group = screen.getByRole("button", { name: "1 subagent, 1 working" });
    expect(group.closest(".turn-fold-body")).toBeNull();
    expect(group.closest(".subagent-group")).toHaveAttribute("data-subagent-group", "live");
    expect(foldToggle(working.id).compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    group.focus();

    const done = { ...live, isLive: false, status: "completed" } as SubagentTrace;
    view.rerender(<ResponseTimeline {...props([working], { subagents: [done] })} />);
    const settled = screen.getByRole("button", { name: "1 subagent, 1 done" });
    expect(settled).toBe(group);
    expect(settled).toHaveFocus();
    expect(settled.closest(".turn-fold-body")).toBeNull();
    expect(document.querySelectorAll(".subagent-group")).toHaveLength(1);

    await user.click(foldToggle(working.id));
    expect(screen.getByRole("button", { name: "1 subagent, 1 done" })).toBeVisible();

    view.unmount();
    render(<ResponseTimeline {...props([working], { subagents: [done] })} />);
    expect(document.querySelector(".subagent-group")).toBeNull();
    await user.click(foldToggle(working.id));
    expect(screen.getByRole("button", { name: "1 subagent, 1 done" }).closest(".turn-fold-body")).not.toBeNull();
  });

  it("moves focus to the fold toggle when a focused group or agent row leaves the transcript", async () => {
    const user = userEvent.setup();
    const quiet: TurnFixture = { id: "turn-review", activities: [{ id: "read-review" }] };
    const review = { id: "trace-review", turnId: quiet.id, isLive: false, status: "unknown", providerName: "Checker" } as SubagentTrace;
    const view = render(<ResponseTimeline {...props([quiet], { subagents: [review], onOpenSurface: vi.fn() })} />);

    const group = screen.getByRole("button", { name: "1 subagent, 1 needs review" });
    expect(group.closest(".turn-fold-body")).toBeNull();
    expect(foldToggle(quiet.id)).toHaveAttribute("aria-expanded", "false");
    group.focus();
    view.rerender(<ResponseTimeline {...props([quiet], {
      subagents: [{ ...review, status: "completed" }],
      onOpenSurface: vi.fn(),
    })} />);
    expect(document.querySelector(".subagent-group")).toBeNull();
    await waitFor(() => expect(foldToggle(quiet.id)).toHaveFocus());

    view.rerender(<ResponseTimeline {...props([quiet], { subagents: [review], onOpenSurface: vi.fn() })} />);
    await user.click(screen.getByRole("button", { name: "1 subagent, 1 needs review" }));
    const row = screen.getByRole("button", { name: "Open Checker in Background tasks, Needs review" });
    row.focus();
    view.rerender(<ResponseTimeline {...props([quiet], {
      subagents: [{ ...review, status: "completed" }],
      onOpenSurface: vi.fn(),
    })} />);
    expect(row.isConnected).toBe(false);
    await waitFor(() => expect(foldToggle(quiet.id)).toHaveFocus());
  });

  it("shows a running turn's group live, outside any fold", () => {
    const running: TurnFixture = { id: "turn-running", status: "running", activities: [{ id: "read-running", status: "running" }] };
    const live = { id: "trace-running", turnId: running.id, isLive: true, status: "running" } as SubagentTrace;
    render(<ResponseTimeline {...props([running], { subagents: [live] })} />);

    const group = screen.getByRole("button", { name: "1 subagent, 1 working" });
    expect(group.closest(".turn-fold-body")).toBeNull();
    expect(document.querySelector(".turn-fold-row")).toBeNull();
    expect(group.closest(".subagent-group")).not.toHaveClass("is-idle");
  });

  it("never folds failure rows, pending approvals, a failed turn or the handoff divider", () => {
    const recovered: TurnFixture = {
      id: "turn-recovered",
      activities: [
        { id: "read-recovered" },
        { id: "failed-build", kind: "command", title: "Build failed", status: "failed" },
        { id: "provider-error", kind: "error", title: "Provider stream dropped", status: "failed" },
      ],
    };
    const failed: TurnFixture = { id: "turn-failed", status: "failed", answer: null, start: 120, activities: [{ id: "read-failed" }] };
    const waiting: TurnFixture = { id: "turn-waiting", start: 240, activities: [{ id: "read-waiting" }] };
    const handedOff: TurnFixture = { id: "turn-handed-off", providerId: "claude", start: 360, activities: [{ id: "read-handed-off" }] };
    const approval: AgentApprovalRequest = {
      id: "approval-1",
      providerId: "codex",
      conversationId,
      runId: "run-turn-waiting",
      turnId: "turn-waiting",
      kind: "command",
      title: "Approve the parser tests",
      detail: null,
      command: "npm test",
      cwd: "/workspace",
      reason: null,
      networkScope: null,
      permissionRoots: [],
      availableDecisions: ["approve", "deny", "cancel"],
    };
    render(<ResponseTimeline {...props([recovered, failed, waiting, handedOff], {
      approvals: [approval],
    })} />);

    const recoveredTurn = document.querySelector<HTMLElement>("[data-turn-id='turn-recovered']")!;
    expect(foldToggle("turn-recovered")).toHaveAttribute("aria-expanded", "false");
    expect(within(recoveredTurn).getByText("Failed · Provider stream dropped")).toBeVisible();
    expect(recoveredTurn.querySelector("[data-activity-group='activity-group:attention:turn-recovered']"))
      .not.toBeNull();

    const failedTurn = document.querySelector<HTMLElement>("[data-turn-id='turn-failed']")!;
    expect(failedTurn.querySelector(".turn-fold-toggle")).toBeNull();
    expect(failedTurn.querySelector(".turn-settled-summary")).toHaveTextContent("Failed after 1m 2s");

    const waitingTurn = document.querySelector<HTMLElement>("[data-turn-id='turn-waiting']")!;
    expect(waitingTurn.querySelector(".turn-fold-toggle")).toBeNull();
    expect(waitingTurn.querySelector("[data-agent-request-state='approval']")).not.toBeNull();

    expect(document.querySelector("[data-response-row-id='handoff:turn-handed-off']")).not.toBeNull();
    expect(foldToggle("turn-handed-off")).toBeInTheDocument();
  });

  it("labels the fold by how the turn ended and leaves the footer without a duration", () => {
    render(<ResponseTimeline {...props([
      working,
      { id: "turn-stopped", status: "cancelled", answer: null, start: 120, completedAt: at(132), activities: [{ id: "read-stopped" }] },
      { id: "turn-untimed", start: 240, completedAt: null, activities: [{ id: "read-untimed" }] },
      { id: "turn-answer-only", start: 360 },
    ])} />);

    expect(foldToggle(working.id)).toHaveAccessibleName("Worked for 1m 2s");
    expect(foldToggle("turn-stopped")).toHaveAccessibleName("Stopped after 12s");
    expect(foldToggle("turn-untimed")).toHaveAccessibleName("Worked");

    const workedFooter = document.querySelector(`[data-turn-id='${working.id}'] .turn-meta`)!;
    expect(workedFooter.querySelector(".turn-duration")).toBeNull();
    expect(workedFooter.querySelector("time")).not.toBeNull();
    expect(within(workedFooter as HTMLElement).getByRole("button", { name: "Run details" })).toBeInTheDocument();
    expect(document.querySelector("[data-turn-id='turn-stopped'] [data-turn-status='cancelled']")).toBeNull();

    const answerOnly = document.querySelector<HTMLElement>("[data-turn-id='turn-answer-only']")!;
    expect(answerOnly.querySelector(".turn-fold-toggle")).toBeNull();
    expect(answerOnly.querySelector(".turn-duration")).toHaveTextContent(/^Worked for 1m 2s$/u);
  });

  it("keeps the duration as a static row when a completed turn has neither work nor an answer", () => {
    render(<ResponseTimeline {...props([{ id: "turn-silent", answer: null }])} />);

    const silent = document.querySelector<HTMLElement>("[data-turn-id='turn-silent']")!;
    expect(silent.querySelector(".turn-fold-toggle")).toBeNull();
    expect(silent.querySelector("[data-turn-fold-row='static']")).toHaveTextContent("Worked for 1m 2s");
    expect(silent.querySelector(".turn-meta")).toBeNull();
  });

  it("expands with the keyboard, restores the chronology, and keeps the choice for the session", async () => {
    const user = userEvent.setup();
    const other: TurnFixture = { id: "turn-other", start: 120, activities: [{ id: "read-other" }] };
    const view = render(<ResponseTimeline {...props([working, other])} />);
    const toggle = foldToggle(working.id);

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(body).not.toHaveAttribute("hidden");
    const interim = within(body).getByText("Reading the parser before editing it.");
    expect(interim.closest("article")?.querySelector(".turn-block-time time"))
      .toHaveAttribute("dateTime", at(5));
    expect(body.querySelector("[data-activity-group]")).not.toBeNull();
    expect(body.querySelector(".turn-thinking")).not.toBeNull();
    expect(foldToggle("turn-other")).toHaveAttribute("aria-expanded", "false");

    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Reading the parser before editing it.")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    view.unmount();
    render(<ResponseTimeline {...props([working, other])} />);
    expect(foldToggle(working.id)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reading the parser before editing it.")).toBeInTheDocument();
    expect(foldToggle("turn-other")).toHaveAttribute("aria-expanded", "false");
  });

  it("reaches the fold row in the timeline's tab order", async () => {
    const user = userEvent.setup();
    render(<ResponseTimeline {...props([{ ...working, requestAttachments: [] }])} />);

    await user.tab();
    expect(screen.getByRole("button", { name: "Copy message" })).toHaveFocus();
    await user.tab();
    expect(foldToggle(working.id)).toHaveFocus();
  });

  it("follows the work-log setting until the reader chooses", () => {
    render(<ResponseTimeline {...props([working], { autoCollapseWorkLog: false })} />);

    expect(foldToggle(working.id)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reading the parser before editing it.")).toBeInTheDocument();
  });

  it("swaps the running header for the fold row in the same place", () => {
    const running: TurnFixture = { ...working, status: "running" };
    const view = render(<ResponseTimeline {...props([running])} />);
    const rail = document.querySelector(".turn-execution-rail");
    expect(rail).toHaveClass("is-live");
    expect(rail?.firstElementChild).toHaveClass("turn-working-state");

    view.rerender(<ResponseTimeline {...props([working])} />);
    const settledRail = document.querySelector(".turn-execution-rail");
    expect(settledRail).toBe(rail);
    expect(settledRail).toHaveAttribute("data-turn-fold", "closed");
    expect(document.querySelector(".turn-working-state")).toBeNull();
    expect(settledRail?.querySelector(".turn-fold-row")).not.toBeNull();
    expect(document.querySelector(`[data-turn-id='${working.id}']`)).toHaveClass("is-settling");

    for (const selector of [".turn-working-state", ".turn-fold-row"]) {
      expect(cssBlock(selector)).toContain("min-height: var(--ledger-row)");
      expect(cssBlock(selector)).toContain("border-bottom: 1px solid var(--line-soft)");
    }
    expect(cssBlock(".response-turn.is-settling .turn-execution-rail.is-settled"))
      .toContain("animation: quiet-ledger-settle-in var(--dur) var(--ease) both");
    const keyframes = css.slice(css.indexOf("@keyframes quiet-ledger-settle-in"));
    expect(keyframes.slice(0, keyframes.indexOf("}\n}"))).not.toContain("transform");
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".response-turn.is-settling .turn-execution-rail.is-settled");
  });

  it("styles the fold row as quiet chrome with a rotating chevron and a revealed time", () => {
    expect(cssBlock(".turn-fold-row")).toContain("font-size: var(--text-sm)");
    expect(cssBlock(".turn-fold-row")).toContain("color: var(--text-muted)");
    expect(cssBlock(".turn-fold-row")).toContain("font-weight: 400");
    expect(cssBlock(".turn-fold-chevron")).toContain("transition: transform var(--dur) var(--ease)");
    expect(cssBlock('.turn-fold-toggle[aria-expanded="true"] .turn-fold-chevron'))
      .toContain("transform: rotate(90deg)");
    expect(cssBlock(".turn-fold-time")).toContain("opacity: 0");
    expect(cssBlock(".turn-fold-row:is(:hover, :focus-within) .turn-fold-time")).toContain("opacity: 1");
    expect(css).toMatch(/@media \(pointer: coarse\) \{\n {2}\.turn-fold-time,\n {2}\.turn-block-time \{\n {4}opacity: 1;/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\.turn-fold-chevron,\n {2}\.turn-fold-time,\n {2}\.turn-block-time \{\n {4}transition: none;/u);
  });

  it("renders summaries of grouped work as sentences inside the open fold", async () => {
    const user = userEvent.setup();
    render(<ResponseTimeline {...props([{
      id: "turn-sentences",
      activities: [
        { id: "first-command", kind: "command", title: "Run tests", detail: "Command:\nnpm test" },
        { id: "second-command", kind: "command", title: "Run lint", detail: "Command:\nnpm run lint" },
        { id: "read-file", detail: "Path:\nsrc/parser.ts" },
        { id: "read-again", detail: "Path:\nsrc/parser.ts" },
      ],
    }, {
      id: "turn-unnamed-reads",
      start: 120,
      activities: [
        { id: "unnamed-command", kind: "command", title: "Run tests", detail: "Command:\nnpm test" },
        { id: "unnamed-read" },
        { id: "unnamed-read-2" },
      ],
    }])} />);

    await user.click(foldToggle("turn-sentences"));
    const summary = screen.getByRole("button", { name: "Ran 2 commands, read 1 file" });
    expect(summary).toHaveTextContent("Ran 2 commands, read 1 file");
    expect(summary.querySelector(".lucide-check")).not.toBeNull();
    await user.click(foldToggle("turn-unnamed-reads"));
    expect(screen.getByRole("button", { name: "Ran 1 command, did 2 reads" }))
      .toHaveTextContent("Ran 1 command, did 2 reads");
  });

  it("unmounts the fold row when an approval arrives on an already folded turn and shows the approval", async () => {
    const user = userEvent.setup();
    const view = render(<ResponseTimeline {...props([working])} />);
    await user.click(foldToggle(working.id));
    expect(foldToggle(working.id)).toHaveAttribute("aria-expanded", "true");
    const approval: AgentApprovalRequest = {
      id: "approval-late",
      providerId: "codex",
      conversationId,
      runId: `run-${working.id}`,
      turnId: working.id,
      kind: "command",
      title: "Approve the cleanup",
      detail: null,
      command: "npm run clean",
      cwd: "/workspace",
      reason: null,
      networkScope: null,
      permissionRoots: [],
      availableDecisions: ["approve", "deny", "cancel"],
    };
    view.rerender(<ResponseTimeline {...props([working], { approvals: [approval] })} />);
    const turn = document.querySelector<HTMLElement>(`[data-turn-id='${working.id}']`)!;
    expect(turn.querySelector(".turn-fold-row")).toBeNull();
    expect(turn.querySelector(".turn-fold-toggle")).toBeNull();
    expect(turn.querySelector("[data-agent-request-state='approval']")).not.toBeNull();
    expect(within(turn).getByText("Approve the cleanup")).toBeVisible();
  });

  it("shows No file changes in Run details for a quiet turn whose capture found none", async () => {
    const user = userEvent.setup();
    const quiet: TurnFixture = { id: "turn-unchanged" };
    render(<ResponseTimeline {...props([quiet], {
      gitArtifacts: [{ ...gitArtifact(quiet.id), files: [], insertions: 0, deletions: 0 }],
    })} />);
    const turn = document.querySelector<HTMLElement>(`[data-turn-id='${quiet.id}']`)!;
    expect(within(turn).queryByText("No file changes")).toBeNull();
    await user.click(within(turn).getByRole("button", { name: "Run details" }));
    expect(within(turn).getByText("No file changes")).toBeVisible();
  });
});

describe("subagent group inside a turn", () => {
  const runningTurn: TurnFixture = {
    id: "turn-live-agents",
    status: "running",
    activities: [{ id: "read-live", status: "running" }],
  };
  const liveTrace = (update: Partial<SubagentTrace> = {}): SubagentTrace => ({
    id: "trace-live-agent",
    turnId: runningTurn.id,
    providerId: "codex",
    providerName: "Explorer",
    providerRole: null,
    isLive: true,
    status: "running",
    description: "Map the parser.",
    progress: "Reading lexer.ts",
    result: null,
    durationMs: null,
    createdAt: at(1),
    updatedAt: at(2),
    ...update,
  } as SubagentTrace);

  function transcriptAt(distanceFromLatest: number): { current: HTMLDivElement } {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_400 },
      scrollTop: { configurable: true, writable: true, value: 1_000 - distanceFromLatest },
    });
    return { current: element };
  }

  it("keeps following the latest output when the group is toggled at the bottom of the running turn", async () => {
    const user = userEvent.setup();
    const onReaderNavigationIntent = vi.fn();
    const scrollElementRef = transcriptAt(0);
    const view = render(<ResponseTimeline {...props([runningTurn], {
      subagents: [liveTrace()],
      followsLatest: true,
      scrollElementRef,
      onReaderNavigationIntent,
    })} />);
    const group = screen.getByRole("button", { name: "1 subagent, 1 working" });
    await user.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    await user.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(onReaderNavigationIntent).not.toHaveBeenCalled();

    view.rerender(<ResponseTimeline {...props([runningTurn], {
      subagents: [liveTrace()],
      followsLatest: false,
      scrollElementRef,
      onReaderNavigationIntent,
    })} />);
    await user.click(group);
    expect(onReaderNavigationIntent).toHaveBeenCalledTimes(1);
  });

  it("treats a group or fold toggle in a settled turn as reading history only away from the latest message", async () => {
    const user = userEvent.setup();
    const onReaderNavigationIntent = vi.fn();
    const settledTurn: TurnFixture = { id: runningTurn.id, activities: [{ id: "read-settled" }] };
    const atLatest = transcriptAt(0);
    const view = render(<ResponseTimeline {...props([settledTurn], {
      subagents: [liveTrace({ status: "failed", isLive: false })],
      followsLatest: true,
      scrollElementRef: atLatest,
      onReaderNavigationIntent,
    })} />);
    await user.click(screen.getByRole("button", { name: "1 subagent, 1 failed" }));
    await user.click(foldToggle(settledTurn.id));
    expect(foldToggle(settledTurn.id)).toHaveAttribute("aria-expanded", "true");
    expect(onReaderNavigationIntent).not.toHaveBeenCalled();

    view.rerender(<ResponseTimeline {...props([settledTurn], {
      subagents: [liveTrace({ status: "failed", isLive: false })],
      followsLatest: true,
      scrollElementRef: transcriptAt(400),
      onReaderNavigationIntent,
    })} />);
    await user.click(screen.getByRole("button", { name: "1 subagent, 1 failed" }));
    expect(onReaderNavigationIntent).toHaveBeenCalledTimes(1);
    await user.click(foldToggle(settledTurn.id));
    expect(onReaderNavigationIntent).toHaveBeenCalledTimes(2);
  });

  it("does not re-render the turn for a progress tick on a collapsed group, and shows the latest line once opened", async () => {
    const user = userEvent.setup();
    let identityReads = 0;
    const providerIdentityLabels = new Proxy({}, {
      get: () => {
        identityReads += 1;
        return undefined;
      },
    });
    const base = props([runningTurn], { subagents: [liveTrace()], providerIdentityLabels, onOpenSurface: vi.fn() });
    const view = render(<ResponseTimeline {...base} />);
    const before = identityReads;
    expect(before).toBeGreaterThan(0);

    view.rerender(<ResponseTimeline {...base} subagents={[liveTrace({ progress: "Reading parser.ts", updatedAt: at(3) })]} />);
    expect(identityReads).toBe(before);

    await user.click(screen.getByRole("button", { name: "1 subagent, 1 working" }));
    const row = screen.getByRole("button", { name: "Open Explorer in Background tasks, Working" });
    expect(row).toHaveAccessibleDescription("Reading parser.ts");

    view.rerender(<ResponseTimeline {...base} subagents={[liveTrace({ progress: "Writing the summary", updatedAt: at(4) })]} />);
    expect(screen.getByRole("button", { name: "Open Explorer in Background tasks, Working" }))
      .toHaveAccessibleDescription("Writing the summary");

    const ticks = identityReads;
    view.rerender(<ResponseTimeline {...base} subagents={[liveTrace({ isLive: false, status: "completed", progress: "Writing the summary", updatedAt: at(5) })]} />);
    expect(identityReads).toBeGreaterThan(ticks);
    expect(screen.getByRole("button", { name: "1 subagent, 1 done" })).toBeInTheDocument();
  });
});

describe("running timer", () => {
  it("writes elapsed time to the DOM every second without re-rendering", async () => {
    vi.useFakeTimers();
    const startedAt = "2030-05-01T10:00:00.000Z";
    vi.setSystemTime(new Date(startedAt));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const commits = vi.fn();
    const view = render(
      <Profiler id="elapsed" onRender={commits}>
        <LiveElapsed startedAt={startedAt} />
      </Profiler>,
    );
    const initialCommits = commits.mock.calls.length;

    await act(async () => vi.advanceTimersByTime(3_000));
    expect(view.getByText("3.0s")).toBeInTheDocument();
    expect(commits).toHaveBeenCalledTimes(initialCommits);
  });
});

describe("user request meta", () => {
  it("shows the time and a Copy button beneath the bubble and copies the full message", async () => {
    const copyText = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText } as unknown as typeof window.inertia,
    });
    const long = `${"A long pasted requirement. ".repeat(120)}End.`;
    render(<ResponseTimeline {...props([{ ...working, request: long }])} />);

    const bubble = screen.getByRole("article", { name: "Your request" });
    const meta = bubble.nextElementSibling as HTMLElement;
    expect(meta).toHaveClass("turn-user-request-meta");
    expect(meta.querySelector("time")).toHaveAttribute("dateTime", at(0));
    expect(bubble.querySelector("time")).toBeNull();

    fireEvent.click(within(meta).getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(long));
    expect(await within(meta).findByRole("button", { name: "Message copied" })).toBeInTheDocument();
    expect(within(meta).getByRole("status")).toHaveTextContent("Message copied.");
  });

  it("keeps Copy without the time when message timestamps are off", () => {
    render(<ResponseTimeline {...props([working], { showTimestamps: false })} />);

    const meta = document.querySelector(".turn-user-request-meta")!;
    expect(meta.querySelector("time")).toBeNull();
    expect(within(meta as HTMLElement).getByRole("button", { name: "Copy message" })).toBeInTheDocument();
  });

  it("reveals the meta row on hover or focus without shifting the transcript", () => {
    const meta = cssBlock(".turn-user-request-meta");
    expect(meta).toContain("min-height: 24px");
    expect(meta).toContain("opacity: 0");
    expect(meta).toContain("font-size: var(--text-xs)");
    expect(meta).toContain("color: var(--text-muted)");
    expect(meta).toContain("transition: opacity var(--dur) var(--ease-fade)");
    expect(cssBlock(".turn-user-request:is(:hover, :focus-within) + .turn-user-request-meta,\n.turn-user-request-meta:is(:hover, :focus-within)"))
      .toContain("opacity: 1");
    expect(css).toMatch(/@media \(pointer: coarse\) \{\n {2}\.turn-user-request-meta \{\n {4}opacity: 1;/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\.turn-user-request-meta \{\n {4}transition: none;/u);
  });
});
