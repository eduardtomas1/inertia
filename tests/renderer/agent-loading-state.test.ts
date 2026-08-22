import { describe, expect, it } from "vitest";

import type {
  AgentActivity,
  AgentReasoning,
  AgentTurn,
  AgentTurnStatus,
} from "../../src/shared/contracts";
import {
  activeAgentPresentation,
  activityExecutionCategory,
  type ResponseTurn,
} from "../../src/renderer/src/utils/responseTimeline";
import {
  applyTerminalTurnProjections,
  reconcileTerminalTurnProjections,
  withTerminalTurnProjection,
} from "../../src/renderer/src/utils/terminalTurnProjection";

const createdAt = "2026-08-12T12:00:00.000Z";

function activity(
  id: string,
  title: string,
  update: Partial<AgentActivity> = {},
): AgentActivity {
  return {
    id,
    conversationId: "conversation-loading-state",
    runId: "run-loading-state",
    turnId: "turn-loading-state",
    kind: "tool",
    title,
    detail: null,
    status: "running",
    createdAt,
    ...update,
  };
}

function reasoning(status: AgentReasoning["status"]): AgentReasoning {
  return {
    id: "reasoning-loading-state",
    conversationId: "conversation-loading-state",
    runId: "run-loading-state",
    turnId: "turn-loading-state",
    content: "Provider-authored summary",
    status,
    createdAt,
  };
}

function turn(
  status: AgentTurnStatus,
  activities: AgentActivity[] = [],
  currentReasoning: AgentReasoning | null = null,
  runState?: AgentTurn["runState"],
): Pick<ResponseTurn, "agentTurn" | "activities" | "reasoning"> {
  return {
    agentTurn: { status, ...(runState ? { runState } : {}) } as AgentTurn,
    activities,
    reasoning: currentReasoning,
  };
}

