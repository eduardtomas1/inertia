// @inertia-e2e-resource isolated
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { LIFECYCLE_PROVIDER_DONE, lifecycleCodexAppServer } from "./support/lifecycle-provider-fixture";

const GOAL_LOOKUP = 'if (message.method === "thread/goal/get")';
const codexWithSkills = lifecycleCodexAppServer.replace(GOAL_LOOKUP, `if (message.method === "skills/list") {
    return send({ id: message.id, result: { data: message.params.cwds.map((cwd) => ({
      cwd,
      errors: [],
      skills: [{
        name: "review",
        path: path.join(cwd, ".codex", "skills", "review", "SKILL.md"),
        description: "Review this project.",
        scope: "repo",
        enabled: true,
      }],
    })) } });
  }
  ${GOAL_LOOKUP}`);

let app: AppFixture;
test.beforeAll(async () => {
  expect(codexWithSkills).not.toBe(lifecycleCodexAppServer);
  app = await createAppFixture({
    name: "new-chat-skills",
    initialState: "conversation",
    codexAppServerSource: codexWithSkills,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const conversationId = store.shellSnapshot().activeConversationId!;
        const at = new Date(Date.UTC(2030, 0, 1)).toISOString();
        const { turn } = store.beginAgentTurn({ id: randomUUID(), runId: randomUUID(), conversationId,
          content: "An earlier request", providerId: "codex", harnessId: "codex-app-server",
          backendProfileId: "native:codex:app-server", model: "test", reasoningEffort: "",
          interactionMode: "build", accessMode: "supervised", configurationRevision: 0,
          association: "authoritative", requestedAt: at });
        const message = store.createMessage(conversationId, "An earlier answer.", "assistant", [], turn.id, at);
        store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalReason: "provider-completed",
          terminalAssistantMessageId: message.id, startedAt: at, completedAt: at, updatedAt: at });
      } finally { store.close(); }
    },
  });
});
test.afterAll(async () => { await app?.close(); });

test("offers skills on the new chat screen and runs the chosen one", async () => {
  const { page } = app;
  await expect(page.getByText("An earlier answer.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: /What should we build/u })).toBeVisible();
  await expect(page.getByText("An earlier answer.", { exact: true })).toHaveCount(0);

  const composer = page.getByRole("region", { name: "Message composer" });
  const editor = composer.getByLabel("Message", { exact: true });
  await editor.fill("$rev");
  const suggestions = page.getByRole("listbox", { name: "Skill suggestions" });
  await expect(suggestions.getByRole("option", { name: /\$review/u })).toBeVisible({ timeout: 30_000 });
  await editor.press("Tab");
  await expect(editor).toHaveValue("$review ");
  await expect(suggestions).toHaveCount(0);

  await editor.pressSequentially("the last change");
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(LIFECYCLE_PROVIDER_DONE)).toBeVisible({ timeout: 30_000 });
  expect(app.rendererErrors).toEqual([]);
});
