import { readFileSync } from "node:fs";

import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import { providerNativeBackendProfile } from "../../src/shared/model-routing";

const conversationId = "45454545-4545-4545-8545-454545454545";

function turn(
  id: string,
  providerId: "claude" | "codex",
  requestedAt: string,
  update: Partial<AgentTurn> = {},
): AgentTurn {
  const harnessId = providerId === "claude" ? "claude-agent-sdk" : "codex-app-server";
  const backendProfileId = providerNativeBackendProfile(providerId).id;
  const model = providerId === "claude" ? "claude-sonnet-4-6" : "gpt-5.6";
  return {
    id,
    conversationId,
    runId: `run-${id}`,
    userMessageId: `user-${id}`,
    terminalAssistantMessageId: `assistant-${id}`,
    providerId,
    modelSelection: {
      harnessId,
      backendProfileId,
      backendProfileDisplayName: providerNativeBackendProfile(providerId).displayName,
      modelId: model,
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 1,
    },
    continuationIdentity: {
      harnessId,
      backendProfileId,
      backendConfigurationRevision: 1,
      modelIdentity: model,
      endpointIdentity: null,
    },
    harnessId,
    backendProfileId,
    model,
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: `session-${id}`,
    requestedAt,
    startedAt: requestedAt,
    completedAt: requestedAt,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: requestedAt,
    ...update,
  };
}

function messages(agentTurn: AgentTurn, request: string, answer: string): ChatMessage[] {
  return [
    { id: agentTurn.userMessageId, conversationId, turnId: agentTurn.id, role: "user", content: request, attachments: [], createdAt: agentTurn.requestedAt },
    ...(agentTurn.terminalAssistantMessageId
      ? [{ id: agentTurn.terminalAssistantMessageId, conversationId, turnId: agentTurn.id, role: "assistant" as const, content: answer, attachments: [], createdAt: agentTurn.completedAt! }]
      : []),
  ];
}

function timeline(turns: AgentTurn[], providerIdentityLabels?: Record<string, string>, showTimestamps = false) {
  return render(<ResponseTimeline
    turns={turns}
    messages={turns.flatMap((agentTurn) => messages(agentTurn, `Request ${agentTurn.id}`, `Answer ${agentTurn.id}`))}
    activities={[]}
    reasonings={[]}
    plans={[]}
    checkpoints={[]}
    projectRoot="/workspace"
    projectId="project-quiet-turn-chrome"
    conversationId={conversationId}
    streamingText=""
    streamingReasoning=""
    streamingChannel={null}
    approvals={[]}
    inputRequests={[]}
    showTimestamps={showTimestamps}
    showThinking
    defaultCodeWrap={false}
    autoCollapseWorkLog
    showChangedFileSummaries={false}
    checkpointRestoreDisabled
    providerIdentityLabels={providerIdentityLabels}
    onRespondToApproval={async () => undefined}
    onRespondToInput={async () => undefined}
    onRevertCheckpoint={() => undefined}
    onOpenTurnDiff={() => undefined}
    onCompareTurnArtifacts={() => undefined}
    onOpenTurnFile={() => undefined}
    onStop={() => undefined}
  />);
}

let stylesheet: HTMLStyleElement | null = null;

function loadStyles(): void {
  stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync("src/renderer/src/styles.css", "utf8");
  document.head.append(stylesheet);
}

afterEach(() => {
  stylesheet?.remove();
  stylesheet = null;
});

