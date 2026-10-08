// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import type { ProviderId } from "../../src/shared/provider";
import { createAppFixture } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";
import { closeWorkspaceTools } from "./support/workspace-tools";

const evidenceDirectory = join(process.cwd(), "docs", "pr-evidence", "provider-handoff");
const handoffName = /^Context handoff: Claude · claude-sonnet-4-6 to Codex · gpt-5\.5 · 2 earlier messages carried$/u;

function seedCompletedTurn(
  store: RuntimeStore,
  conversationId: string,
  providerId: ProviderId,
  modelId: string,
  prompt: string,
  reply: string,
  at: string,
  recovery?: { restoredMessageCount: number; omittedMessageCount: number },
): void {
  const modelSelection = providerNativeModelSelection({ providerId, modelId });
  store.updateConversation(conversationId, { providerId, modelSelection });
  const { turn } = store.beginAgentTurn({
    conversationId,
    runId: `provider-handoff-${providerId}`,
    content: prompt,
    providerId,
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(modelSelection),
    ...(recovery ? { continuationReasonCode: "harness-changed" as const, sessionRecovery: recovery } : {}),
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: modelSelection.backendConfigurationRevision,
    association: "authoritative",
    requestedAt: at,
  });
  store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: at, updatedAt: at });
  const answer = store.createMessage(conversationId, reply, "assistant", [], turn.id, at);
  store.updateAgentTurnLifecycle(turn.id, {
    status: "completed", completedAt: at, updatedAt: at,
    terminalAssistantMessageId: answer.id, terminalReason: "provider-completed",
  });
  store.createTurnGitArtifact({ turnId: turn.id, branch: "main", createdAt: at });
  store.completeTurnGitArtifact(turn.id, {
    files: [], insertions: 0, deletions: 0, status: "ready", completeness: "complete", patchState: "none",
    capturedAt: at, terminalAssistantMessageId: answer.id, updatedAt: at,
  });
}

for (const theme of ["dark", "light"] as const) test(`shows a context handoff divider where the chat moved from Claude to Codex in ${theme}`, async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({
    name: `provider-handoff-${theme}`,
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const conversation = store.shellSnapshot().conversations[0]!;
        store.updateConversation(conversation.id, { title: "Tighten the release checklist" });
        seedCompletedTurn(
          store, conversation.id, "claude", "claude-sonnet-4-6",
          "Draft a release checklist for the desktop app.",
          "Here is a first checklist: verify signing, run the package smoke test, and confirm the checksums.",
          new Date(Date.now() - 120_000).toISOString(),
        );
        seedCompletedTurn(
          store, conversation.id, "codex", "gpt-5.5",
          "Continue from that checklist and add the provenance step.",
          "Added the provenance attestation after the checksum step; the rest of the checklist is unchanged.",
          new Date(Date.now() - 60_000).toISOString(),
          { restoredMessageCount: 2, omittedMessageCount: 0 },
        );
        store.selectConversation(conversation.id);
        store.updateSettings({ theme });
      } finally {
        store.close();
      }
    },
  });
  let bodyFailure: { error: unknown } | undefined;
  try {
    const page = app.page;
    await app.resizeWindow(1440, 920);
    await closeWorkspaceTools(page);

    const separator = page.getByRole("separator", { name: handoffName });
    await expect(separator).toBeVisible();
    const row = page.locator("section.provider-handoff-row");
    await expect(row).toHaveAttribute("data-response-row-id", /^handoff:/u);
    await expect(row).toHaveAttribute("tabindex", "-1");
    await expect(row.locator(".provider-handoff-marker")).toHaveAttribute("aria-hidden", "true");

    const claudeAnswer = await page.getByText("Here is a first checklist").boundingBox();
    const divider = await separator.boundingBox();
    const codexRequest = await page.getByText("Continue from that checklist").boundingBox();
    expect(claudeAnswer!.y).toBeLessThan(divider!.y);
    expect(divider!.y).toBeLessThan(codexRequest!.y);
    await expect(row.locator(".provider-handoff-marker")).toContainText("2 earlier messages carried");
    await expect(page.getByLabel("Provider session")).toHaveCount(0);

    await separator.scrollIntoViewIfNeeded();
    const name = `handoff-${theme}`;
    const artifact = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: artifact, animations: "disabled" });
    await testInfo.attach(name, { path: artifact, contentType: "image/png" });
    if (process.env.INERTIA_CAPTURE_PR_ASSETS === "1") {
      mkdirSync(evidenceDirectory, { recursive: true });
      await page.screenshot({ path: join(evidenceDirectory, `${name}.png`), animations: "disabled" });
    }
    expect(app.rendererErrors).toEqual([]);
  } catch (error) { bodyFailure = { error }; throw error; }
  finally { await closeElectronAfterTest(() => app.close(), () => testInfo, bodyFailure); }
});
