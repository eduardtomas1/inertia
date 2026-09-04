import { _electron as electron } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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
const companionWorkspaceDirectory = "/tmp/inertia-demo-companion";
const dataDirectory = join(captureRoot, "data");
const profileDirectory = join(captureRoot, "profile");
const databasePath = join(dataDirectory, "inertia.sqlite");
let ownsWorkspace = false;
let ownsCompanionWorkspace = false;
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

async function closeWorkspaceTools(page) {
  const tools = page.locator(".workspace-panel").first();
  if (!await tools.isVisible()) return;
  await page.getByRole("button", { name: "Close workspace tools" }).first().click();
  await tools.waitFor({ state: "hidden" });
}

async function selectWorkspaceTool(page, name) {
  const panel = page.locator(".workspace-panel");
  const tab = panel.locator(`[data-workspace-tab="${name.toLowerCase()}"]`);
  if (await tab.isVisible()) {
    await tab.click();
    return;
  }
  await panel.getByLabel("Choose workspace tool").click();
  await panel.getByRole("button", { name, exact: true }).click();
}

async function workspacePathReceipt(path) {
  const canonicalPath = await realpath(path);
  const info = await lstat(canonicalPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The README workspace fixture is not a direct directory.");
  }
  return JSON.stringify({
    version: 1,
    canonicalPath,
    directoryIdentity: {
      device: info.dev.toString(),
      inode: info.ino.toString(),
      birthtimeNs: info.birthtimeNs.toString(),
    },
    repository: null,
  });
}

