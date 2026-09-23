import { join } from "node:path";

import { RuntimeStore } from "../../../src/server/database";
import type { AppSettingsUpdate } from "../../../src/shared/contracts";
import { providerNativeModelSelection } from "../../../src/shared/model-routing";

export function createWorkingIndicatorFixture({
  testDirectory,
  workspaceDirectory,
  settings,
  backgroundTitles = [],
}: {
  testDirectory: string;
  workspaceDirectory: string;
  settings: AppSettingsUpdate;
  backgroundTitles?: readonly string[];
}) {
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  let snapshot = store.shellSnapshot();
  if (!snapshot.activeProjectId) {
    store.createProject("Inertia", workspaceDirectory);
    snapshot = store.shellSnapshot();
  }
  const projectId = snapshot.activeProjectId;
  if (!projectId) throw new Error("Working indicator fixture setup failed.");
  store.updateSettings(settings);
  const selection = providerNativeModelSelection({
    providerId: "codex",
    modelId: "gpt-5.6",
    alias: "GPT-5.6",
    reasoningEffort: "high",
  });
  const baseTime = Date.now() - 4 * 60_000;
  const beginRunningTurn = (conversationId: string, suffix: string, content: string) => {
    const requestedAt = new Date(baseTime).toISOString();
    const startedAt = new Date(baseTime + 2_000).toISOString();
    const { turn } = store.beginAgentTurn({
      id: `working-indicator-${suffix}-${conversationId}`,
      conversationId,
      runId: `working-indicator-${suffix}-run-${conversationId}`,
      content,
      providerId: "codex",
      modelSelection: selection,
      reasoningEffort: selection.reasoningEffort ?? "",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: selection.backendConfigurationRevision,
      association: "authoritative",
      requestedAt,
    });
    store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt, updatedAt: startedAt });
    store.updateConversation(conversationId, { status: "running" });
    return { turn, startedAt };
  };

  const conversation = store.createConversation(projectId, "Working indicator fixture");
  const active = beginRunningTurn(
    conversation.id,
    "active",
    "Find why the release build drops the tray icon and fix it.",
  );
  const activeAt = (seconds: number) =>
    new Date(Date.parse(active.startedAt) + seconds * 1_000).toISOString();
  store.addActivity({
    conversationId: conversation.id,
    runId: active.turn.runId,
    turnId: active.turn.id,
    kind: "tool",
    title: "Search tray icon release",
    detail: null,
    status: "completed",
    createdAt: activeAt(2),
  });
  const runningActivities = ([
    [4, "command", "Running npm run build:bundle"],
    [6, "tool", "Calling github list workflow runs"],
  ] as const).map(([seconds, kind, title]) => store.addActivity({
    conversationId: conversation.id,
    runId: active.turn.runId,
    turnId: active.turn.id,
    kind,
    title,
    detail: null,
    status: "running",
    createdAt: activeAt(seconds),
  }));

  const background = backgroundTitles.map((title, index) => {
    const created = store.createConversation(projectId, title);
    beginRunningTurn(created.id, `background-${index}`, `Background task ${index + 1}`);
    return created;
  });
  store.selectConversation(conversation.id);
  store.close();
  return { databasePath, conversation, active, activeAt, runningActivities, background };
}
