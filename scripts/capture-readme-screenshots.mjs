import { _electron as electron } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

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

function seedShowcaseData() {
  const database = new Database(databasePath);
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const conversationId = randomUUID();
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
  const messages = [
    ["system", "Welcome to Inertia — your local coding workspace."],
    ["assistant", "Bring conversations, project files, changes, plans, and a real terminal into one calm workspace."],
    ["user", "Plan a focused pass to make the onboarding flow clearer."],
    ["assistant", "I’ll review the onboarding path, make the smallest clear update, and leave every change ready for review."],
  ];

  database.transaction(() => {
    database.prepare(`
      INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
      VALUES (?, 'Getting Started', ?, '#6f76d9', 'ready', ?, ?)
    `).run(projectId, workspaceDirectory, now, now);
    database.prepare(`
      INSERT INTO conversations (
        id, project_id, title, provider_id, model, reasoning_effort,
        interaction_mode, access_mode, status, created_at, updated_at
      ) VALUES (?, ?, 'Welcome to Inertia', 'codex', 'gpt-5.6-sol', 'high', 'build', 'supervised', 'completed', ?, ?)
    `).run(conversationId, projectId, now, now);
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
    const insertMessage = database.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, '[]', ?)");
    messages.forEach(([role, content], index) => insertMessage.run(randomUUID(), conversationId, role, content, new Date(Date.now() - (messages.length - index) * 1_000).toISOString()));
    database.prepare("INSERT INTO activities (id, conversation_id, run_id, kind, title, detail, status, created_at) VALUES (?, ?, ?, 'status', 'Turn completed', NULL, 'completed', ?)")
      .run(randomUUID(), conversationId, "readme-demo-run", now);
    database.prepare("INSERT INTO agent_reasonings (id, conversation_id, run_id, content, status, created_at) VALUES (?, ?, ?, ?, 'completed', ?)")
      .run(randomUUID(), conversationId, "readme-demo-run", "Kept the plan scoped to the onboarding experience and preserved the existing workspace flow.", now);
    database.prepare(`
      INSERT INTO thread_usage (
        conversation_id, used_tokens, total_processed_tokens, total_processed_scope, max_tokens,
        input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
        reasoning_output_tokens, compacts_automatically, updated_at
      ) VALUES (?, 12000, 28400, 'thread', 200000, 9400, 1800, 400, 2600, 700, 1, ?)
    `).run(conversationId, now);
    database.prepare(`
      INSERT INTO provider_metadata_cache (
        provider_id, executable, version, auth_state,
        models_json, models_updated_at, models_last_attempted_at, models_provenance, models_stale,
        rate_limits_json, rate_limits_updated_at, rate_limits_last_attempted_at, rate_limits_provenance, rate_limits_stale
      ) VALUES ('codex', '/demo/bin/codex', '0.142.5', 'authenticated', ?, ?, ?, 'provider', 0, ?, ?, ?, 'provider', 0)
    `).run(JSON.stringify(models), now, now, JSON.stringify(limits), now, now);
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

  seedShowcaseData();

  app = await launch();
  page = await app.firstWindow();
  await page.getByRole("heading", { name: "Welcome to Inertia", level: 1 }).waitFor();
  await sizeWindow();
  await page.getByRole("tab", { name: /Changes/u }).click();
  await page.getByText("GPT-5.6-Sol", { exact: true }).waitFor();
  await page.getByText("Context 94%", { exact: true }).waitFor();
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