async function seedShowcaseData() {
  const database = new Database(databasePath);
  const projectPathReceipt = await workspacePathReceipt(workspaceDirectory);
  const companionPathReceipt = await workspacePathReceipt(
    companionWorkspaceDirectory,
  );
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const conversationId = randomUUID();
  const companionProjectId = randomUUID();
  const companionConversationId = randomUUID();
  const turnId = randomUUID();
  const runId = "readme-demo-run";
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const companionUserMessageId = randomUUID();
  const companionAssistantMessageId = randomUUID();
  const requestedAt = new Date(Date.now() - 70_000).toISOString();
  const startedAt = new Date(Date.now() - 69_500).toISOString();
  const assistantAt = new Date(Date.now() - 64_000).toISOString();
  const completedAt = new Date(Date.now() - 63_000).toISOString();
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
  const workThreads = [
    {
      id: randomUUID(),
      title: "Harden sent attachment recovery",
      providerId: "claude",
      branch: "codex/attachment-recovery",
      updatedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      selection: {
        ...modelSelection,
        harnessId: "claude-agent-sdk",
        backendProfileId: "builtin:anthropic",
        backendProfileDisplayName: "Anthropic",
        modelId: "claude-sonnet-4-5",
        alias: "Claude Sonnet 4.5",
      },
    },
    {
      id: randomUUID(),
      title: "Verify Environment actions",
      providerId: "cursor",
      branch: "codex/environment-panel",
      updatedAt: new Date(Date.now() - 55 * 60_000).toISOString(),
      selection: {
        ...modelSelection,
        harnessId: "cursor-acp",
        backendProfileId: "builtin:cursor",
        backendProfileDisplayName: "Cursor",
        modelId: "cursor-managed",
        alias: "Cursor managed",
      },
    },
    {
      id: randomUUID(),
      title: "Audit usage aggregation",
      providerId: "opencode",
      branch: "codex/usage-dashboard",
      updatedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
      selection: {
        ...modelSelection,
        harnessId: "opencode-sdk",
        backendProfileId: "builtin:opencode",
        backendProfileDisplayName: "OpenCode",
        modelId: "provider-default",
        alias: null,
      },
    },
  ];
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
      VALUES (?, 'Interface', ?, '#6f76d9', 'ready', ?, ?)
    `).run(projectId, workspaceDirectory, now, now);
    database.prepare(`
      INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
      VALUES (?, 'Runtime', ?, '#4f9f8c', 'ready', ?, ?)
    `).run(
      companionProjectId,
      companionWorkspaceDirectory,
      now,
      now,
    );
    database.prepare(`
      INSERT INTO project_path_authorities (project_id, path, receipt_json)
      VALUES (?, ?, ?), (?, ?, ?)
    `).run(
      projectId,
      workspaceDirectory,
      projectPathReceipt,
      companionProjectId,
      companionWorkspaceDirectory,
      companionPathReceipt,
    );
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
      completedAt,
      now,
      requestedAt,
      completedAt,
    );
    database.prepare(`
      INSERT INTO conversations (
        id, project_id, title, provider_id, model_selection_json,
        continuation_identity_json, model, reasoning_effort,
        interaction_mode, access_mode, status, completed_at, last_viewed_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, 'Review runtime safeguards', 'codex', ?, NULL,
        'gpt-5.6-sol', 'high', 'build', 'supervised', 'idle', NULL, ?, ?, ?
      )
    `).run(
      companionConversationId,
      companionProjectId,
      JSON.stringify(modelSelection),
      now,
      requestedAt,
      now,
    );
    database.prepare(`
      UPDATE conversations SET branch = 'codex/release-0.0.48'
      WHERE id = ?
    `).run(conversationId);
    database.prepare(`
      UPDATE conversations SET branch = 'main'
      WHERE id = ?
    `).run(companionConversationId);
    const insertWorkThread = database.prepare(`
      INSERT INTO conversations (
        id, project_id, title, provider_id, model_selection_json,
        continuation_identity_json, model, reasoning_effort,
        interaction_mode, access_mode, status, branch, completed_at,
        last_viewed_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, NULL, ?, 'high', 'build', 'supervised', 'idle', ?,
        NULL, NULL, ?, ?
      )
    `);
    for (const thread of workThreads) {
      insertWorkThread.run(
        thread.id,
        projectId,
        thread.title,
        thread.providerId,
        JSON.stringify(thread.selection),
        thread.selection.modelId,
        thread.branch,
        thread.updatedAt,
        thread.updatedAt,
      );
    }
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
        started_at, completed_at, status, run_state, terminal_reason, checkpoint_id,
        usage_start_json, usage_completion_json, configuration_revision,
        association, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'codex', ?, ?, 'codex-app-server',
        'builtin:openai', 'gpt-5.6-sol', 'GPT-5.6-Sol', 'high',
        'build', 'supervised', NULL, NULL, ?, ?, ?, 'completed', 'completed',
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
      completedAt,
      requestedAt,
      completedAt,
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
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at, turn_id
      ) VALUES (?, ?, 'user', ?, '[]', ?, NULL)
    `).run(
      companionUserMessageId,
      companionConversationId,
      "Keep the runtime review independent from the interface chat.",
      requestedAt,
    );
    database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at, turn_id
      ) VALUES (?, ?, 'assistant', ?, '[]', ?, NULL)
    `).run(
      companionAssistantMessageId,
      companionConversationId,
      "Keep detached chat windows scoped to their exact conversation.",
      assistantAt,
    );
    database.prepare(`
      INSERT INTO activities (
        id, conversation_id, run_id, kind, title, detail, status, created_at,
        turn_id
      ) VALUES (?, ?, ?, 'status', 'Turn completed', NULL, 'completed', ?, ?)
    `).run(randomUUID(), conversationId, runId, completedAt, turnId);
    database.prepare(`
      INSERT INTO agent_reasonings (
        id, conversation_id, run_id, content, status, created_at, turn_id
      ) VALUES (?, ?, ?, ?, 'completed', ?, ?)
    `).run(
      randomUUID(),
      conversationId,
      runId,
      "Kept the plan scoped to the onboarding experience and preserved the existing workspace flow.",
      completedAt,
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
    `).run(conversationId, completedAt, turnId);
    database.prepare(`
      INSERT INTO thread_usage (
        conversation_id, used_tokens, total_processed_tokens,
        total_processed_scope, max_tokens, input_tokens,
        cached_input_tokens, cache_write_input_tokens, output_tokens,
        reasoning_output_tokens, compacts_automatically, updated_at, turn_id
      ) VALUES (
        ?, 9000, 16600, 'thread', 200000, 7200, 1100, 200, 1800, 400,
        1, ?, NULL
      )
    `).run(companionConversationId, now);
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
      completedAt,
      assistantMessageId,
      requestedAt,
      completedAt,
    );
    database.prepare(`
      INSERT INTO agent_goals (
        conversation_id, source, provider_session_id, objective, status,
        token_budget, tokens_used, time_used_seconds, created_at, updated_at,
        synchronized_at
      ) VALUES (
        ?, 'inertia-local', NULL, ?, 'active',
        NULL, NULL, 68, ?, ?, NULL
      )
    `).run(
      conversationId,
      "Keep delegated work truthful, focused, and ready for review",
      requestedAt,
      completedAt,
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
  return {
    projectId,
    conversationId,
    companionProjectId,
    companionConversationId,
    modelSelection,
    continuationIdentity,
  };
}

