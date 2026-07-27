import { _electron as electron } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
if (process.platform !== "darwin") throw new Error("README screenshots must be captured on macOS so the frameless titlebar is represented accurately.");
const repositoryRoot = resolve(import.meta.dirname, "..");
const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const screenshotDirectory = join(repositoryRoot, "docs", "screenshots");
const captureRoot = await mkdtemp(join(tmpdir(), "inertia-readme-capture-"));
const workspaceDirectory = "/tmp/inertia-demo-workspace";
const dataDirectory = join(captureRoot, "data");
const profileDirectory = join(captureRoot, "profile");
const databasePath = join(dataDirectory, "inertia.sqlite");
let ownsWorkspace = false;
let app;

async function launch() {
  return electron.launch({
    args: [repositoryRoot, `--user-data-dir=${profileDirectory}`],
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: dataDirectory,
      INERTIA_WORKSPACE_DIR: workspaceDirectory,
    },
  });
}

async function sizeWindow(width = 1512, height = 868) {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, { width, height });
}

async function capture(page, filename) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(screenshotDirectory, filename), animations: "disabled" });
  console.log(`Captured ${filename}`);
}

async function seedShowcaseData() {
  const database = new Database(databasePath);
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const runId = "readme-demo-run";
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const requestedAt = new Date(Date.now() - 5_000).toISOString();
  const startedAt = new Date(Date.now() - 4_500).toISOString();
  const assistantAt = new Date(Date.now() - 1_000).toISOString();
  const modelSelection = {
    harnessId: "codex-app-server",
    backendProfileId: "builtin:openai",
    backendProfileDisplayName: "OpenAI",
    modelId: "gpt-5.6-sol",
    alias: "GPT-5.6-Sol",
    reasoningEffort: "high",
    contextWindowOverride: 200_000,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: 0,
  };
  const continuationIdentity = {
    harnessId: modelSelection.harnessId,
    backendProfileId: modelSelection.backendProfileId,
    backendConfigurationRevision: modelSelection.backendConfigurationRevision,
    modelIdentity: null,
    endpointIdentity: null,
  };
  const historicalPatch = [
    "diff --git a/welcome.ts b/welcome.ts",
    "--- a/welcome.ts",
    "+++ b/welcome.ts",
    "@@ -1 +1 @@",
    "-export const welcome = 'calm and focused';",
    "+export const welcome = 'calm, focused, and ready';",
    "",
  ].join("\n");
  const patchDigest = createHash("sha256")
    .update(historicalPatch)
    .digest("hex");
  const artifactDirectory = join(dataDirectory, "turn-git-artifacts");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(artifactDirectory, `${patchDigest}.gz`),
    gzipSync(Buffer.from(historicalPatch, "utf8"), { level: 9 }),
    { mode: 0o600 },
  );
  const models = [{
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Frontier coding model for complex agentic work",
    isDefault: true,
    inputModalities: ["text", "image"],
    reasoningOptions: [
      { value: "low", label: "Low", description: "Fast responses for straightforward work" },
      { value: "medium", label: "Medium", description: "Balanced reasoning for everyday coding" },
      { value: "high", label: "High", description: "Deeper reasoning for complex changes" },
      { value: "xhigh", label: "Extra high", description: "Maximum depth for the hardest tasks" },
    ],
    defaultReasoningEffort: "high",
  }];
  const limits = [{
    id: "five-hour",
    label: "5-hour limit",
    usedPercent: 37,
    remainingPercent: 63,
    windowMinutes: 300,
    resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
  }];

  database.transaction(() => {
    database.prepare(`
      INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
      VALUES (?, 'Getting Started', ?, '#6f76d9', 'ready', ?, ?)
    `).run(projectId, workspaceDirectory, now, now);
    database.prepare(`
      INSERT INTO conversations (
        id, project_id, title, provider_id, model_selection_json,
        continuation_identity_json, model, reasoning_effort,
        interaction_mode, access_mode, status, completed_at, last_viewed_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, 'Welcome to Inertia', 'codex', ?, NULL,
        'gpt-5.6-sol', 'high', 'build', 'supervised', 'completed', ?, ?, ?, ?
      )
    `).run(
      conversationId,
      projectId,
      JSON.stringify(modelSelection),
      now,
      now,
      requestedAt,
      now,
    );
    database.prepare(`
      UPDATE app_state
      SET theme = 'dark',
          show_timestamps = 0,
          show_thinking = 1,
          show_usage = 1,
          usage_display_mode = 'expanded',
          active_project_id = ?,
          active_conversation_id = ?
      WHERE id = 1
    `).run(projectId, conversationId);
    database.prepare(`
      INSERT INTO agent_turns (
        id, conversation_id, run_id, user_message_id,
        terminal_assistant_message_id, provider_id, model_selection_json,
        continuation_identity_json, harness_id, backend_profile_id, model,
        model_alias, reasoning_effort, interaction_mode, access_mode,
        provider_session_before, provider_session_after, requested_at,
        started_at, completed_at, status, terminal_reason, checkpoint_id,
        usage_start_json, usage_completion_json, configuration_revision,
        association, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'codex', ?, ?, 'codex-app-server',
        'builtin:openai', 'gpt-5.6-sol', 'GPT-5.6-Sol', 'high',
        'build', 'supervised', NULL, NULL, ?, ?, ?, 'completed',
        'provider-completed', NULL, NULL, NULL, 0, 'authoritative', ?, ?
      )
    `).run(
      turnId,
      conversationId,
      runId,
      userMessageId,
      assistantMessageId,
      JSON.stringify(modelSelection),
      JSON.stringify(continuationIdentity),
      requestedAt,
      startedAt,
      now,
      requestedAt,
      now,
    );
    database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at, turn_id
      ) VALUES (?, ?, 'user', ?, '[]', ?, ?)
    `).run(
      userMessageId,
      conversationId,
      "Plan a focused pass to make the onboarding flow clearer.",
      requestedAt,
      turnId,
    );
    database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at, turn_id
      ) VALUES (?, ?, 'assistant', ?, '[]', ?, ?)
    `).run(
      assistantMessageId,
      conversationId,
      "I reviewed the onboarding path, kept the update focused, and left every change ready for review.",
      assistantAt,
      turnId,
    );
    database.prepare(`
      INSERT INTO activities (
        id, conversation_id, run_id, kind, title, detail, status, created_at,
        turn_id
      ) VALUES (?, ?, ?, 'status', 'Turn completed', NULL, 'completed', ?, ?)
    `).run(randomUUID(), conversationId, runId, now, turnId);
    database.prepare(`
      INSERT INTO agent_reasonings (
        id, conversation_id, run_id, content, status, created_at, turn_id
      ) VALUES (?, ?, ?, ?, 'completed', ?, ?)
    `).run(
      randomUUID(),
      conversationId,
      runId,
      "Kept the plan scoped to the onboarding experience and preserved the existing workspace flow.",
      now,
      turnId,
    );
    database.prepare(`
      INSERT INTO thread_usage (
        conversation_id, used_tokens, total_processed_tokens, total_processed_scope, max_tokens,
        input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
        reasoning_output_tokens, compacts_automatically, updated_at, turn_id
      ) VALUES (
        ?, 12000, 28400, 'thread', 200000, 9400, 1800, 400, 2600, 700, 1, ?, ?
      )
    `).run(conversationId, now, turnId);
    database.prepare(`
      INSERT INTO turn_git_artifacts (
        id, turn_id, conversation_id, run_id, repository_identity,
        worktree_identity, branch, before_checkpoint_id, before_ref, after_ref,
        before_fingerprint, after_fingerprint, files_json, insertions,
        deletions, status, completeness, patch_state, patch_digest,
        captured_at, terminal_assistant_message_id, failure_reason,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 'main', NULL, ?, ?, ?, ?, ?, 1, 1,
        'ready', 'complete', 'available', ?, ?, ?, NULL, ?, ?
      )
    `).run(
      randomUUID(),
      turnId,
      conversationId,
      runId,
      createHash("sha256").update("inertia-readme-demo-repository").digest("hex"),
      createHash("sha256").update("inertia-readme-demo-worktree").digest("hex"),
      createHash("sha256").update("inertia-readme-demo-before-ref").digest("hex"),
      createHash("sha256").update("inertia-readme-demo-after-ref").digest("hex"),
      createHash("sha256").update("export const welcome = 'calm and focused';\n").digest("hex"),
      createHash("sha256").update("export const welcome = 'calm, focused, and ready';\n").digest("hex"),
      JSON.stringify([{
        path: "welcome.ts",
        previousPath: null,
        status: "modified",
        insertions: 1,
        deletions: 1,
        binary: false,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: ".",
        worktreeStatus: "M",
      }]),
      patchDigest,
      now,
      assistantMessageId,
      requestedAt,
      now,
    );
    const metadataScope = {
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      modelId: "provider-catalog",
      executable: "/demo/bin/codex",
      version: "0.142.5",
      backendConfigurationRevision: 0,
      authState: "authenticated",
    };
    database.prepare(`
      INSERT INTO provider_metadata_scoped_cache (
        scope_key, provider_id, harness_id, backend_profile_id, model_id,
        executable, version, backend_configuration_revision, auth_state,
        models_json, models_updated_at, models_last_attempted_at, models_provenance, models_stale,
        rate_limits_json, rate_limits_updated_at, rate_limits_last_attempted_at, rate_limits_provenance, rate_limits_stale
      ) VALUES (
        ?, 'codex', 'codex-app-server', 'builtin:openai', 'provider-catalog',
        '/demo/bin/codex', '0.142.5', 0, 'authenticated',
        ?, ?, ?, 'provider', 0, ?, ?, ?, 'provider', 0
      )
    `).run(
      JSON.stringify(Object.values(metadataScope)),
      JSON.stringify(models),
      now,
      now,
      JSON.stringify(limits),
      now,
      now,
    );
  })();
  database.close();
}

