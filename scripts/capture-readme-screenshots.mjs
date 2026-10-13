import { _electron as electron } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
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
const screenshotDirectory = join(repositoryRoot, "docs", "screenshots");
const captureRoot = await mkdtemp(join(tmpdir(), "inertia-readme-capture-"));
const workspaceDirectory = "/tmp/fernway";
const companionWorkspaceDirectory = "/tmp/fernway-api";
const featureBranch = "shorter-signup";
const dataDirectory = join(captureRoot, "data");
const profileDirectory = join(captureRoot, "profile");
const databasePath = join(dataDirectory, "inertia.sqlite");
const providerBinDirectory = join(captureRoot, "provider-bin");
const planSteps = [
  "Combine the email and password screens",
  "Save a draft after each step",
  "Review keyboard access and both themes",
];
const planDocument = [
  "# Plan: Three-step sign-up",
  "",
  "## Context",
  "",
  "Sign-up takes five screens today, and closing the tab loses every answer. Combine the first screens and keep a local draft until the email address is confirmed.",
  "",
  "## Steps",
  "",
  ...planSteps.map((step, index) => `${index + 1}. ${step}`),
  "",
  "## Checks",
  "",
  "- A returning visitor lands on the step they left.",
  "- The draft is removed after confirmation.",
].join("\n");
const signupStepsBefore = [
  "export const signupSteps = [",
  '  { id: "email", title: "Your email" },',
  '  { id: "password", title: "Choose a password" },',
  '  { id: "profile", title: "About you" },',
  '  { id: "interests", title: "Where do you like to go?" },',
  '  { id: "confirm", title: "Confirm your account" },',
  "] as const;",
  "",
  'export type SignupStepId = (typeof signupSteps)[number]["id"];',
  "",
].join("\n");
const signupStepsAfter = [
  "export const signupSteps = [",
  '  { id: "account", title: "Create your account" },',
  '  { id: "interests", title: "Where do you like to go?" },',
  '  { id: "confirm", title: "Confirm your email" },',
  "] as const;",
  "",
  'export type SignupStepId = (typeof signupSteps)[number]["id"];',
  "",
].join("\n");
const signupDraftBefore = [
  'import type { SignupStepId } from "./steps";',
  "",
  "export function clearDraft(): void {",
  '  sessionStorage.removeItem("signup");',
  "}",
  "",
].join("\n");
const signupDraftAfter = [
  'import type { SignupStepId } from "./steps";',
  "",
  'const draftKey = "fernway.signup-draft";',
  "",
  "export type Draft = {",
  "  step: SignupStepId;",
  "  answers: Record<string, string>;",
  "};",
  "",
  "export function saveDraft(draft: Draft): void {",
  "  const value = JSON.stringify(draft);",
  "  localStorage.setItem(draftKey, value);",
  "}",
  "",
  "export function clearDraft(): void {",
  "  localStorage.removeItem(draftKey);",
  "}",
  "",
].join("\n");
const rateLimitBefore = [
  "export const limits = {",
  "  login: 10,",
  "  signup: 5,",
  "};",
  "",
].join("\n");
const rateLimitAfter = [
  "export const limits = {",
  "  login: 10,",
  "  signup: 5,",
  "  bookings: 20,",
  "};",
  "",
  'export const exemptRoutes = ["/webhooks/payments"];',
  "",
].join("\n");
const showcaseTasks = [
  {
    title: "Fix the date picker on Safari",
    note: "The return date resets when the month changes. Two customers reported it this week.",
    priority: "urgent",
    dueInDays: 1,
  },
  { title: "Write release notes for 2.4", note: "", priority: "high", dueInDays: 3 },
  { title: "Review the trip links pull request", note: "", priority: "medium", dueInDays: null },
  { title: "Refresh the App Store screenshots", note: "", priority: null, dueInDays: null },
  { title: "Book the design review", note: "", priority: null, dueInDays: null, done: true },
];
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
      INERTIA_TEST_PROVIDER_BIN_DIR: providerBinDirectory,
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
  const toggle = page.locator("[data-panel-layout-controls] [data-right-panel-toggle]");
  if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
  await page.locator(".workspace-panel").waitFor({ state: "hidden" });
}

