// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {
  CodexAppServerEvents,
  type CodexAppServerEventHost,
} from "../../src/server/codex/app-server-events";
import { CappedTextBuffer } from "../../src/server/codex/protocol";
import { RuntimeStore } from "../../src/server/database";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import {
  agentActivityKind,
  agentActivityStatus,
} from "../../src/server/runtime-snapshots";
import { TurnActivityProjection } from "../../src/server/runtime/turns/turn-activity-projection";
import type {
  ActiveTurn,
  TurnControllerHooks,
} from "../../src/server/runtime/turns/turn-controller-types";
import type { Conversation } from "../../src/shared/contracts";
import { createAppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const STARTED_AT = Date.parse("2026-10-05T09:00:00.000Z");
const OUTPUT_CHUNKS = [
  "\n> inertia@0.0.67 test\n> vitest run\n\n",
  "Collecting",
  ".",
  ".",
  ".",
  " done\n",
  " ✓ tests/config-loader.test.ts (4 tests) 12ms\n",
  " ✓ tests/release-script.test.ts (2 tests) 8ms\n",
  "\n Test Files  2 passed (2)\n",
  "      Tests  6 passed (6)\n",
];

function completedTurn(
  store: RuntimeStore,
  conversation: Conversation,
): { turnId: string; runId: string } {
  const requestedAt = new Date(STARTED_AT).toISOString();
  const completedAt = new Date(STARTED_AT + 60_000).toISOString();
  const run = store.createWorkspaceRun({ kind: "agent", projectId: conversation.projectId,
    conversationId: conversation.id, label: conversation.title, detail: null, status: "running", port: null });
  const { turn } = store.beginAgentTurn({ conversationId: conversation.id, runId: run.id,
    content: "Run the test suite.", providerId: conversation.providerId,
    modelSelection: conversation.modelSelection, reasoningEffort: conversation.reasoningEffort,
    interactionMode: conversation.interactionMode, accessMode: conversation.accessMode,
    configurationRevision: 0, association: "authoritative", requestedAt });
  const reply = store.createMessage(conversation.id, "Both test files pass.", "assistant", [], turn.id,
    completedAt);
  store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
  store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalReason: "provider-completed",
    terminalAssistantMessageId: reply.id, completedAt, updatedAt: completedAt });
  store.updateWorkspaceRun(run.id, { status: "succeeded", finishedAt: completedAt });
  return { turnId: turn.id, runId: run.id };
}

function recordStreamedCommand(
  store: RuntimeStore,
  conversation: Conversation,
  workspaceDirectory: string,
): void {
  const { turnId, runId } = completedTurn(store, conversation);
  const active = {
    conversation,
    turn: store.agentTurn(turnId),
    runState: { isTerminal: () => false },
    runningActivities: new Map(),
    providerActivitiesById: new Map(),
    providerActivityDetailChars: 0,
    providerCommandRuns: new Map(),
    providerOutputActivityIds: new Set(),
    pendingActivityUpdates: new Map(),
    activityFlushTimer: null,
  } as unknown as ActiveTurn;
  const projection = new TurnActivityProjection({
    store,
    hooks: {
      broadcast: () => undefined,
      broadcastSnapshot: () => undefined,
    } as unknown as TurnControllerHooks,
    scheduler: { setTimeout: () => null, clearTimeout: () => undefined },
    now: () => new Date(STARTED_AT + 10_000).toISOString(),
    onPersistenceFailure: (_active, error) => { throw error; },
  });
  const emitter = createAgentHarnessEmitter("codex", conversation.id, {
    onEvent: (event) => {
      if (event.type !== "activity") return;
      projection.record(active, event, agentActivityKind(event), agentActivityStatus(event));
    },
  }, runId, turnId, workspaceDirectory);
  const host: CodexAppServerEventHost = {
    options: {
      executable: "codex",
      environment: {},
      cwd: workspaceDirectory,
      prompt: "Run the test suite.",
      planMode: false,
      access: "full",
      onActivity: emitter.activity,
    },
    resultText: new CappedTextBuffer(1_024),
    isSettled: () => false,
    phase: () => "running",
    setPhase: () => undefined,
    providerThreadId: () => "codex-thread",
    activeTurnId: () => "codex-turn",
    requestedTurnId: () => undefined,
    setActiveTurnId: () => undefined,
    cancelRequested: () => false,
    lastError: () => undefined,
    setLastError: () => undefined,
    setLastProtocolMethod: () => undefined,
    setLastActivityId: () => undefined,
    setTerminalEvent: () => undefined,
    writeMessage: () => true,
    cancel: () => undefined,
    finish: () => undefined,
    rememberFailure: () => undefined,
  };
  const codex = new CodexAppServerEvents(host);
  const owned = { threadId: "codex-thread", turnId: "codex-turn" };
  codex.handleNotification("item/started", {
    ...owned,
    item: { id: "command-1", type: "commandExecution", command: "npm test", status: "inProgress" },
  });
  for (const delta of OUTPUT_CHUNKS) {
    codex.handleNotification("item/commandExecution/outputDelta", { ...owned, itemId: "command-1", delta });
  }
  projection.flushPending(active);
  codex.handleNotification("item/completed", {
    ...owned,
    item: {
      id: "command-1",
      type: "commandExecution",
      command: "npm test",
      status: "completed",
      aggregatedOutput: OUTPUT_CHUNKS.join(""),
    },
  });
}

test("shows streamed command output once, in order, under one Output heading", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({
    name: "command-output",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
        { recoverInterruptedRuns: false });
      try {
        recordStreamedCommand(store, store.snapshot().conversations[0]!, workspaceDirectory);
      } finally { store.close(); }
    },
  });
  try {
    const { page } = app;
    await app.resizeWindow(1440, 920);
    const turn = page.locator("[data-turn-id]").last();
    await turn.scrollIntoViewIfNeeded();
    const runDetails = turn.getByRole("button", { name: "Run details" });
    await runDetails.click();
    await expect(runDetails).toHaveAttribute("aria-expanded", "true");
    const disclosure = turn.getByRole("button", { name: /^Output: / });
    await expect(disclosure).toHaveCount(1);
    await disclosure.click();
    const output = turn.locator(".agent-activity-output");
    await expect(output).toBeVisible();
    expect(await output.textContent()).toBe(
      `Command:\nnpm test\n\nOutput:\n${OUTPUT_CHUNKS.join("")}`.trim(),
    );

    for (const [theme, width, height] of [
      ["light", 1440, 920],
      ["dark", 1440, 920],
      ["light", 760, 600],
      ["dark", 760, 600],
    ] as const) {
      await app.resizeWindow(width, height);
      await setAppearanceInPlace(app, theme);
      await output.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const name = `command-output-${theme}-${width}x${height}.png`;
      const path = testInfo.outputPath(name);
      await page.screenshot({ path, animations: "disabled", scale: "css" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }
    await app.expectNoViewportOverflow();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