describe("truthful active agent presentation", () => {
  it("uses authoritative lifecycle states before activity inference", () => {
    const cases: Array<[
      AgentTurnStatus,
      string,
      string,
      boolean,
    ]> = [
      ["queued", "queued", "Claude · Anthropic is queued", true],
      ["starting", "starting", "Claude · Anthropic is starting", true],
      [
        "waiting-for-approval",
        "waiting-for-approval",
        "Claude · Anthropic needs approval",
        false,
      ],
      [
        "waiting-for-input",
        "waiting-for-input",
        "Claude · Anthropic is waiting for input",
        false,
      ],
    ];

    for (const [status, phase, label, animated] of cases) {
      expect(activeAgentPresentation({
        turn: turn(status, [activity("ignored", "Web search")]),
        providerLabel: "Claude · Anthropic",
        streamingChannel: "text",
      })).toEqual({ phase, label, animated });
    }
  });

  it("does not let inferred activity hide delegated, retry, or stopping truth", () => {
    for (const [state, phase, label, providerState] of [
      ["delegated", "delegated", "OpenCode delegating", "verified descendant"],
      ["retrying", "retrying", "OpenCode retrying", "session.status/retry"],
      ["cancelling", "cancelling", "OpenCode stopping", "cancel/requested"],
    ] as const) {
      expect(activeAgentPresentation({
        turn: turn(
          "running",
          [activity("ignored", "Web search")],
          null,
          { state, providerState, revision: 2 },
        ),
        providerLabel: "OpenCode",
        streamingChannel: "text",
      })).toEqual({
        phase,
        label,
        animated: true,
      });
    }
  });

  it("classifies only explicit provider activity as search or code work", () => {
    for (const [id, title] of [
      ["web-search", "Web search"],
      ["browse", "Browse documentation"],
      ["search", "Search release documentation"],
      ["claude-web-search", "WebSearch"],
      ["claude-web-fetch", "WebFetch"],
      ["camel-web-search", "webSearch"],
      ["camel-web-fetch", "webFetch"],
      ["snake-web-search", "web_search"],
      ["snake-web-fetch", "web_fetch"],
      ["kebab-web-search", "web-search"],
      ["kebab-web-fetch", "web-fetch"],
    ] as const) {
      expect(activityExecutionCategory(activity(id, title)))
        .toBe("searching");
    }
    for (const [id, title] of [
      ["claude-edit", "Edit"],
      ["claude-write", "Write"],
      ["claude-notebook-edit", "NotebookEdit"],
      ["snake-notebook-edit", "notebook_edit"],
      ["code", "Apply patch"],
      ["edit", "Edit response timeline"],
      ["file-change", "File change"],
      ["overlap", "Edit web config"],
    ] as const) {
      expect(activityExecutionCategory(activity(id, title)))
        .toBe("coding");
    }
    expect(activityExecutionCategory(activity("ordinary-web", "Build web app")))
      .toBe("tool");
    expect(activityExecutionCategory(activity("ordinary-config", "Web config")))
      .toBe("tool");
    expect(activityExecutionCategory(activity(
      "ordinary-results",
      "WebSearch results",
    ))).toBe("tool");
    expect(activityExecutionCategory(activity("ordinary-fetch", "Fetch website")))
      .toBe("tool");
    expect(activityExecutionCategory(activity("ordinary-write", "Write to stdin")))
      .toBe("tool");
    expect(activityExecutionCategory(activity("ordinary-report", "Write report")))
      .toBe("tool");
    expect(activityExecutionCategory(activity("read", "Read response timeline")))
      .toBe("tool");
    expect(activityExecutionCategory(activity("command", "Command", {
      kind: "command",
    }))).toBe("command");
    expect(activityExecutionCategory(activity("search-command", "Search repository", {
      kind: "command",
    }))).toBe("command");
    expect(activityExecutionCategory(activity("canonical-command", "WebSearch", {
      kind: "command",
    }))).toBe("command");
    expect(activityExecutionCategory(activity("canonical-file", "WebFetch", {
      kind: "file",
    }))).toBe("coding");
    expect(activityExecutionCategory(activity("failed", "Web search failed", {
      status: "failed",
    }))).toBe("attention");
  });

  it("uses the newest running provider action and preserves its exact label", () => {
    const presentation = activeAgentPresentation({
      turn: turn("running", [
        activity("newer-array-position", "Run tests", {
          kind: "command",
          createdAt: "2026-08-12T12:00:05.000Z",
        }),
        activity("newest-time", "Search the web", {
          createdAt: "2026-08-12T12:00:06.000Z",
        }),
        activity("completed-last", "Write report", {
          status: "completed",
          createdAt: "2026-08-12T12:00:07.000Z",
        }),
      ]),
      providerLabel: "Codex · OpenAI",
      streamingChannel: "text",
    });

    expect(presentation).toEqual({
      phase: "searching",
      label: "Codex · OpenAI is searching",
      detail: "Search the web",
      animated: true,
    });
  });

  it("does not treat persisted reasoning as current thinking", () => {
    expect(activeAgentPresentation({
      turn: turn("running", [], reasoning("running")),
      providerLabel: "Cursor",
      streamingChannel: null,
    }).phase).toBe("working");

    expect(activeAgentPresentation({
      turn: turn("running", [], reasoning("running")),
      providerLabel: "Cursor",
      streamingChannel: "reasoning",
    }).phase).toBe("thinking");
  });

  it("distinguishes provider response output from an eventless running turn", () => {
    expect(activeAgentPresentation({
      turn: turn("running"),
      providerLabel: "OpenCode",
      streamingChannel: "text",
    })).toMatchObject({
      phase: "responding",
      label: "OpenCode is responding",
    });
    expect(activeAgentPresentation({
      turn: turn("running"),
      providerLabel: "OpenCode",
      streamingChannel: null,
    })).toMatchObject({
      phase: "working",
      label: "OpenCode is working",
    });
  });

  it("uses the latest real stream channel when reasoning and answer text coexist", () => {
    const running = turn("running", [], reasoning("running"));
    expect(activeAgentPresentation({
      turn: running,
      providerLabel: "Codex · OpenAI",
      streamingChannel: "reasoning",
    }).phase).toBe("thinking");
    expect(activeAgentPresentation({
      turn: running,
      providerLabel: "Codex · OpenAI",
      streamingChannel: "text",
    }).phase).toBe("responding");
  });
});

describe("terminal turn projection", () => {
  it("retains independent settlements across repeated failed refreshes", () => {
    const first = {
      id: "turn-first",
      runId: "run-first",
      status: "running",
    } as AgentTurn;
    const second = {
      id: "turn-second",
      runId: "run-second",
      status: "running",
    } as AgentTurn;
    const firstOwner = `${first.runId}\0${first.id}`;
    const secondOwner = `${second.runId}\0${second.id}`;
    const projections = withTerminalTurnProjection(
      withTerminalTurnProjection({}, {
        owner: firstOwner,
        status: "completed",
        terminalReason: null,
      }),
      {
        owner: secondOwner,
        status: "failed",
        terminalReason: "Provider failed.",
      },
    );

    expect(applyTerminalTurnProjections(
      [first, second],
      projections,
      null,
    ).map(({ status, runState }) => ({ status, state: runState?.state })))
      .toEqual([
        { status: "completed", state: undefined },
        { status: "failed", state: undefined },
      ]);
    expect(reconcileTerminalTurnProjections(projections, [{
      ...first,
      status: "completed",
    }])).toEqual({ [secondOwner]: projections[secondOwner] });
  });
});