function seedActiveWorkstream(showcase) {
  const database = new Database(databasePath);
  const requestedAt = new Date(Date.now() - 21_000).toISOString();
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const at = (seconds) =>
    new Date(Date.parse(startedAt) + seconds * 1_000).toISOString();
  const turnId = randomUUID();
  const runId = "readme-active-workstream";
  const userMessageId = randomUUID();
  const delegatedParentId = randomUUID();
  const delegatedChildId = randomUUID();
  const delegatedVerifierId = randomUUID();
  database.transaction(() => {
    database.prepare(`
      UPDATE conversations
      SET status = 'running', completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(at(18), showcase.conversationId);
    database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at,
        turn_id
      ) VALUES (?, ?, 'user', ?, '[]', ?, NULL)
    `).run(
      userMessageId,
      showcase.conversationId,
      "Refine the split workspace without changing its ownership boundaries.",
      requestedAt,
    );
    database.prepare(`
      INSERT INTO agent_turns (
        id, conversation_id, run_id, user_message_id,
        terminal_assistant_message_id, provider_id, model_selection_json,
        continuation_identity_json, harness_id, backend_profile_id, model,
        model_alias, reasoning_effort, interaction_mode, access_mode,
        provider_session_before, provider_session_after, requested_at,
        started_at, completed_at, status, run_state, terminal_reason, checkpoint_id,
        usage_start_json, usage_completion_json, configuration_revision,
        association, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, NULL, 'codex', ?, ?, 'codex-app-server',
        'builtin:openai', 'gpt-5.6-sol', 'GPT-5.6-Sol', 'high',
        'build', 'supervised', NULL, NULL, ?, ?, NULL, 'running', 'running',
        NULL, NULL, NULL, NULL, 0, 'authoritative', ?, ?
      )
    `).run(
      turnId,
      showcase.conversationId,
      runId,
      userMessageId,
      JSON.stringify(showcase.modelSelection),
      JSON.stringify(showcase.continuationIdentity),
      requestedAt,
      startedAt,
      requestedAt,
      at(18),
    );
    database.prepare(`
      UPDATE messages SET turn_id = ? WHERE id = ?
    `).run(turnId, userMessageId);
    database.prepare(`
      INSERT INTO subagent_traces (
        id, conversation_id, run_id, turn_id, provider_id,
        provider_task_id, provider_agent_id, parent_trace_id,
        parent_provider_agent_id, parent_provider_tool_use_id,
        provider_tool_use_id, provider_role, provider_name, status,
        description, progress, result, sequence, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'codex',
        'task-interface-audit', 'agent-interface-audit', NULL,
        NULL, NULL, 'tool-interface-audit', 'reviewer',
        'Interface Auditor', 'running',
        'Review the interaction and accessibility boundaries.',
        'Checking the split workspace ownership.', NULL,
        1, ?, ?
      )
    `).run(
      delegatedParentId,
      showcase.conversationId,
      runId,
      turnId,
      at(4),
      at(18),
    );
    database.prepare(`
      INSERT INTO subagent_traces (
        id, conversation_id, run_id, turn_id, provider_id,
        provider_task_id, provider_agent_id, parent_trace_id,
        parent_provider_agent_id, parent_provider_tool_use_id,
        provider_tool_use_id, provider_role, provider_name, status,
        description, progress, result, sequence, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'codex',
        'task-keyboard-check', 'agent-keyboard-check', ?,
        'agent-interface-audit', NULL, 'tool-keyboard-check', 'analyst',
        'Keyboard Check', 'completed',
        'Verify focus and keyboard ownership.',
        NULL, 'Focus returns to the owning conversation.',
        2, ?, ?
      )
    `).run(
      delegatedChildId,
      showcase.conversationId,
      runId,
      turnId,
      delegatedParentId,
      at(6),
      at(14),
    );
    database.prepare(`
      INSERT INTO subagent_traces (
        id, conversation_id, run_id, turn_id, provider_id,
        provider_task_id, provider_agent_id, parent_trace_id,
        parent_provider_agent_id, parent_provider_tool_use_id,
        provider_tool_use_id, provider_role, provider_name, status,
        description, progress, result, sequence, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'codex',
        'task-release-verifier', 'agent-release-verifier', NULL,
        NULL, NULL, 'tool-release-verifier', 'verifier',
        'Release Verifier', 'waiting',
        'Confirm the final cross-platform evidence.',
        'Waiting for the exact release CI matrix.', NULL,
        3, ?, ?
      )
    `).run(
      delegatedVerifierId,
      showcase.conversationId,
      runId,
      turnId,
      at(8),
      at(18),
    );
    database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at,
        turn_id
      ) VALUES (?, ?, 'assistant', ?, '[]', ?, ?)
    `).run(
      randomUUID(),
      showcase.conversationId,
      "I’m tracing the pane state and route ownership before changing the layout.",
      at(3),
      turnId,
    );
    for (const [seconds, kind, title] of [
      [5, "command", "Inspected the split workspace"],
      [7, "file", "Read pane ownership state"],
    ]) {
      database.prepare(`
        INSERT INTO activities (
          id, conversation_id, run_id, kind, title, detail, status,
          created_at, turn_id
        ) VALUES (?, ?, ?, ?, ?, NULL, 'completed', ?, ?)
      `).run(
        randomUUID(),
        showcase.conversationId,
        runId,
        kind,
        title,
        at(seconds),
        turnId,
      );
    }
    database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at,
        turn_id
      ) VALUES (?, ?, 'assistant', ?, '[]', ?, ?)
    `).run(
      randomUUID(),
      showcase.conversationId,
      "The ownership model is sound. I’m tightening the focused pane behavior and validating both chats now.",
      at(10),
      turnId,
    );
    for (const [seconds, kind, title, status] of [
      [13, "file", "Updated split workspace flow", "completed"],
      [16, "command", "Running focused workspace tests", "running"],
    ]) {
      database.prepare(`
        INSERT INTO activities (
          id, conversation_id, run_id, kind, title, detail, status,
          created_at, turn_id
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        randomUUID(),
        showcase.conversationId,
        runId,
        kind,
        title,
        status,
        at(seconds),
        turnId,
      );
    }
    database.prepare(`
      INSERT INTO workspace_runs (
        id, kind, project_id, conversation_id, action_id, label, detail,
        status, attention_state, port, started_at, finished_at
      ) VALUES (
        ?, 'agent', ?, ?, NULL, 'Refine split workspace',
        'Validating pane ownership and focused-chat behavior.',
        'running', 'acknowledged', NULL, ?, NULL
      )
    `).run(
      runId,
      showcase.projectId,
      showcase.conversationId,
      startedAt,
    );
  })();
  database.pragma("wal_checkpoint(PASSIVE)");
  database.close();
  return turnId;
}

try {
  await mkdir(workspaceDirectory);
  ownsWorkspace = true;
  await mkdir(companionWorkspaceDirectory);
  ownsCompanionWorkspace = true;
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(workspaceDirectory, "welcome.ts"), "export const welcome = 'calm and focused';\n", "utf8");
  await writeFile(join(workspaceDirectory, "README.md"), "# Getting Started\n", "utf8");
  await writeFile(
    join(companionWorkspaceDirectory, "runtime.ts"),
    "export const runtime = 'supervised';\n",
    "utf8",
  );
  await writeFile(
    join(companionWorkspaceDirectory, "README.md"),
    "# Runtime safeguards\n",
    "utf8",
  );
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspaceDirectory });
  await execFileAsync("git", ["add", "."], { cwd: workspaceDirectory });
  await execFileAsync("git", ["-c", "user.name=Inertia Demo", "-c", "user.email=demo@inertia.local", "commit", "-qm", "Getting started"], { cwd: workspaceDirectory });
  await writeFile(join(workspaceDirectory, "welcome.ts"), "export const welcome = 'calm, focused, and ready';\n", "utf8");
  await execFileAsync("git", ["init", "-q", "-b", "main"], {
    cwd: companionWorkspaceDirectory,
  });
  await execFileAsync("git", ["add", "."], {
    cwd: companionWorkspaceDirectory,
  });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Inertia Demo",
      "-c",
      "user.email=demo@inertia.local",
      "commit",
      "-qm",
      "Runtime safeguards",
    ],
    { cwd: companionWorkspaceDirectory },
  );

  app = await launch();
  let page = await app.firstWindow();
  await page.getByRole("button", { name: "Add your first project" }).waitFor();
  await app.close();
  app = undefined;

  const showcase = await seedShowcaseData();

  app = await launch();
  page = await app.firstWindow();
  await page.getByRole("heading", { name: "Welcome to Inertia", level: 1 }).waitFor();
  await page.locator(".app-shell[data-runtime-generation]").waitFor();
  await sizeWindow();
  await page.getByRole("tabpanel", { name: "Environment" }).waitFor();
  await capture(page, "inertia-dark.png");

  await page.getByRole("button", { name: "Daily work", exact: true }).click();
  const dailyWorkDialog = page.getByRole("dialog", { name: "Daily work" });
  await dailyWorkDialog.getByRole("region", {
    name: "Daily work totals",
  }).waitFor();
  await capture(page, "inertia-daily-work.png");
  await page.getByRole("button", { name: "Close daily work" }).click();

  const detachedWindowOpened = app.waitForEvent("window");
  await page.getByRole("button", {
    name: "Open Welcome to Inertia in a new window",
  }).click();
  const detachedPage = await detachedWindowOpened;
  await detachedPage.locator(".detached-chat-shell").waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const detached = BrowserWindow.getAllWindows().find((window) =>
      window.getTitle().startsWith("Welcome to Inertia"));
    detached?.setSize(1_100, 760);
  });
  await detachedPage.getByRole("textbox", { name: "Message" }).waitFor();
  await capture(detachedPage, "inertia-detached-chat.png");
  await Promise.all([
    detachedPage.waitForEvent("close"),
    detachedPage.getByRole("button", {
      name: "Return chat to main window",
    }).click({ noWaitAfter: true }),
  ]);
  await page.getByRole("textbox", { name: "Message" }).waitFor();

  await page.getByRole("button", {
    name: "Add context from another chat",
  }).click();
  const contextDialog = page.getByRole("dialog", {
    name: "Bring context from another chat",
  });
  await contextDialog.getByRole("button", {
    name: /Keep detached chat windows scoped to their exact conversation/u,
  }).click();
  await contextDialog.getByLabel("Context preview").getByText(
    "Keep detached chat windows scoped to their exact conversation.",
    { exact: true },
  ).waitFor();
  await capture(page, "inertia-context-handoff.png");
  await contextDialog.getByRole("button", { name: "Cancel" }).click();

  const sidebar = page.getByRole("complementary", {
    name: "Project navigation",
    exact: true,
  });
  await sidebar.getByRole("button", { name: "Launch two chats" }).click();
  const duo = page.getByRole("dialog", {
    name: "Launch a duo",
  });
  await duo.getByRole("textbox", { name: "Shared prompt" }).fill(
    "Review the same implementation independently and compare the safest path.",
  );
  await duo.getByRole("textbox", { name: "Chat 1 name" }).fill(
    "Interface review",
  );
  await duo.getByRole("textbox", { name: "Chat 2 name" }).fill(
    "Runtime review",
  );
  await duo.getByRole("combobox", { name: "Chat 2 project" }).selectOption({
    label: "Runtime",
  });
  await capture(page, "inertia-duo.png");
  await duo.getByRole("button", { name: "Close multi-spawn" }).click();
  await sidebar.getByRole("button", { name: "Expand Runtime" }).click();
  await sidebar.getByRole("button", {
    name: "Thread actions for Review runtime safeguards",
  }).click();
  await sidebar.getByRole("menuitem", {
    name: "Add this chat to split view",
  }).click();
  const splitWorkspace = page.getByRole("main", {
    name: "Split conversation workspace",
  });
  const primaryPane = page.getByRole("region", {
    name: "Primary chat: Interface · Welcome to Inertia",
  });
  const secondaryPane = page.getByRole("region", {
    name: "Second chat: Runtime · Review runtime safeguards",
  });
  await splitWorkspace.waitFor();
  await primaryPane.getByRole("textbox", { name: "Message" }).waitFor();
  await secondaryPane.getByRole("textbox", { name: "Message" }).waitFor();
  await primaryPane.getByRole("button", {
    name: "Open tools for Welcome to Inertia",
  }).waitFor();
  await secondaryPane.getByRole("button", {
    name: "Open tools for Review runtime safeguards",
  }).waitFor();
  await capture(page, "inertia-split-workspace.png");
  await secondaryPane.getByRole("button", {
    name: "Close split chat Review runtime safeguards",
  }).click();
  await splitWorkspace.waitFor({ state: "detached" });

  const activeTurnId = seedActiveWorkstream(showcase);
  await page.reload();
  await page.getByRole("heading", {
    name: "Welcome to Inertia",
    level: 1,
  }).waitFor();
  await sidebar.getByRole("button", { name: "Work", exact: true }).click();
  await sidebar.getByRole("button", {
    name: /^Harden sent attachment recovery,/u,
  }).waitFor();
  await capture(page, "inertia-work.png");
  await sidebar.getByRole("button", { name: "Projects", exact: true }).click();
  await closeWorkspaceTools(page);
  const activeTurn = page.locator(`[data-turn-id="${activeTurnId}"]`);
  await activeTurn.scrollIntoViewIfNeeded();
  await activeTurn.locator(".turn-execution-rail.is-live").waitFor();
  await activeTurn.locator(".turn-commentary-row").nth(1).waitFor();
  await activeTurn.locator(".agent-activity-title").filter({
    hasText: /^Running focused workspace tests$/u,
  }).waitFor();
  await capture(page, "inertia-workstream.png");

  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await selectWorkspaceTool(page, "Goal");
  const goalPanel = page.getByRole("region", {
    name: "Goals and agent workflows",
  });
  await goalPanel.getByText("Inertia local", { exact: true }).waitFor();
  await goalPanel.getByText("Interface Auditor", { exact: true }).waitFor();
  await goalPanel.getByText("Release Verifier", { exact: true }).waitFor();
  await capture(page, "inertia-agent-workflows.png");
  await page
    .getByRole("complementary", { name: "Workspace tools" })
    .getByRole("button", { name: "Close workspace tools" })
    .click();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Light" }).click();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await selectWorkspaceTool(page, "Changes");
  await capture(page, "inertia-light.png");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.getByText(
    `Inertia · v${packageManifest.version}`,
    { exact: true },
  ).first().waitFor();
  await capture(page, "inertia-settings.png");

  await page.getByRole("button", { name: "Discord", exact: true }).click();
  await page.getByRole("heading", { name: "Discord", level: 3 }).waitFor();
  await page.getByLabel("Discord release repository URL").fill(
    "https://github.com/eduardtomas1/inertia",
  );
  await page.getByText(
    "Incoming Discord webhook stored only in the operating system credential vault.",
    { exact: true },
  ).waitFor();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(1_500, 900);
  await capture(page, "inertia-discord-settings.png");

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
  if (ownsCompanionWorkspace) {
    await rm(companionWorkspaceDirectory, { recursive: true, force: true });
  }
}
