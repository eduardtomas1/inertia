import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";
import {
  ResponseTimeline,
  turnCompletionAnnouncement,
} from "../../src/renderer/src/components/ResponseTimeline";
import {
  buildResponseTimeline,
  type ResponseTurn,
  type TurnGitArtifactSummary,
} from "../../src/renderer/src/utils/responseTimeline";

const conversationId = "11111111-1111-4111-8111-111111111111";

function message(
  id: string,
  turnId: string,
  role: ChatMessage["role"],
  content: string,
  createdAt = "2026-07-26T10:00:08.000Z",
): ChatMessage {
  return {
    id,
    conversationId,
    turnId,
    role,
    content,
    attachments: [],
    createdAt,
  };
}

function agentTurn(
  status: AgentTurn["status"],
  terminalAssistantMessageId: string | null,
): AgentTurn {
  const terminal = status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted";
  return {
    id: "turn-accessibility",
    conversationId,
    runId: "run-accessibility",
    userMessageId: "user-accessibility",
    terminalAssistantMessageId,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      modelId: "gpt-5.6",
      alias: "latest",
      reasoningEffort: "xhigh",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 3,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 3,
      modelIdentity: "gpt-5.6",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: "latest",
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: terminal ? "session-after" : null,
    requestedAt: "2026-07-26T10:00:00.000Z",
    startedAt: "2026-07-26T10:00:02.000Z",
    completedAt: terminal ? "2026-07-26T10:00:10.000Z" : null,
    status,
    terminalReason: terminal ? "provider-completed" : null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 3,
    association: "authoritative",
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T10:00:08.000Z",
  };
}

function activity(status: AgentActivity["status"]): AgentActivity {
  return {
    id: "activity-accessibility",
    conversationId,
    runId: "run-accessibility",
    turnId: "turn-accessibility",
    kind: "tool",
    title: "Inspect repository",
    detail: "Read the relevant files",
    status,
    createdAt: "2026-07-26T10:00:05.000Z",
  };
}

