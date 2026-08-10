import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import Database from "better-sqlite3";

import { WorkspacePathAuthority } from "../../../src/server/workspace-path-authority";

export async function seedViewedConversationContext(
  page: Page,
  testDirectory: string,
  workspaceDirectory: string,
): Promise<number> {
  const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
  const state = database.prepare(`
    SELECT app_state.active_conversation_id, conversations.project_id
    FROM app_state
    JOIN conversations
      ON conversations.id = app_state.active_conversation_id
    WHERE app_state.id = 1
  `).get() as { active_conversation_id: string; project_id: string };
  database.transaction(() => {
    database.prepare(`
      UPDATE conversations
      SET
        provider_id = 'claude',
        model_selection_json = json_set(model_selection_json, '$.harnessId', 'claude-agent-sdk', '$.backendProfileId', 'builtin:anthropic', '$.backendProfileDisplayName', 'Anthropic', '$.modelId', 'viewed-model', '$.alias', 'viewed-model', '$.reasoningEffort', 'viewed-effort'),
        continuation_identity_json = json_object('harnessId', 'claude-agent-sdk', 'backendProfileId', 'builtin:anthropic', 'backendConfigurationRevision', 0, 'modelIdentity', 'viewed-model', 'endpointIdentity', NULL),
        model = 'viewed-model',
        reasoning_effort = 'viewed-effort',
        interaction_mode = 'plan',
        access_mode = 'full',
        branch = 'viewed/branch',
        worktree_path = ?,
        provider_session_id = 'viewed-provider-session'
      WHERE id = ?
    `).run(workspaceDirectory, state.active_conversation_id);
    new WorkspacePathAuthority(database).enrollConversation(
      state.active_conversation_id,
      state.project_id,
      workspaceDirectory,
    );
  })();
  const count = (database.prepare(
    "SELECT COUNT(*) AS count FROM conversations",
  ).get() as { count: number }).count;
  database.close();
  await page.reload();
  await expect(page.getByRole("heading", { name: "New chat", level: 1 }))
    .toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-runtime-generation",
    /^[0-9a-f-]{36}$/iu,
  );
  return count;
}
