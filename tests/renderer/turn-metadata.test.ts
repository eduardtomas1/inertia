import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResponseTimeline,
  turnMetadataPresentation,
  type ResponseTimelineProps,
} from "../../src/renderer/src/components/ResponseTimeline";
import {
  buildResponseTimeline,
  type ResponseTurn,
} from "../../src/renderer/src/utils/responseTimeline";
import type {
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

const conversationId = "22222222-2222-4222-8222-222222222222";
const requestedAt = "2026-07-27T09:00:00.000Z";
const startedAt = "2026-07-27T09:00:05.000Z";
const completedAt = "2026-07-27T09:00:12.000Z";

function agentTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: "turn-metadata",
    conversationId,
    runId: "run-metadata",
    userMessageId: "user-metadata",
    terminalAssistantMessageId: "assistant-metadata",
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
      backendConfigurationRevision: 9,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 9,
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
    providerSessionAfter: "session-after",
    requestedAt,
    startedAt,
    completedAt,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 9,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: completedAt,
    ...overrides,
  };
}

function message(
  id: string,
  turnId: string,
  role: ChatMessage["role"],
  content: string,
  createdAt: string,
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

function responseTurn(turn: AgentTurn): ResponseTurn {
  const messages = [
    message(turn.userMessageId, turn.id, "user", "Show the run metadata.", turn.requestedAt),
    ...(turn.terminalAssistantMessageId && turn.completedAt
      ? [message(
          turn.terminalAssistantMessageId,
          turn.id,
          "assistant",
          "Run complete.",
          turn.completedAt,
        )]
      : []),
  ];
  const item = buildResponseTimeline({
    turns: [turn],
    messages,
    activities: [],
    reasonings: [],
    checkpoints: [],
  })[0];
  if (!item) throw new Error("Missing response turn");
  if (item.kind === "turn") return item.turn;
  const inferred = item.compatibility.inferredTurns.find(
    (candidate) => candidate.id === turn.id,
  );
  if (!inferred) throw new Error("Missing inferred response turn");
  return inferred;
}

function renderTimeline(turn: AgentTurn, showTimestamps = false): string {
  const messages = [
    message(turn.userMessageId, turn.id, "user", "Show the run metadata.", turn.requestedAt),
    ...(turn.terminalAssistantMessageId && turn.completedAt
      ? [message(
          turn.terminalAssistantMessageId,
          turn.id,
          "assistant",
          "Run complete.",
          turn.completedAt,
        )]
      : []),
  ];
  const props: ResponseTimelineProps = {
    turns: [turn],
    messages,
    activities: [],
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-metadata",
    conversationId,
    providers: [],
    streamingText: "",
    streamingReasoning: "",
    approvals: [],
    inputRequests: [],
    showTimestamps,
    showThinking: false,
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: false,
    checkpointRestoreDisabled: false,
    onRespondToApproval: async () => undefined,
    onRespondToInput: async () => undefined,
    onRevertCheckpoint: () => undefined,
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
    onStop: () => undefined,
  };
  return renderToStaticMarkup(createElement(ResponseTimeline, props));
}

function detailValue(turn: ResponseTurn, label: string, now?: number): string | undefined {
  return turnMetadataPresentation(turn, now).details
    .find((detail) => detail.label === label)?.value;
}

function cssBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex, `${marker} should exist`).toBeGreaterThanOrEqual(0);
  const openIndex = source.indexOf("{", markerIndex);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Unclosed CSS block for ${marker}`);
}

describe("final-answer turn metadata", () => {
  it("keeps completed, failed, stopped, and queued timing concise and truthful", () => {
    const completed = responseTurn(agentTurn());
    const failed = responseTurn(agentTurn({
      status: "failed",
      terminalReason: "provider-failed",
    }));
    const stopped = responseTurn(agentTurn({
      status: "interrupted",
      terminalReason: "app-restarted",
    }));
    const queued = responseTurn(agentTurn({
      terminalAssistantMessageId: null,
      providerSessionAfter: null,
      startedAt: null,
      completedAt: null,
      status: "queued",
      terminalReason: null,
      updatedAt: requestedAt,
    }));
    const failedBeforeStart = responseTurn(agentTurn({
      startedAt: null,
      completedAt: "2026-07-27T09:00:05.000Z",
      status: "failed",
      terminalReason: "startup-failed",
      updatedAt: "2026-07-27T09:00:05.000Z",
    }));

    expect(turnMetadataPresentation(completed)).toMatchObject({
      statusLabel: "Completed",
      durationLabel: "Worked 7s",
    });
    expect(turnMetadataPresentation(failed)).toMatchObject({
      statusLabel: "Failed",
      durationLabel: "Ran 7s",
    });
    expect(turnMetadataPresentation(stopped)).toMatchObject({
      statusLabel: "Stopped",
      durationLabel: "Ran 7s",
    });
    expect(turnMetadataPresentation(
      queued,
      Date.parse("2026-07-27T09:00:05.000Z"),
    )).toMatchObject({
      statusLabel: "Queued",
      durationLabel: "Queued 5s",
    });
    expect(detailValue(
      queued,
      "Execution duration",
      Date.parse("2026-07-27T09:00:05.000Z"),
    )).toBe("Not started");
    expect(turnMetadataPresentation(failedBeforeStart).durationLabel).toBe("Not started");
    expect(detailValue(failedBeforeStart, "Queue duration")).toBe("5s");
  });

  it("uses persisted historical/custom identity and redacts session and continuation secrets", () => {
    const turn = agentTurn({
      harnessId: "stale-legacy-harness",
      backendProfileId: "stale-legacy-backend",
      model: "stale-legacy-model",
      modelAlias: "stale-legacy-alias",
      reasoningEffort: "stale-legacy-reasoning",
      modelSelection: {
        harnessId: "custom-harness",
        backendProfileId: "custom:acme",
        backendProfileDisplayName: "Acme Gateway",
        modelId: "acme/code-pro",
        alias: null,
        reasoningEffort: null,
        contextWindowOverride: null,
        providerOptions: {
          apiKey: "provider-option-secret",
        },
        capabilities: [],
        backendConfigurationRevision: 71,
      },
      continuationIdentity: {
        harnessId: "continuation-secret-harness",
        backendProfileId: "continuation-secret-backend",
        backendConfigurationRevision: 72,
        modelIdentity: "continuation-secret-model",
        endpointIdentity: "https://secret.example/token/continuation-secret-token",
      },
      interactionMode: "plan",
      accessMode: "full",
      providerSessionBefore: "provider-session-before-secret",
      providerSessionAfter: "provider-session-after-secret",
      association: "inferred",
    });
    const html = renderTimeline(turn);
    const projected = responseTurn(turn);
    const primaryStart = html.indexOf('<div class="turn-meta-primary">');
    const primaryEnd = html.indexOf("</div>", primaryStart);
    const primary = html.slice(primaryStart, primaryEnd);

    expect(primary).toContain('data-turn-status="completed">Completed</span>');
    expect(primary).toContain('class="turn-duration">Worked 7s</span>');
    expect(primary).not.toContain("custom-harness");
    expect(primary).not.toContain("custom:acme");
    expect(primary).not.toContain("acme/code-pro");
    expect(detailValue(projected, "Harness ID")).toBe("custom-harness");
    expect(detailValue(projected, "Backend profile ID")).toBe("custom:acme");
    expect(detailValue(projected, "Exact model ID")).toBe("acme/code-pro");
    expect(detailValue(projected, "Requested alias")).toBe("Not requested");
    expect(detailValue(projected, "Reasoning level")).toBe("Default");
    expect(detailValue(projected, "Interaction mode")).toBe("plan");
    expect(detailValue(projected, "Access mode")).toBe("full");
    expect(detailValue(projected, "Historical association")).toBe("Inferred");
    expect(detailValue(projected, "Session continuation")).toBe("Resumed existing session");
    expect(html).not.toContain("<dt>");
    for (const secret of [
      "provider-session-before-secret",
      "provider-session-after-secret",
      "provider-option-secret",
      "continuation-secret-harness",
      "continuation-secret-backend",
      "continuation-secret-model",
      "secret.example",
      "continuation-secret-token",
      "stale-legacy-harness",
      "stale-legacy-backend",
      "stale-legacy-model",
      "stale-legacy-alias",
      "stale-legacy-reasoning",
    ]) {
      expect(html).not.toContain(secret);
    }
  });

  it("uses a quiet, keyboard-native button disclosure with explicit relationships", () => {
    const withoutTimestamp = renderTimeline(agentTurn());
    const withTimestamp = renderTimeline(agentTurn(), true);

    expect(withoutTimestamp).toContain('aria-label="Copy final answer"');
    expect(withoutTimestamp).toContain("<span>Copy</span>");
    expect(withoutTimestamp).not.toContain("<span>Copy answer</span>");
    expect(withoutTimestamp).not.toContain("<time");
    expect(withTimestamp).toContain(`<time dateTime="${completedAt}"`);
    expect(withoutTimestamp).toContain(
      '<button type="button" class="turn-run-details-toggle" id="turn-run-details-turn-metadata-label" aria-expanded="false" aria-controls="turn-run-details-turn-metadata">',
    );
    expect(withoutTimestamp).toContain("<span>Run details</span>");
    expect(withoutTimestamp).toContain(
      'id="turn-run-details-turn-metadata" aria-labelledby="turn-run-details-turn-metadata-label" hidden=""',
    );
  });

  it("stays uncarded, token-driven, focus-visible, and readable across themes, scales, and narrow widths", () => {
    const css = readFileSync(
      new URL("../../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    );
    const metadata = cssBlock(css, ".turn-meta {");
    const details = cssBlock(css, ".turn-run-details {");
    const focus = cssBlock(css, ".turn-run-details-toggle:focus-visible {");
    const narrow = cssBlock(css, "@container response-transcript (max-width: 440px)");

    expect(metadata).toContain("max-width: var(--answer-max-width)");
    expect(metadata).toContain("font-size: var(--metadata-font-size)");
    expect(details).toContain("border: 0");
    expect(details).toContain("background: transparent");
    expect(details).not.toContain("border-radius");
    expect(details).not.toContain("box-shadow");
    expect(focus).toContain("outline: 2px solid var(--accent)");
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain(':root[data-interface-scale="compact"]');
    expect(css).toContain(':root[data-interface-scale="large"]');
    expect(narrow).toMatch(
      /\.turn-run-details\s*>\s*div\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su,
    );
    expect(narrow).toMatch(
      /\.turn-run-details\s+dd\s*\{[^}]*overflow-wrap:\s*anywhere/su,
    );
  });
});
