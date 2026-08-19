import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { RuntimeStore } from "../../../src/server/database";
import {
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
} from "../../../src/shared/claude-backend-profiles";
import { nativeModelSelection } from "../../../src/shared/model-routing";

export const createQuietLedgerFixture = ({
  testDirectory,
  workspaceDirectory,
}: {
  testDirectory: string;
  workspaceDirectory: string;
}) => {
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  let snapshot = store.shellSnapshot();
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) {
    const project = store.createProject("Inertia", workspaceDirectory);
    store.createConversation(project.id, "E2E base conversation");
    snapshot = store.shellSnapshot();
  }
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) {
    throw new Error("Quiet Ledger fixture setup failed.");
  }
  const previousConversationId = snapshot.activeConversationId;
  const originalSettings = snapshot.settings;
  const conversation = store.createConversation(snapshot.activeProjectId, "Quiet Ledger visual fixture");
  store.updateSettings({
    theme: "dark",
    interfaceScale: "default",
    responseDensity: "default",
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: true,
    showTimestamps: true,
  });

  const fixturePrefix = `quiet-ledger-e2e-${randomUUID()}`;
  const fixtureBaseTime = Date.now() - 12 * 60_000;
  const codexSelection = nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-5.6",
    alias: "GPT-5.6",
    reasoningEffort: "xhigh",
  });
  const kimiProfile = createKimiClaudeBackendProfile({
    id: `${fixturePrefix}:kimi`,
    secretReference: "secret:quiet-ledger-e2e",
    primaryModelId: "k3",
    contextWindowTokens: 1_048_576,
  });
  const kimiSelection = createKimiClaudeModelSelection({ profile: kimiProfile });

  const beginTurn = (
    suffix: string,
    index: number,
    content: string,
    selection = codexSelection,
    providerId: "codex" | "claude" = "codex",
  ) => {
    const requestedAt = new Date(fixtureBaseTime + index * 90_000).toISOString();
    const startedAt = new Date(Date.parse(requestedAt) + 3_000).toISOString();
    const result = store.beginAgentTurn({
      id: `${fixturePrefix}-${suffix}`,
      conversationId: conversation.id,
      runId: `${fixturePrefix}-${suffix}-run`,
      content,
      providerId,
      modelSelection: selection,
      reasoningEffort: selection.reasoningEffort ?? "",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: selection.backendConfigurationRevision,
      association: "authoritative",
      requestedAt,
    });
    store.updateAgentTurnLifecycle(result.turn.id, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });
    return { ...result, requestedAt, startedAt };
  };

  const settleTurn = (
    fixture: ReturnType<typeof beginTurn>,
    answerContent: string,
    status: "completed" | "failed" | "cancelled" = "completed",
  ) => {
    const completedAt = new Date(Date.parse(fixture.startedAt) + 42_000).toISOString();
    const answer = store.createMessage(
      conversation.id,
      answerContent,
      "assistant",
      [],
      fixture.turn.id,
      completedAt,
    );
    store.updateAgentTurnLifecycle(fixture.turn.id, {
      status,
      completedAt,
      updatedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      terminalReason: status === "completed"
        ? "provider-completed"
        : status === "failed"
          ? "provider-failed"
          : "user-cancelled",
    });
    return answer;
  };

  const completed = beginTurn(
    "completed",
    0,
    "Explain the provider routing issue and leave a concise implementation summary.",
  );
  for (let index = 0; index < 8; index += 1) {
    store.addActivity({
      conversationId: conversation.id,
      runId: completed.turn.runId,
      turnId: completed.turn.id,
      kind: index % 3 === 0 ? "file" : index % 3 === 1 ? "tool" : "command",
      title: `Verified implementation step ${index + 1}`,
      detail: index === 7 ? "The focused renderer checks are green." : null,
      status: "completed",
    });
  }
  const completedAnswer = settleTurn(completed, [
    "## Result",
    "",
    "The provider route now keeps its historical model identity while the operational work stays in a compact ledger.",
    "",
    "> Historical attribution comes from the persisted route, never today’s selected profile.",
    "",
    "The answer treats `ModelSelection` as the authoritative identity source.",
    "",
    "- The answer remains outside the execution rail.",
    "- Queue and execution timings use the persisted turn lifecycle.",
    "- Changed files stay available as a quiet disclosure.",
    "",
    "| Surface | Presentation | Responsive contract | Overflow owner | Verification |",
    "| --- | --- | --- | --- | --- |",
    "| Final answer | Editorial document | Stays inside the transcript column | Table viewport | Narrow fixture |",
    "| Work history | Compact ledger | Keeps activity labels readable | Activity row | Split fixture |",
    "",
    "```ts",
    "const routeIdentity = \"authoritative\"; const deliberatelyLongVerificationCommand = \"pnpm vitest run tests/renderer/quiet-ledger-responsive.test.ts --coverage --reporter=verbose\";",
    "```",
    "",
    "```json",
    "{\"route\":\"secondary\",\"verified\":true}",
    "```",
  ].join("\n"));
  store.createTurnGitArtifact({
    id: `${fixturePrefix}-completed-artifact`,
    turnId: completed.turn.id,
    branch: "main",
    createdAt: completedAnswer.createdAt,
  });
  store.completeTurnGitArtifact(completed.turn.id, {
    files: [
      {
        path: "src/renderer/src/components/ResponseTimeline.tsx",
        previousPath: null,
        status: "M",
        insertions: 84,
        deletions: 21,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      },
      {
        path: "src/renderer/src/styles.css",
        previousPath: null,
        status: "M",
        insertions: 36,
        deletions: 8,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      },
      {
        path: "tests/e2e/app.spec.ts",
        previousPath: null,
        status: "M",
        insertions: 42,
        deletions: 0,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      },
    ],
    insertions: 162,
    deletions: 29,
    status: "ready",
    completeness: "complete",
    patchState: "none",
    capturedAt: completedAnswer.createdAt,
    terminalAssistantMessageId: completedAnswer.id,
    updatedAt: completedAnswer.createdAt,
  });

  const detailed = beginTurn(
    "details",
    1,
    "Show completed operational details only when I ask for them.",
  );
  for (const [index, title] of [
    "Inspected the current response lifecycle",
    "Measured the transcript column",
    "Refined the execution rail",
    "Validated scroll anchoring",
    "Ran the focused renderer suite",
  ].entries()) {
    store.addActivity({
      conversationId: conversation.id,
      runId: detailed.turn.runId,
      turnId: detailed.turn.id,
      kind: index === 4 ? "command" : index === 1 ? "file" : "tool",
      title,
      detail: index === 3 ? "The visible row stays fixed while disclosure height changes." : null,
      status: "completed",
    });
  }
  settleTurn(
    detailed,
    "The completed work is collapsed by default and remains available through the keyboard-accessible Details row.",
  );

  const kimi = beginTurn(
    "kimi",
    2,
    "Keep this Kimi-through-Claude answer historically accurate.",
    kimiSelection,
    "claude",
  );
  store.addActivity({
    conversationId: conversation.id,
    runId: kimi.turn.runId,
    turnId: kimi.turn.id,
    kind: "tool",
    title: "Resolved the persisted backend route",
    detail: null,
    status: "completed",
  });
  settleTurn(
    kimi,
    "This answer is attributed from the persisted model selection: Claude harness, Kimi backend, K3 model.",
  );

  const warning = beginTurn(
    "warning",
    3,
    "Keep the successful result and make its provider warning easy to find.",
  );
  store.addActivity({
    conversationId: conversation.id,
    runId: warning.turn.runId,
    turnId: warning.turn.id,
    kind: "tool",
    title: "Applied the compatible fallback",
    detail: null,
    status: "completed",
  });
  store.addActivity({
    conversationId: conversation.id,
    runId: warning.turn.runId,
    turnId: warning.turn.id,
    kind: "status",
    title: "Warning: optional provider capability skipped",
    detail: "The final result is complete, but one optional capability was unavailable.",
    status: "completed",
  });
  settleTurn(
    warning,
    "The compatible fallback completed successfully; the optional provider warning remains visible above this answer.",
  );

  const failed = beginTurn(
    "failed",
    4,
    "Run the verification and keep any actionable failure visible.",
  );
  store.addActivity({
    conversationId: conversation.id,
    runId: failed.turn.runId,
    turnId: failed.turn.id,
    kind: "tool",
    title: "Prepared the verification environment",
    detail: null,
    status: "completed",
  });
  store.addActivity({
    conversationId: conversation.id,
    runId: failed.turn.runId,
    turnId: failed.turn.id,
    kind: "command",
    title: "Renderer verification failed",
    detail: "One actionable assertion needs attention.",
    status: "failed",
  });
  store.addActivity({
    conversationId: conversation.id,
    runId: failed.turn.runId,
    turnId: failed.turn.id,
    kind: "error",
    title: "The provider connection closed before verification completed.",
    detail: [
      "Reason: transport-closed",
      "Phase: running",
      "Exit code: 17",
      "Signal: not reported",
      "Terminal event: not received",
      "Activity: renderer-verification",
      "Cleanup: confirmed",
      "Cause: RPC transport closed",
      "Stack:",
      "    at verify (<workspace>/src/renderer/verification.ts:41:9)",
      "",
      "Recent provider context:",
      "Renderer assertion 17 did not settle before the transport closed.",
      "The diagnostic tail was retained after redaction.",
    ].join("\n"),
    status: "failed",
  });
  settleTurn(
    failed,
    "The verification stopped at one actionable renderer failure. The failed command remains visible above this answer.",
    "failed",
  );

  const cancelled = beginTurn(
    "cancelled",
    5,
    "Stop this run and keep its settled state visible.",
  );
  store.addActivity({
    conversationId: conversation.id,
    runId: cancelled.turn.runId,
    turnId: cancelled.turn.id,
    kind: "tool",
    title: "Inspected the cancellation boundary",
    detail: null,
    status: "completed",
  });
  settleTurn(
    cancelled,
    "The run stopped at the requested boundary.",
    "cancelled",
  );

  const approval = beginTurn(
    "approval",
    6,
    "Run the focused renderer verification after I approve it.",
  );
  const approvalUpdatedAt = new Date(
    Date.parse(approval.startedAt) + 18_000,
  ).toISOString();
  store.updateAgentTurnLifecycle(approval.turn.id, {
    status: "waiting-for-approval",
    updatedAt: approvalUpdatedAt,
  });
  const approvalRequest = {
    id: `${fixturePrefix}-approval-request`,
    providerId: "codex",
    conversationId: conversation.id,
    runId: approval.turn.runId,
    turnId: approval.turn.id,
    kind: "command",
    title: "Approve the focused renderer verification",
    detail: "This verifies the updated response and composer surfaces.",
    command: "npm run test -- tests/renderer/quiet-ledger-responsive.test.ts",
    cwd: workspaceDirectory,
    reason: "The supervised command needs your approval before it runs.",
    networkScope: null,
    permissionRoots: [],
    availableDecisions: ["cancel", "deny", "approve"],
  };

  const providerQuestion = beginTurn(
    "provider-question",
    7,
    "Ask which provider-specific presentation should remain visible.",
    kimiSelection,
    "claude",
  );
  const questionUpdatedAt = new Date(
    Date.parse(providerQuestion.startedAt) + 16_000,
  ).toISOString();
  store.updateAgentTurnLifecycle(providerQuestion.turn.id, {
    status: "waiting-for-input",
    updatedAt: questionUpdatedAt,
  });
  const providerInputRequest = {
    id: `${fixturePrefix}-provider-input`,
    providerId: "claude",
    conversationId: conversation.id,
    runId: providerQuestion.turn.runId,
    turnId: providerQuestion.turn.id,
    autoResolutionMs: null,
    questions: [{
      id: `${fixturePrefix}-provider-direction`,
      header: "Presentation",
      question: "Which provider presentation should this fixture preserve?",
      isOther: true,
      isSecret: false,
      allowMultiple: false,
      options: [
        {
          id: "quiet",
          label: "Quiet ledger",
          description: "Keep completed operational work collapsed.",
        },
        {
          id: "expanded",
          label: "Expanded work",
          description: "Keep the full operational history visible.",
        },
      ],
    }],
  };

  const history = beginTurn(
    "history",
    8,
    "Keep one more settled result available in the virtualized history.",
  );
  settleTurn(
    history,
    "The historical result remains available without displacing the active work.",
  );

  const active = beginTurn(
    "active",
    9,
    "Refine the response experience and keep me oriented while the work is running.",
  );
  const activeAt = (seconds: number) =>
    new Date(Date.parse(active.startedAt) + seconds * 1_000).toISOString();
  store.addActivity({
    conversationId: conversation.id,
    runId: active.turn.runId,
    turnId: active.turn.id,
    kind: "status",
    title: "Connected to the local runtime",
    detail: null,
    status: "completed",
    createdAt: activeAt(2),
  });
  store.createMessage(
    conversation.id,
    "I’m tracing the current response path before changing the presentation.",
    "assistant",
    [],
    active.turn.id,
    activeAt(4),
  );
  for (const [seconds, kind, title, status] of [
    [6, "command", "Inspected the repository", "completed"],
    [8, "tool", "Reading provider routing", "completed"],
  ] as const) {
    store.addActivity({
      conversationId: conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      kind,
      title,
      detail: null,
      status,
      createdAt: activeAt(seconds),
    });
  }
  store.createMessage(
    conversation.id,
    "The event order is sound; I’m applying the focused UI change and validating it now.",
    "assistant",
    [],
    active.turn.id,
    activeAt(10),
  );
  const activeRunningActivities = ([
    [12, "file", "Editing backend adapter"],
    [14, "command", "Running focused tests"],
  ] as const).map(([seconds, kind, title]) =>
    store.addActivity({
      conversationId: conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      kind,
      title,
      detail: null,
      status: "running",
      createdAt: activeAt(seconds),
    }));
  store.close();

  return {
    active,
    activeAt,
    activeRunningActivities,
    approval,
    approvalRequest,
    cancelled,
    codexSelection,
    completed,
    conversation,
    databasePath,
    detailed,
    failed,
    fixturePrefix,
    kimi,
    originalSettings,
    previousConversationId,
    providerInputRequest,
    providerQuestion,
    warning,
  };
};
