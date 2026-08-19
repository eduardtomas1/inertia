import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import {
  failureDiagnosticsPresentation,
  MAX_COPIED_FAILURE_DIAGNOSTICS_CHARS,
} from "../../src/renderer/src/utils/failureDiagnostics";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

const conversationId = "90909090-9090-4090-8090-909090909090";
const turnId = "turn-failure-diagnostics";
const runId = "run-failure-diagnostics";
const requestedAt = "2030-02-01T10:00:00.000Z";
const completedAt = "2030-02-01T10:00:12.000Z";

function failedTurn(): AgentTurn {
  return {
    id: turnId,
    conversationId,
    runId,
    userMessageId: "user-failure-diagnostics",
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      modelId: "gpt-5.6-sol",
      alias: "GPT-5.6-Sol",
      reasoningEffort: "xhigh",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 7,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 7,
      modelIdentity: "gpt-5.6-sol",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6-sol",
    modelAlias: "GPT-5.6-Sol",
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "full",
    providerSessionBefore: "provider-session-secret",
    providerSessionAfter: "provider-session-secret",
    requestedAt,
    startedAt: "2030-02-01T10:00:02.000Z",
    completedAt,
    status: "failed",
    terminalReason: "provider-process-exit",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 7,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: completedAt,
  };
}

function userMessage(): ChatMessage {
  return {
    id: "user-failure-diagnostics",
    conversationId,
    turnId,
    role: "user",
    content: "PRIVATE USER REQUEST THAT MUST NOT ENTER DIAGNOSTICS",
    attachments: [],
    createdAt: requestedAt,
  };
}

function failureActivity(detail = [
  "Reason: transport-closed",
  "Phase: running",
  "Exit code: 17",
  "Signal: not reported",
  "Terminal event: not received",
  "Activity: command-42",
  "Cleanup: confirmed",
  "Cause: RPC transport closed",
  "Stack:",
  "    at connect (<workspace>/src/rpc.ts:10:4)",
  "",
  "Recent provider context:",
  "<img src=x onerror=alert(1)>",
  "Last safe provider line",
].join("\n")): AgentActivity {
  return {
    id: "error-failure-diagnostics",
    conversationId,
    runId,
    turnId,
    kind: "error",
    title: "The provider connection closed before the turn completed.",
    detail,
    status: "failed",
    createdAt: completedAt,
  };
}

function renderFailure(): void {
  render(
    <ResponseTimeline
      turns={[failedTurn()]}
      messages={[userMessage()]}
      activities={[failureActivity()]}
      reasonings={[]}
      plans={[]}
      checkpoints={[]}
      projectRoot="/private/workspace"
      projectId="project-failure-diagnostics"
      conversationId={conversationId}
      streamingText=""
      streamingReasoning=""
      approvals={[]}
      inputRequests={[]}
      showTimestamps={false}
      showThinking={false}
      defaultCodeWrap={false}
      autoCollapseWorkLog
      showChangedFileSummaries={false}
      checkpointRestoreDisabled
      onRespondToApproval={async () => undefined}
      onRespondToInput={async () => undefined}
      onRevertCheckpoint={() => undefined}
      onOpenTurnDiff={() => undefined}
      onCompareTurnArtifacts={() => undefined}
      onOpenTurnFile={() => undefined}
      onStop={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "inertia");
});

describe("turn failure diagnostics", () => {
  it("keeps scrubbed details unmounted until the accessible disclosure opens", async () => {
    renderFailure();

    expect(await screen.findByText("Run failed")).toBeTruthy();
    expect(screen.getByText("The provider connection closed before the turn completed.")).toBeTruthy();
    const toggle = await screen.findByRole("button", { name: "Technical details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(
      "turn-failure-details-turn-failure-diagnostics",
    );
    expect(screen.queryByRole("heading", { name: "Execution" })).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).not.toContain("Last safe provider line");

    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole("heading", { name: "Execution" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Provider & process" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Error cause" })).toBeTruthy();
    expect(screen.getByText(/at connect \(<workspace>\/src\/rpc\.ts/u)).toBeTruthy();
    expect(screen.getByText("Resumed existing session")).toBeTruthy();
    const context = screen.getByRole("heading", {
      name: "Recent provider context",
    }).nextElementSibling;
    expect(context?.textContent).toContain("Last safe provider line");
    expect(context?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).not.toContain("provider-session-secret");
  });

  it("copies the bounded diagnostic dossier without request, path, or session content", async () => {
    const copyText = vi.fn(async (_text: string) => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText } as unknown as typeof window.inertia,
    });
    renderFailure();

    fireEvent.click(await screen.findByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledOnce());
    const copied = copyText.mock.calls[0]![0];
    expect(copied).toContain("Inertia turn failure diagnostics");
    expect(copied).toContain(`Run ID: ${runId}`);
    expect(copied).toContain("Failure code: transport-closed");
    expect(copied).toContain("Process cleanup: confirmed");
    expect(copied).toContain("Stack:");
    expect(copied).toContain("<workspace>/src/rpc.ts");
    expect(copied).not.toContain("PRIVATE USER REQUEST");
    expect(copied).not.toContain("/private/workspace");
    expect(copied).not.toContain("provider-session-secret");
    expect(screen.getByRole("button", { name: "Diagnostics copied" })).toBeTruthy();
    expect(screen.getAllByRole("status").some(({ textContent }) =>
      textContent === "Diagnostics copied.")).toBe(true);
  });

  it("defensively bounds legacy detail and copied output", () => {
    const detail = Array.from(
      { length: 200 },
      (_, index) => `legacy-line-${index}:${"x".repeat(3_000)}`,
    ).join("\n");
    const presentation = failureDiagnosticsPresentation(
      failedTurn(),
      failureActivity(detail),
    );

    expect(presentation.context).toContain("legacy-line-0");
    expect(presentation.context).toContain("…");
    expect(presentation.context).not.toContain("legacy-line-199");
    expect(presentation.copyText.length).toBeLessThanOrEqual(
      MAX_COPIED_FAILURE_DIAGNOSTICS_CHARS,
    );
  });
});
