import { expect, test } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import type { AgentRunState } from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import { createAppFixture } from "./support/app-fixture";

test("projects exact live run states in the real Electron shell", async ({
  browserName: _browserName,
}, testInfo) => {
  const app = await createAppFixture({
    name: "authoritative-run-state",
    initialState: "conversation",
    windowDisplay: "primary",
  });

  try {
    const databasePath = join(app.testDirectory, "data", "inertia.sqlite");
    const store = new RuntimeStore(databasePath, app.workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    const snapshot = store.shellSnapshot();
    const project = snapshot.projects[0]!;
    const states = [
      {
        title: "Retry Claude transport",
        providerId: "claude",
        branch: "codex/run-state-retry",
        state: "retrying",
        providerState: "system/api_retry attempt 2",
      },
      {
        title: "Track delegated Claude work",
        providerId: "claude",
        branch: "codex/run-state-delegated",
        state: "delegated",
        providerState: "verified live subagent activity",
      },
      {
        title: "Stop exact Codex process",
        providerId: "codex",
        branch: "codex/run-state-stop",
        state: "cancelling",
        providerState: "cancel requested · awaiting exact process exit",
      },
    ] as const satisfies ReadonlyArray<{
      title: string;
      providerId: "claude" | "opencode" | "codex";
      branch: string;
      state: Extract<AgentRunState, "retrying" | "delegated" | "cancelling">;
      providerState: string;
    }>;
    const turns = new Map<AgentRunState, string>();
    let selectedConversationId = "";
    for (const [index, fixture] of states.entries()) {
      const conversation = store.createConversation(project.id, fixture.title, {
        providerId: fixture.providerId,
        branch: fixture.branch,
        activate: false,
      });
      const requestedAt = new Date(Date.now() - (3 - index) * 30_000).toISOString();
      const startedAt = new Date(Date.parse(requestedAt) + 1_000).toISOString();
      const modelSelection = nativeModelSelection({
        providerId: fixture.providerId,
        modelId: fixture.providerId === "claude"
          ? "claude-sonnet-4-5"
          : "fixture-model",
        alias: null,
        reasoningEffort: "high",
      });
      const queued = store.beginAgentTurn({
        conversationId: conversation.id,
        runId: `e2e-${fixture.state}-run`,
        content: fixture.state === "cancelling"
          ? "Stop only after the exact provider process exits."
          : `Keep the ${fixture.state} state truthful.`,
        providerId: fixture.providerId,
        modelSelection,
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: modelSelection.backendConfigurationRevision,
        association: "authoritative",
        requestedAt,
      });
      store.updateAgentTurnLifecycle(queued.turn.id, {
        status: "running",
        runState: {
          state: fixture.state,
          providerState: fixture.providerState,
          revision: 1,
        },
        startedAt,
        updatedAt: startedAt,
      });
      store.updateConversation(conversation.id, {
        status: "running",
        attentionKind: null,
      });
      turns.set(fixture.state, queued.turn.id);
      if (fixture.state === "cancelling") selectedConversationId = conversation.id;
    }
    store.updateSettings({
      theme: "dark",
      sidebarMode: "activity",
      showTimestamps: true,
      providerIdentityLabels: {
        codex: "Codex App Server",
        claude: "Claude Agent SDK",
        cursor: "Cursor",
        kimi: "Kimi Code",
        opencode: "OpenCode SDK",
      },
    });
    store.selectConversation(selectedConversationId);
    store.close();

    await app.resizeWindow(1440, 900);
    await app.page.reload();
    const sidebar = app.page.getByRole("complementary", {
      name: "Project navigation",
      exact: true,
    });
    const workspacePanel = app.page.getByRole("complementary", {
      name: "Workspace tools",
    });
    if (await workspacePanel.isVisible()) {
      await app.page.getByRole("button", { name: "Close workspace tools" }).click();
      await expect(workspacePanel).toBeHidden();
    }
    for (const state of states) {
      const row = sidebar.locator(".activity-thread").filter({ hasText: state.title });
      await expect(row.locator('[data-work-status="working"]')).toBeVisible();
    }
    const cancellingTurn = app.page.locator(`[data-turn-id="${turns.get("cancelling")}"]`);
    await expect(cancellingTurn.locator('[data-active-agent-phase="cancelling"]'))
      .toBeVisible();
    await expect(cancellingTurn.locator(".turn-working-status"))
      .toContainText("Codex App Server · OpenAI stopping");
    await expect(cancellingTurn.locator(".turn-stop-action"))
      .toBeDisabled();
    await expect(cancellingTurn.locator(".turn-stop-action"))
      .toHaveText("Stopping");
    const stoppingScreenshot = testInfo.outputPath(
      "authoritative-run-state-stopping-wide-dark.png",
    );
    await app.page.screenshot({ animations: "disabled", path: stoppingScreenshot });
    await testInfo.attach("authoritative-run-state-stopping-wide-dark", {
      path: stoppingScreenshot,
      contentType: "image/png",
    });

    await sidebar.locator(".activity-thread").filter({ hasText: states[0].title })
      .getByRole("button").first().click();
    const retryingTurn = app.page.locator(`[data-turn-id="${turns.get("retrying")}"]`);
    await expect(retryingTurn.locator('[data-active-agent-phase="retrying"]'))
      .toBeVisible();
    await expect(retryingTurn.locator(".turn-working-status"))
      .toContainText("Claude Agent SDK · Anthropic retrying");
    await app.resizeWindow(1100, 760);
    if (await workspacePanel.isVisible()) {
      await app.page.getByRole("button", { name: "Close workspace tools" }).click();
      await expect(workspacePanel).toBeHidden();
    }
    await app.page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
      document.documentElement.style.colorScheme = "light";
    });
    const retryingScreenshot = testInfo.outputPath(
      "authoritative-run-state-retrying-compact-light.png",
    );
    await app.page.screenshot({ animations: "disabled", path: retryingScreenshot });
    await testInfo.attach("authoritative-run-state-retrying-compact-light", {
      path: retryingScreenshot,
      contentType: "image/png",
    });
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