function artifact(): TurnGitArtifactSummary {
  return {
    id: "artifact-accessibility",
    turnId: "turn-accessibility",
    conversationId,
    runId: "run-accessibility",
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
    capturedAt: "2026-07-26T10:00:10.000Z",
    terminalAssistantMessageId: "assistant-accessibility",
    failureReason: null,
    insertions: 3,
    deletions: 1,
    files: [{
      path: "src/example.ts",
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
  };
}

function responseTurn(turn: AgentTurn, messages: ChatMessage[], activities: AgentActivity[]): ResponseTurn {
  const item = buildResponseTimeline({
    turns: [turn],
    messages,
    activities,
    reasonings: [],
    plans: [],
    approvals: [],
    inputRequests: [],
    checkpoints: [],
    gitArtifacts: [],
  })[0];
  if (!item || item.kind !== "turn") throw new Error("Expected an authoritative response turn");
  return item.turn;
}

function renderTimeline(input: {
  turn: AgentTurn;
  messages: ChatMessage[];
  activities?: AgentActivity[];
  gitArtifacts?: TurnGitArtifactSummary[];
  streamingText?: string;
}): string {
  return renderToStaticMarkup(createElement(ResponseTimeline, {
    turns: [input.turn],
    messages: input.messages,
    activities: input.activities ?? [],
    reasonings: [],
    plans: [],
    checkpoints: [],
    gitArtifacts: input.gitArtifacts ?? [],
    projectRoot: "/workspace",
    projectId: "project-accessibility",
    conversationId,
    providers: [],
    streamingText: input.streamingText ?? "",
    streamingReasoning: "",
    approvals: [],
    inputRequests: [],
    showTimestamps: false,
    showThinking: false,
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: true,
    checkpointRestoreDisabled: false,
    onRespondToApproval: async () => undefined,
    onRespondToInput: async () => undefined,
    onRevertCheckpoint: () => undefined,
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
    onStop: () => undefined,
  }));
}

describe("Quiet Ledger transcript accessibility", () => {
  it("keeps the reading order and disclosure relationships explicit", () => {
    const turn = agentTurn("completed", "assistant-accessibility");
    const html = renderTimeline({
      turn,
      messages: [
        message("user-accessibility", turn.id, "user", "Make the transcript calmer."),
        message("system-accessibility", turn.id, "system", "Provider resumed the run."),
        message("assistant-accessibility", turn.id, "assistant", "The focused pass is complete."),
      ],
      activities: [activity("completed")],
      gitArtifacts: [artifact()],
    });

    const user = html.indexOf('data-turn-layer="user-request"');
    const work = html.indexOf('data-turn-layer="agent-execution"');
    const workNotice = html.indexOf('data-turn-work-notice=""');
    const answer = html.indexOf('data-turn-layer="final-answer"');
    const ledger = html.indexOf('data-turn-layer="supporting-ledger"');
    const metadata = html.indexOf('aria-label="Final answer actions and run metadata"');
    const changedFiles = html.indexOf('aria-label="Changed by this turn"');
    const workEnd = html.indexOf("</section>", work);
    const ledgerEnd = html.indexOf("</section>", ledger);

    expect(user).toBeGreaterThanOrEqual(0);
    expect(work).toBeGreaterThan(user);
    expect(workNotice).toBeGreaterThan(work);
    expect(workNotice).toBeLessThan(workEnd);
    expect(answer).toBeGreaterThan(workEnd);
    expect(ledger).toBeGreaterThan(answer);
    expect(metadata).toBeGreaterThan(ledger);
    expect(changedFiles).toBeGreaterThan(metadata);
    expect(changedFiles).toBeLessThan(ledgerEnd);
    expect([...html.matchAll(/data-turn-layer="([^"]+)"/gu)].map((match) => match[1]))
      .toEqual(["user-request", "agent-execution", "final-answer", "supporting-ledger"]);
    expect(html).toContain('aria-label="Agent system notice"');
    expect(html).toContain('aria-label="Supporting turn ledger"');
    expect(html).toContain('aria-label="Copy final answer"');
    expect(html).toContain('aria-controls="turn-work-details-turn-accessibility"');
    expect(html).toContain('id="turn-work-details-turn-accessibility"');
    expect(html).toContain('aria-controls="turn-run-details-turn-accessibility"');
    expect(html).toContain('aria-controls="turn-changed-files-details-artifact-accessibility"');
    expect(html).toContain('id="turn-changed-files-details-artifact-accessibility"');
    expect(html).not.toContain('class="visually-hidden">Completed: </span>');

    const styles = readFileSync(
      new URL("../../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.turn-supporting-ledger\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/su,
    );
  });

  it("limits live announcements to stable work status and a one-time terminal transition", () => {
    const turn = agentTurn("running", null);
    const html = renderTimeline({
      turn,
      messages: [message("user-accessibility", turn.id, "user", "Stream a response.")],
      activities: [activity("running")],
      streamingText: "A token-by-token answer",
    });

    expect(html).toContain('class="turn-working-status" role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('class="turn-working-elapsed" aria-live="off"');
    expect(html).toContain('data-turn-completion-announcement=""');
    const finalAnswer = html.slice(
      html.indexOf('data-turn-layer="final-answer"'),
      html.indexOf("</article>", html.indexOf('data-turn-layer="final-answer"')),
    );
    expect(finalAnswer).not.toContain("aria-live");
    expect(html.match(/aria-live="polite"/gu)).toHaveLength(2);

    const workspaceSource = readFileSync(
      new URL("../../src/renderer/src/components/ChatWorkspace.tsx", import.meta.url),
      "utf8",
    );
    expect(workspaceSource).toContain('className="response-timeline">');
    expect(workspaceSource).not.toMatch(/className="response-timeline"\s+aria-live=/u);
  });

  it("announces only an active-to-terminal transition, never initial history or timer updates", () => {
    const activeTurn = agentTurn("running", null);
    const active = responseTurn(
      activeTurn,
      [message("user-accessibility", activeTurn.id, "user", "Run the pass.")],
      [activity("running")],
    );
    const completedTurn = agentTurn("completed", "assistant-accessibility");
    const completed = responseTurn(
      completedTurn,
      [
        message("user-accessibility", completedTurn.id, "user", "Run the pass."),
        message("assistant-accessibility", completedTurn.id, "assistant", "Done."),
      ],
      [activity("completed")],
    );

    expect(turnCompletionAnnouncement(false, completed, "Codex")).toBe("");
    expect(turnCompletionAnnouncement(true, active, "Codex")).toBe("");
    expect(turnCompletionAnnouncement(true, completed, "Codex"))
      .toBe("Codex: Worked for 8s · 1 action.");
    expect(turnCompletionAnnouncement(false, completed, "Codex")).toBe("");
  });
});