function turnElement(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-turn-id="${id}"]`)!;
}

describe("quiet turn chrome", () => {
  it("shows the answer identity only on the turn whose provider changed", () => {
    timeline([
      turn("turn-codex-a", "codex", "2026-09-01T10:00:00.000Z"),
      turn("turn-codex-b", "codex", "2026-09-01T10:01:00.000Z"),
      turn("turn-claude", "claude", "2026-09-01T10:02:00.000Z"),
      turn("turn-claude-again", "claude", "2026-09-01T10:03:00.000Z"),
    ]);

    for (const id of ["turn-codex-a", "turn-codex-b", "turn-claude-again"]) {
      expect(turnElement(id).querySelector(".final-answer-identity")).toBeNull();
    }
    const identity = within(turnElement("turn-claude")).getByLabelText("Historical answer identity");
    expect(identity).toHaveTextContent("Claude · Anthropic · claude-sonnet-4-6");
    expect(document.querySelectorAll(".final-answer-identity")).toHaveLength(1);
  });

  it("keeps the request bubble free of a You and time row", () => {
    timeline([turn("turn-bubble", "codex", "2026-09-01T10:00:00.000Z")]);

    const request = within(turnElement("turn-bubble")).getByRole("article", { name: "Your request" });
    expect(request.querySelector(".message-meta")).toBeNull();
    expect(request.querySelector("time")).toBeNull();
    expect(request).toHaveTextContent(/^Request turn-bubble$/u);
  });

  it("hides the footer at rest and reveals it while the turn holds focus or its details are open", () => {
    loadStyles();
    timeline([turn("turn-footer", "codex", "2026-09-01T10:00:00.000Z", {
      completedAt: "2026-09-01T10:00:42.000Z",
    })]);
    const footer = within(turnElement("turn-footer")).getByRole("contentinfo", {
      name: "Final answer actions and run metadata",
    });
    const primary = footer.querySelector<HTMLElement>(".turn-meta-primary")!;
    const runDetails = within(footer).getByRole("button", { name: "Run details" });

    expect(footer).not.toHaveTextContent("Completed");
    expect(footer).toHaveTextContent("Worked 42s");
    expect(getComputedStyle(primary).opacity).toBe("0");
    expect(getComputedStyle(primary).visibility).not.toBe("hidden");
    expect(getComputedStyle(primary).display).not.toBe("none");
    runDetails.focus();
    expect(runDetails).toHaveFocus();
    expect(stylesheet!.textContent).toMatch(
      /\.response-turn:is\(:hover, :focus-within\) \.turn-meta-primary,\n\.turn-meta\[data-run-details-expanded\] \.turn-meta-primary \{\n {2}opacity: 1;/u,
    );
    fireEvent.click(runDetails);
    runDetails.blur();
    expect(footer).toHaveAttribute("data-run-details-expanded", "true");
    expect(getComputedStyle(primary).opacity).toBe("1");
  });

  it("keeps the twelve run fields behind a Diagnostics disclosure inside Run details", () => {
    timeline([turn("turn-diagnostics", "codex", "2026-09-01T10:00:00.000Z")]);
    const footer = within(turnElement("turn-diagnostics")).getByRole("contentinfo");

    fireEvent.click(within(footer).getByRole("button", { name: "Run details" }));
    const diagnostics = within(footer).getByRole("button", { name: "Diagnostics" });
    expect(diagnostics).toHaveAttribute("aria-expanded", "false");
    expect(footer.querySelector("dt")).toBeNull();

    fireEvent.click(diagnostics);
    expect(diagnostics).toHaveAttribute("aria-expanded", "true");
    const fields = document.getElementById(diagnostics.getAttribute("aria-controls")!)!;
    expect([...fields.querySelectorAll("dt")].map(({ textContent }) => textContent)).toContain("Harness ID");
    expect(fields).toHaveTextContent("codex-app-server");
  });

  it("keeps a timestamp on turns that end without an answer and on a running turn", () => {
    timeline([
      turn("turn-failed", "codex", "2026-09-01T10:00:00.000Z", {
        status: "failed",
        terminalReason: "provider-failed",
        terminalAssistantMessageId: null,
        startedAt: "2026-09-01T10:00:02.000Z",
        completedAt: "2026-09-01T10:00:44.000Z",
      }),
      turn("turn-stopped", "codex", "2026-09-01T10:01:00.000Z", {
        status: "cancelled",
        terminalReason: "user-cancelled",
        terminalAssistantMessageId: null,
        startedAt: "2026-09-01T10:01:02.000Z",
        completedAt: "2026-09-01T10:01:12.000Z",
      }),
      turn("turn-running", "codex", "2026-09-01T10:02:00.000Z", {
        status: "running",
        terminalReason: null,
        terminalAssistantMessageId: null,
        startedAt: "2026-09-01T10:02:02.000Z",
        completedAt: null,
      }),
    ], undefined, true);

    const failed = within(turnElement("turn-failed")).getByRole("contentinfo");
    expect(failed.querySelector("time")).toHaveAttribute("dateTime", "2026-09-01T10:00:44.000Z");
    expect(failed.querySelector('[data-turn-status="failed"]')).toHaveTextContent("Failed");
    expect(within(failed).getByRole("button", { name: "Run details" })).toBeInTheDocument();
    expect(within(failed).queryByRole("button", { name: /Copy/u })).toBeNull();

    const stopped = within(turnElement("turn-stopped")).getByRole("contentinfo");
    expect(stopped.querySelector("time")).toHaveAttribute("dateTime", "2026-09-01T10:01:12.000Z");
    expect(stopped.querySelector('[data-turn-status="cancelled"]')).toHaveTextContent("Stopped");

    const running = within(turnElement("turn-running")).getByRole("contentinfo");
    expect(running.querySelector("time")).toHaveAttribute("dateTime", "2026-09-01T10:02:02.000Z");
    expect(running.querySelector("[data-turn-status]")).toBeNull();
    expect(within(running).queryByRole("button", { name: "Run details" })).toBeNull();
  });

  it("adds no footer to a running turn while message timestamps are off", () => {
    timeline([turn("turn-running-quiet", "codex", "2026-09-01T10:02:00.000Z", {
      status: "running",
      terminalReason: null,
      terminalAssistantMessageId: null,
      completedAt: null,
    })]);
    expect(within(turnElement("turn-running-quiet")).queryByRole("contentinfo")).toBeNull();
  });
});