try {
  await mkdir(workspaceDirectory);
  ownsWorkspace = true;
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(workspaceDirectory, "welcome.ts"), "export const welcome = 'calm and focused';\n", "utf8");
  await writeFile(join(workspaceDirectory, "README.md"), "# Getting Started\n", "utf8");
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspaceDirectory });
  await execFileAsync("git", ["add", "."], { cwd: workspaceDirectory });
  await execFileAsync("git", ["-c", "user.name=Inertia Demo", "-c", "user.email=demo@inertia.local", "commit", "-qm", "Getting started"], { cwd: workspaceDirectory });
  await writeFile(join(workspaceDirectory, "welcome.ts"), "export const welcome = 'calm, focused, and ready';\n", "utf8");

  app = await launch();
  let page = await app.firstWindow();
  await page.getByRole("button", { name: "Add your first project" }).waitFor();
  await app.close();
  app = undefined;

  await seedShowcaseData();

  app = await launch();
  page = await app.firstWindow();
  await page.getByRole("heading", { name: "Welcome to Inertia", level: 1 }).waitFor();
  await page.locator(".app-shell[data-runtime-generation]").waitFor();
  await sizeWindow();
  await page.getByRole("tab", { name: /Changes/u }).click();
  await page.getByRole("button", { name: "More composer options" }).waitFor();
  const usage = page.getByRole("region", { name: "Usage and context" });
  await usage.waitFor();
  await usage.locator('[data-context-ring-state="current"]').waitFor();
  await usage.locator(".usage-context-ring-label", { hasText: /^94$/u }).waitFor();
  await capture(page, "inertia-dark.png");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Light" }).click();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  await page.getByRole("tab", { name: /Changes/u }).click();
  await capture(page, "inertia-light.png");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.getByText(`Inertia v${packageManifest.version}`, { exact: true }).waitFor();
  await capture(page, "inertia-settings.png");

  await page.getByRole("button", { name: "Go to workspace" }).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await page.getByRole("dialog", { name: "Search Inertia" }).waitFor();
  await capture(page, "inertia-search.png");
  await page.keyboard.press("Escape");

  const database = new Database(databasePath);
  database.prepare("DELETE FROM projects").run();
  database.close();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Light" }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  await page.getByRole("heading", { name: "Bring a project into focus.", level: 2 }).waitFor();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(900, 700);
  await capture(page, "inertia-new-project.png");
} finally {
  await app?.close().catch(() => undefined);
  await rm(captureRoot, { recursive: true, force: true });
  if (ownsWorkspace) await rm(workspaceDirectory, { recursive: true, force: true });
}