async function selectWorkspaceSurface(page, name) {
  const tools = page.locator(".workspace-panel");
  const tab = tools.locator(`[data-workspace-tab="${name.toLowerCase()}"]`);
  if (await tab.isVisible()) {
    await tab.click();
    return;
  }
  const launcher = tools.getByRole("group", { name: "Open a surface" });
  if (await launcher.isVisible()) {
    await launcher.getByRole("button", { name: new RegExp(`^${name}`, "u") }).click();
  } else {
    await tools.getByRole("button", { name: "Add panel surface" }).click();
    await page.getByRole("menu", { name: "Add panel surface" })
      .getByRole("menuitem", { name: new RegExp(`^${name}`, "u") }).click();
  }
}

function localDate(daysFromToday) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function commitAll(cwd, message) {
  await git(cwd, ["add", "."]);
  await git(cwd, [
    "-c",
    "user.name=Fernway Team",
    "-c",
    "user.email=team@fernway.example",
    "commit",
    "-qm",
    message,
  ]);
}

async function writeWorkspaceFile(root, path, contents) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), contents, "utf8");
}

async function workingTreePatch(cwd) {
  const text = await git(cwd, ["diff", "--no-color", "--no-ext-diff"]);
  const numstat = await git(cwd, ["diff", "--numstat"]);
  const files = numstat.trim().split("\n").map((line) => {
    const [insertions, deletions, path] = line.split("\t");
    return {
      path,
      previousPath: null,
      status: "modified",
      insertions: Number(insertions),
      deletions: Number(deletions),
      binary: false,
      untracked: false,
      staged: false,
      unstaged: true,
      indexStatus: ".",
      worktreeStatus: "M",
    };
  });
  return {
    text,
    files,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
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

async function seedShowcaseData(patch, companionPatch) {
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
  const companionTurnId = randomUUID();
  const companionRunId = randomUUID();
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
      title: "Fix flaky checkout test",
      providerId: "claude",
      branch: "fix/checkout-test",
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
      title: "Add shareable trip links",
      providerId: "cursor",
      branch: "trip-links",
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
      title: "Speed up itinerary search",
      providerId: "opencode",
      branch: "search-perf",
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
  const patchDigest = createHash("sha256")
    .update(patch.text)
    .digest("hex");
  const companionPatchDigest = createHash("sha256")
    .update(companionPatch.text)
    .digest("hex");
  const artifactDirectory = join(dataDirectory, "turn-git-artifacts");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(artifactDirectory, `${patchDigest}.gz`),
    gzipSync(Buffer.from(patch.text, "utf8"), { level: 9 }),
    { mode: 0o600 },
  );
  await writeFile(
    join(artifactDirectory, `${companionPatchDigest}.gz`),
    gzipSync(Buffer.from(companionPatch.text, "utf8"), { level: 9 }),
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
      VALUES (?, 'Fernway', ?, '#6f76d9', 'ready', ?, ?)
    `).run(projectId, workspaceDirectory, now, now);
    database.prepare(`
      INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
      VALUES (?, 'Fernway API', ?, '#4f9f8c', 'ready', ?, ?)
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
        ?, ?, 'Simplify sign-up', 'codex', ?, NULL,
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
        ?, ?, 'Limit booking requests', 'codex', ?, NULL,
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
      UPDATE conversations SET branch = ?
      WHERE id = ?
    `).run(featureBranch, conversationId);
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
          default_provider = 'codex',
          default_model = 'gpt-5.6-sol',
          default_reasoning_effort = 'high',
          show_timestamps = 0,
          show_thinking = 1,
          show_usage = 1,
          usage_display_mode = 'expanded',
          active_project_id = ?,
          active_conversation_id = ?
      WHERE id = 1
    `).run(projectId, conversationId);
    const insertTurn = database.prepare(`
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
    `);
    insertTurn.run(
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
    insertTurn.run(
      companionTurnId, companionConversationId, companionRunId,
      companionUserMessageId, companionAssistantMessageId,
      JSON.stringify(modelSelection), JSON.stringify(continuationIdentity),
      requestedAt, startedAt, completedAt, requestedAt, completedAt,
    );
    database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at, turn_id
      ) VALUES (?, ?, 'user', ?, '[]', ?, ?)
    `).run(
      userMessageId,
      conversationId,
      "Make sign-up shorter, and keep people's answers if they leave halfway through.",
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
      "Sign-up now takes three steps instead of five, and nobody loses their answers if they close the tab.\n\n- **Fewer steps.** Email and password now share the first screen, and the profile questions wait until after the first trip.\n- **Saved progress.** Each step saves a local draft, so returning visitors pick up where they left off.\n- **Clean finish.** The draft is cleared once the email address is confirmed.\n\nThe changes are ready for a keyboard and theme review.",
      assistantAt,
      turnId,
    );
    database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at, turn_id
      ) VALUES (?, ?, 'user', ?, '[]', ?, ?)
    `).run(
      companionUserMessageId,
      companionConversationId,
      "Add rate limiting to booking requests without touching the payment webhooks.",
      requestedAt,
      companionTurnId,
    );
    database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at, turn_id
      ) VALUES (?, ?, 'assistant', ?, '[]', ?, ?)
    `).run(
      companionAssistantMessageId,
      companionConversationId,
      "Booking requests are now limited per account, and the payment webhooks are untouched.\n\n- `POST /bookings` allows 20 requests a minute for each account.\n- Sign-up and login keep their existing limits.\n- Webhook routes skip the limiter entirely.\n\nNew tests cover the limit, the reset window and the webhook exemption.",
      assistantAt,
      companionTurnId,
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
      "Kept the change to the sign-up screens and the draft helper.",
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
        1, ?, ?
      )
    `).run(companionConversationId, now, companionTurnId);
    const insertTurnArtifact = database.prepare(`
      INSERT INTO turn_git_artifacts (
        id, turn_id, conversation_id, run_id, repository_identity,
        worktree_identity, branch, before_checkpoint_id, before_ref, after_ref,
        before_fingerprint, after_fingerprint, files_json, insertions,
        deletions, status, completeness, patch_state, patch_digest,
        captured_at, terminal_assistant_message_id, failure_reason,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?,
        'ready', 'complete', 'available', ?, ?, ?, NULL, ?, ?
      )
    `);
    insertTurnArtifact.run(
      randomUUID(),
      turnId,
      conversationId,
      runId,
      createHash("sha256").update("fernway-repository").digest("hex"),
      createHash("sha256").update("fernway-worktree").digest("hex"),
      featureBranch,
      createHash("sha256").update("fernway-before-ref").digest("hex"),
      createHash("sha256").update("fernway-after-ref").digest("hex"),
      createHash("sha256").update("fernway-before").digest("hex"),
      createHash("sha256").update(patch.text).digest("hex"),
      JSON.stringify(patch.files),
      patch.insertions,
      patch.deletions,
      patchDigest,
      completedAt,
      assistantMessageId,
      requestedAt,
      completedAt,
    );
    insertTurnArtifact.run(
      randomUUID(),
      companionTurnId,
      companionConversationId,
      companionRunId,
      createHash("sha256").update("fernway-api-repository").digest("hex"),
      createHash("sha256").update("fernway-api-worktree").digest("hex"),
      "main",
      createHash("sha256").update("fernway-api-before-ref").digest("hex"),
      createHash("sha256").update("fernway-api-after-ref").digest("hex"),
      createHash("sha256").update("fernway-api-before").digest("hex"),
      createHash("sha256").update(companionPatch.text).digest("hex"),
      JSON.stringify(companionPatch.files),
      companionPatch.insertions,
      companionPatch.deletions,
      companionPatchDigest,
      completedAt,
      companionAssistantMessageId,
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
      "Ship a three-step sign-up that never loses progress",
      requestedAt,
      completedAt,
    );
    database.prepare(`
      INSERT INTO agent_plans (
        conversation_id, run_id, turn_id, explanation, steps_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      conversationId,
      runId,
      turnId,
      planDocument,
      JSON.stringify(planSteps.map((step, index) => ({
        step,
        status: index < 2 ? "completed" : "inProgress",
      }))),
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
    const insertTask = database.prepare(`
      INSERT INTO todos (
        id, title, note, priority, due_date, completed_at, conversation_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `);
    showcaseTasks.forEach((task, index) => {
      const createdAt = new Date(Date.now() - (60 - index) * 60_000).toISOString();
      insertTask.run(
        randomUUID(),
        task.title,
        task.note,
        task.priority,
        task.dueInDays === null ? null : localDate(task.dueInDays),
        task.done ? completedAt : null,
        createdAt,
        task.done ? completedAt : createdAt,
      );
    });
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


try {
  await mkdir(workspaceDirectory);
  ownsWorkspace = true;
  await mkdir(companionWorkspaceDirectory);
  ownsCompanionWorkspace = true;
  await mkdir(screenshotDirectory, { recursive: true });
  await mkdir(providerBinDirectory);
  await writeWorkspaceFile(workspaceDirectory, "README.md", "# Fernway\n\nPlan trips with friends.\n");
  await writeWorkspaceFile(workspaceDirectory, "src/signup/steps.ts", signupStepsBefore);
  await writeWorkspaceFile(workspaceDirectory, "src/signup/draft.ts", signupDraftBefore);
  await git(workspaceDirectory, ["init", "-q", "-b", "main"]);
  await commitAll(workspaceDirectory, "Add the sign-up steps");
  await git(workspaceDirectory, ["checkout", "-q", "-b", featureBranch]);
  await writeWorkspaceFile(workspaceDirectory, "src/signup/steps.ts", signupStepsAfter);
  await writeWorkspaceFile(workspaceDirectory, "src/signup/draft.ts", signupDraftAfter);
  const patch = await workingTreePatch(workspaceDirectory);
  await writeWorkspaceFile(companionWorkspaceDirectory, "README.md", "# Fernway API\n");
  await writeWorkspaceFile(
    companionWorkspaceDirectory,
    "src/bookings/rateLimit.ts",
    rateLimitBefore,
  );
  await git(companionWorkspaceDirectory, ["init", "-q", "-b", "main"]);
  await commitAll(companionWorkspaceDirectory, "Add request limits");
  await writeWorkspaceFile(companionWorkspaceDirectory, "src/bookings/rateLimit.ts", rateLimitAfter);
  const companionPatch = await workingTreePatch(companionWorkspaceDirectory);

  app = await launch();
  let page = await app.firstWindow();
  await page.getByRole("button", { name: "Add your first project" }).waitFor();
  await app.close();
  app = undefined;

  await seedShowcaseData(patch, companionPatch);

  app = await launch();
  page = await app.firstWindow();
  await page.getByRole("heading", { name: "Simplify sign-up", level: 1 }).waitFor();
  await page.locator(".app-shell[data-runtime-generation]").waitFor();
  await sizeWindow();
  await page.locator('.app-shell[data-connection-status="online"]').waitFor();
  await closeWorkspaceTools(page);
  await page.getByRole("button", { name: "More Git actions", exact: true }).waitFor();
  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
  await page.mouse.move(1100, 350);
  await capture(page, "inertia-dark.png");
  await page.keyboard.press("Meta+K");
  await page.getByRole("combobox", {
    name: "Search commands, projects, chats, and messages",
  }).fill("sign-up");
  await page.locator(".palette-message-snippet mark").first().waitFor();
  await capture(page, "inertia-message-search.png");
  await page.keyboard.press("Escape");
  await page.locator("[data-panel-layout-controls] [data-right-panel-toggle]").click();
  const tools = page.locator(".workspace-panel");
  await tools.waitFor({ state: "visible" });
  const changesTab = tools.locator('[data-workspace-tab="changes"]');
  await selectWorkspaceSurface(page, "Changes");
  await page.locator(".diff-line.is-addition").first().waitFor();
  const toolsResize = page.getByRole("separator", { name: "Resize workspace tools" });
  for (let step = 0; step < 6; step += 1) await toolsResize.press("Shift+ArrowLeft");
  await changesTab.click();
  await page.mouse.move(1100, 350);
  await capture(page, "inertia-git-workflow.png");
  await toolsResize.press("Enter");
  await selectWorkspaceSurface(page, "Goal");
  await tools.getByText("Ship a three-step sign-up that never loses progress", { exact: true }).waitFor();
  await tools.getByText("2 of 3 plan steps complete", { exact: true }).waitFor();
  await page.mouse.move(1100, 350);
  await capture(page, "inertia-goals.png");
  await selectWorkspaceSurface(page, "Plan");
  const plan = tools.getByRole("region", { name: "Implementation plan" });
  await plan.getByRole("heading", { level: 2, name: "Three-step sign-up" }).waitFor();
  await plan.getByText("2 of 3 complete", { exact: true }).waitFor();
  await page.mouse.move(1100, 350);
  await capture(page, "inertia-plan.png");
  await closeWorkspaceTools(page);
  await sidebar.getByRole("button", { name: "Filter work by project" }).click();
  await page.getByRole("combobox", { name: "Search projects" }).fill("Fernway");
  await capture(page, "inertia-project-picker.png");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Choose project filter" }).waitFor({ state: "hidden" });
  await sidebar.locator(".activity-thread-select").filter({
    hasText: "Limit booking requests",
  }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add this chat to split view", exact: true }).click();
  await page.getByRole("main", { name: "Split conversation workspace" }).waitFor();
  await page.getByText("Webhook routes skip the limiter entirely.", { exact: true }).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(1100, 350);
  await capture(page, "inertia-split-workspace.png");
  await page.getByRole("button", { name: "Close split chat Limit booking requests", exact: true }).click();
  await sidebar.getByRole("button", { name: "Tasks", exact: true }).click();
  const tasks = page.getByRole("main", { name: "Tasks" });
  await tasks.getByRole("button", { name: /^Fix the date picker on Safari/u }).click();
  const taskDetail = tasks.getByRole("complementary", { name: "Task details" });
  await taskDetail.getByRole("group", { name: "Hand it to an agent" }).waitFor();
  await taskDetail.getByText("GPT-5.6-Sol", { exact: true }).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(1100, 700);
  await capture(page, "inertia-tasks.png");
  await sidebar.locator(".activity-thread-select").filter({ hasText: "Simplify sign-up" }).click();
  await page.getByRole("heading", { name: "Simplify sign-up", level: 1 }).waitFor();
  await sidebar.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByRole("dialog", { name: "Add project" }).waitFor();
  await capture(page, "inertia-add-project.png");
  await page.getByRole("button", { name: "Close add project" }).click();
  await page.getByRole("dialog", { name: "Add project" }).waitFor({ state: "hidden" });
  await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "More Git actions", exact: true }).waitFor();
  await page.mouse.move(1100, 350);
  await capture(page, "inertia-light.png");

  // Import only our own freshly captured demo images; never send a provider turn.
  await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths, bookmarks: [] });
  }, [join(screenshotDirectory, "inertia-light.png"), join(screenshotDirectory, "inertia-dark.png")]);
  await page.getByRole("button", { name: "Attach images, documents, or spreadsheets", exact: true }).click();
  await page.getByRole("button", { name: "Preview attachment inertia-light.png", exact: true }).click();
  const imageStage = page.getByRole("group", { name: "Zoomable preview of inertia-light.png", exact: true });
  await imageStage.locator("img").waitFor();
  await imageStage.getByRole("button", { name: "Zoom in", exact: true }).click();
  await imageStage.getByLabel("Zoom level").filter({ hasText: "150%" }).waitFor();
  await page.mouse.move(1100, 350);
  await capture(page, "inertia-image-preview.png");
  await page.keyboard.press("Escape");

} finally {
  await app?.close().catch(() => undefined);
  await rm(captureRoot, { recursive: true, force: true });
  if (ownsWorkspace) await rm(workspaceDirectory, { recursive: true, force: true });
  if (ownsCompanionWorkspace) {
    await rm(companionWorkspaceDirectory, { recursive: true, force: true });
  }
}
