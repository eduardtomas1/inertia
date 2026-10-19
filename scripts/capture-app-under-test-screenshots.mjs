// Captures the App under test screenshots for the docs and the pull request.
// Linux: run under a display and a session bus, for example
// `xvfb-run -a dbus-run-session -- node scripts/capture-app-under-test-screenshots.mjs`
// (without a bus, Chromium fills the launched app's stderr with D-Bus errors).
// The App surface launches a copy of tests/fixtures/app-under-test through
// the real runtime; nothing is sent to a provider.
import { _electron as electron } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  readFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  throw new Error("Run this script under a display, for example with `xvfb-run -a`.");
}
const repositoryRoot = resolve(import.meta.dirname, "..");
const screenshotDirectory = join(repositoryRoot, "docs", "screenshots");
const fixtureDirectory = join(repositoryRoot, "tests", "fixtures", "app-under-test");
const runningAsRoot = process.getuid?.() === 0;
const captureRoot = await mkdtemp(join(tmpdir(), "inertia-app-under-test-capture-"));
// A short, neutral path, because the project path can appear in the window.
const workspaceDirectory = "/tmp/sketchpad";
const dataDirectory = join(captureRoot, "data");
const profileDirectory = join(captureRoot, "profile");
const databasePath = join(dataDirectory, "inertia.sqlite");
const providerBinDirectory = join(captureRoot, "provider-bin");
let ownsWorkspace = false;
let app;

async function run(command, args, cwd = repositoryRoot) {
  const { stdout } = await execFileAsync(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function ensureBuild() {
  if (existsSync(join(repositoryRoot, "out", "main", "index.js"))) return;
  console.log("Building the app bundle…");
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:bundle"]);
}

/**
 * The runtime resolves the project's own `node_modules/electron` and refuses
 * one whose realpath leaves the project, so the workspace gets a real package
 * folder. As root, Chromium refuses to start without --no-sandbox and the
 * runtime never adds it, so `dist/electron` is a small wrapper that starts
 * the repository's Electron with that switch (exec keeps the debugging pipe
 * on fds 3 and 4). Otherwise `dist` is copied (about 280 MB, in /tmp) and
 * Electron runs with its sandbox, which this script has not been run with.
 */
async function installWorkspaceElectron() {
  const source = dirname(require.resolve("electron/package.json"));
  const target = join(workspaceDirectory, "node_modules", "electron");
  await mkdir(join(target, "dist"), { recursive: true });
  for (const file of ["package.json", "path.txt", "index.js", "cli.js"]) {
    await copyFile(join(source, file), join(target, file));
  }
  const binary = await realpath(require("electron"));
  if (runningAsRoot) {
    const wrapper = join(target, "dist", "electron");
    // A headless container has no system bus or accessibility bus; keep
    // Chromium's and GLib's complaints about that out of the captured log.
    await writeFile(
      wrapper,
      `#!/bin/sh\nNO_AT_BRIDGE=1 exec ${JSON.stringify(binary)} --no-sandbox --log-level=3 "$@"\n`,
      "utf8",
    );
    await chmod(wrapper, 0o755);
  } else {
    await cp(join(source, "dist"), join(target, "dist"), { recursive: true, force: true });
  }
}

/**
 * The workspace is the fixture app. Its committed renderer deletes the draft
 * without asking; the fixture's own renderer, the chat's seeded change, asks.
 */
async function createWorkspace() {
  await mkdir(workspaceDirectory);
  ownsWorkspace = true;
  await cp(fixtureDirectory, workspaceDirectory, { recursive: true });
  await writeFile(join(workspaceDirectory, ".gitignore"), "node_modules/\n", "utf8");
  await installWorkspaceElectron();
  const renderer = join(workspaceDirectory, "renderer.js");
  const asking = await readFile(renderer, "utf8");
  const before = asking.replace(
    /confirm\("Delete the draft\?"\) \? "Draft deleted" : "Draft kept"/u,
    "\"Draft deleted\"",
  );
  if (before === asking) throw new Error("The fixture renderer no longer matches the capture's seeded change.");
  await writeFile(renderer, before, "utf8");
  await run("git", ["init", "-q", "-b", "main"], workspaceDirectory);
  await run("git", ["add", "."], workspaceDirectory);
  await run("git", [
    "-c", "user.name=Sketchpad Team", "-c", "user.email=team@sketchpad.example",
    "commit", "-qm", "Add the sketchpad window",
  ], workspaceDirectory);
  await writeFile(renderer, asking, "utf8");
  return await workingTreePatch(workspaceDirectory);
}

async function workingTreePatch(cwd) {
  const text = await run("git", ["diff", "--no-color", "--no-ext-diff"], cwd);
  const numstat = await run("git", ["diff", "--numstat"], cwd);
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

async function launch() {
  return electron.launch({
    args: [
      repositoryRoot,
      `--user-data-dir=${profileDirectory}`,
      ...(runningAsRoot ? ["--no-sandbox"] : []),
    ],
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

async function workspacePathReceipt(path) {
  const canonicalPath = await realpath(path);
  const info = await lstat(canonicalPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The capture workspace is not a direct directory.");
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

async function seedChat(patch) {
  const database = new Database(databasePath);
  const receipt = await workspacePathReceipt(workspaceDirectory);
  const projectId = randomUUID();
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const runId = "app-under-test-capture-run";
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const now = new Date().toISOString();
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
  const patchDigest = createHash("sha256").update(patch.text).digest("hex");
  const artifactDirectory = join(dataDirectory, "turn-git-artifacts");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(artifactDirectory, `${patchDigest}.gz`),
    gzipSync(Buffer.from(patch.text, "utf8"), { level: 9 }),
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
    ],
    defaultReasoningEffort: "high",
  }];
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
  database.transaction(() => {
    database.prepare(`
      INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
      VALUES (?, 'Sketchpad', ?, '#6f76d9', 'ready', ?, ?)
    `).run(projectId, workspaceDirectory, requestedAt, requestedAt);
    database.prepare(`
      INSERT INTO project_path_authorities (project_id, path, receipt_json)
      VALUES (?, ?, ?)
    `).run(projectId, workspaceDirectory, receipt);
    database.prepare(`
      INSERT INTO conversations (
        id, project_id, title, provider_id, model_selection_json,
        continuation_identity_json, model, reasoning_effort,
        interaction_mode, access_mode, status, branch, completed_at,
        last_viewed_at, created_at, updated_at
      ) VALUES (
        ?, ?, 'Check the draft buttons', 'codex', ?, NULL,
        'gpt-5.6-sol', 'high', 'build', 'supervised', 'completed', 'main', ?, ?, ?, ?
      )
    `).run(conversationId, projectId, JSON.stringify(modelSelection), completedAt, now, requestedAt, completedAt);
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
      turnId, conversationId, runId, userMessageId, assistantMessageId,
      JSON.stringify(modelSelection), JSON.stringify(continuationIdentity),
      requestedAt, startedAt, completedAt, requestedAt, completedAt,
    );
    const insertMessage = database.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, attachments_json, created_at, turn_id
      ) VALUES (?, ?, ?, ?, '[]', ?, ?)
    `);
    insertMessage.run(
      userMessageId, conversationId, "user",
      "Make Delete draft ask before it removes anything, then launch the app and check both buttons.",
      requestedAt, turnId,
    );
    insertMessage.run(
      assistantMessageId, conversationId, "assistant",
      "Delete draft now asks for confirmation first, and the draft stays when you cancel.\n\n- **Change text** updates the status line and logs `fixture button clicked`.\n- **Delete draft** shows the confirmation and deletes the draft only after you accept.\n\nI stopped the app when I was done. Launch it again from the App surface to try it yourself.",
      assistantAt, turnId,
    );
    database.prepare(`
      INSERT INTO activities (
        id, conversation_id, run_id, kind, title, detail, status, created_at,
        turn_id
      ) VALUES (?, ?, ?, 'status', 'Turn completed', NULL, 'completed', ?, ?)
    `).run(randomUUID(), conversationId, runId, completedAt, turnId);
    database.prepare(`
      INSERT INTO turn_git_artifacts (
        id, turn_id, conversation_id, run_id, repository_identity,
        worktree_identity, branch, before_checkpoint_id, before_ref, after_ref,
        before_fingerprint, after_fingerprint, files_json, insertions,
        deletions, status, completeness, patch_state, patch_digest,
        captured_at, terminal_assistant_message_id, failure_reason,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 'main', NULL, ?, ?, ?, ?, ?, ?, ?,
        'ready', 'complete', 'available', ?, ?, ?, NULL, ?, ?
      )
    `).run(
      randomUUID(), turnId, conversationId, runId,
      createHash("sha256").update("sketchpad-repository").digest("hex"),
      createHash("sha256").update("sketchpad-worktree").digest("hex"),
      createHash("sha256").update("sketchpad-before-ref").digest("hex"),
      createHash("sha256").update("sketchpad-after-ref").digest("hex"),
      createHash("sha256").update("sketchpad-before").digest("hex"),
      patchDigest,
      JSON.stringify(patch.files), patch.insertions, patch.deletions,
      patchDigest, completedAt, assistantMessageId, requestedAt, completedAt,
    );
    database.prepare(`
      INSERT INTO provider_metadata_scoped_cache (
        scope_key, provider_id, harness_id, backend_profile_id, model_id,
        executable, version, backend_configuration_revision, auth_state,
        models_json, models_updated_at, models_last_attempted_at, models_provenance, models_stale,
        rate_limits_json, rate_limits_updated_at, rate_limits_last_attempted_at, rate_limits_provenance, rate_limits_stale
      ) VALUES (
        ?, 'codex', 'codex-app-server', 'builtin:openai', 'provider-catalog',
        '/demo/bin/codex', '0.142.5', 0, 'authenticated',
        ?, ?, ?, 'provider', 0, '[]', ?, ?, 'provider', 0
      )
    `).run(JSON.stringify(Object.values(metadataScope)), JSON.stringify(models), now, now, now, now);
  })();
  database.close();
}

async function closeWorkspaceTools(page) {
  const toggle = page.locator("[data-panel-layout-controls] [data-right-panel-toggle]");
  if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
  await page.locator(".workspace-panel").waitFor({ state: "hidden" });
}

async function openAppSurface(page) {
  const toggle = page.locator("[data-panel-layout-controls] [data-right-panel-toggle]");
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const tools = page.locator(".workspace-panel");
  await tools.waitFor({ state: "visible" });
  const tab = tools.locator('[data-workspace-tab="app"]');
  if (await tab.isVisible()) {
    await tab.click();
  } else {
    const launcher = tools.getByRole("group", { name: "Open a surface" });
    if (await launcher.isVisible()) {
      await launcher.getByRole("button", { name: /^App/u }).click();
    } else {
      await tools.getByRole("button", { name: "Add panel surface" }).click();
      await page.getByRole("menu", { name: "Add panel surface" })
        .getByRole("menuitem", { name: /^App/u }).click();
    }
  }
  const surface = tools.getByRole("region", { name: "App", exact: true });
  await surface.waitFor();
  return surface;
}

async function widenWorkspaceTools(page) {
  const separator = page.getByRole("separator", { name: "Resize workspace tools" });
  for (let step = 0; step < 6; step += 1) await separator.press("Shift+ArrowLeft");
}

async function scrollSurfaceTo(surface, heading) {
  await surface.getByRole("heading", { name: heading, exact: true }).evaluate((element) => {
    const scroller = element.closest(".workspace-surface-scroll");
    if (!scroller) return;
    const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += offset - 8;
  });
}

async function setTheme(page, theme) {
  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: theme, exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("heading", { name: "Check the draft buttons", level: 1 }).waitFor();
}

try {
  await ensureBuild();
  await mkdir(screenshotDirectory, { recursive: true });
  await mkdir(providerBinDirectory);
  const patch = await createWorkspace();

  app = await launch();
  let page = await app.firstWindow();
  await page.getByRole("button", { name: "Add your first project" }).waitFor();
  await app.close();
  app = undefined;

  await seedChat(patch);

  app = await launch();
  page = await app.firstWindow();
  await page.getByRole("heading", { name: "Check the draft buttons", level: 1 }).waitFor();
  await sizeWindow();
  await page.locator('.app-shell[data-connection-status="online"]').waitFor();
  await closeWorkspaceTools(page);

  let surface = await openAppSurface(page);
  await widenWorkspaceTools(page);
  await surface.getByRole("button", { name: "Launch Electron app", exact: true }).click();
  const launches = surface.getByRole("list", { name: "App launches" });
  await launches.getByText("Running", { exact: true }).waitFor({ timeout: 30_000 });
  await surface.getByRole("list", { name: "App windows" })
    .getByText("App under test fixture", { exact: true }).waitFor({ timeout: 60_000 });
  await surface.getByRole("log").getByText("fixture ready", { exact: true }).waitFor({ timeout: 30_000 });
  await surface.getByRole("list", { name: "App windows" }).getByText("Loading", { exact: true })
    .waitFor({ state: "hidden", timeout: 30_000 });
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(400, 700);
  await capture(page, "inertia-app-under-test-dark.png");

  await setTheme(page, "Light");
  surface = await openAppSurface(page);
  await surface.getByRole("list", { name: "App windows" })
    .getByText("App under test fixture", { exact: true }).waitFor();
  await surface.getByRole("log").getByText("fixture ready", { exact: true }).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(400, 700);
  await capture(page, "inertia-app-under-test-light.png");
  await setTheme(page, "Dark");
  surface = await openAppSurface(page);

  // A launch the user started asks before it stops.
  await surface.getByRole("button", { name: /^Stop /u }).click();
  await surface.getByRole("group", { name: /^Confirm stopping / })
    .getByRole("button", { name: "Stop the app", exact: true }).click();
  await launches.getByText("Exited", { exact: true }).waitFor({ timeout: 30_000 });
  const timeline = surface.getByRole("list", { name: "App evidence timeline" });
  await timeline.getByText("Stopped", { exact: true }).waitFor();
  await scrollSurfaceTo(surface, "Launches");
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(400, 700);
  await capture(page, "inertia-app-under-test-evidence.png");

  await closeWorkspaceTools(page);
  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Search settings" }).fill("Agent app access");
  await page.getByRole("listbox", { name: "Matching settings" })
    .getByRole("option", { name: "Agent app access" }).click();
  const row = page.locator('[data-setting-id="project-app-under-test-access"]');
  await row.waitFor();
  await page.waitForTimeout(500);
  // Opening a setting scrolls it into view, which can also shift the
  // window's own layout; put every container outside Settings back.
  await page.evaluate(() => {
    for (let element = document.querySelector("main.settings-view")?.parentElement; element; element = element.parentElement) {
      element.scrollTop = 0;
    }
  });
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(400, 700);
  await capture(page, "inertia-app-under-test-settings.png");

  // The App control card reads its state from main's App control service.
  await page.getByRole("combobox", { name: "Search settings" }).fill("Native window access");
  await page.getByRole("listbox", { name: "Matching settings" })
    .getByRole("option", { name: "Native window access" }).click();
  const card = page.getByRole("region", { name: "App control", exact: true });
  await card.waitFor();
  await card.getByText(/AT-SPI is available|did not answer|macOS|Windows blocks/u).first().waitFor({ timeout: 15_000 });
  await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(400, 700);
  await capture(page, "inertia-app-control-settings.png");
} finally {
  await app?.close().catch(() => undefined);
  await rm(captureRoot, { recursive: true, force: true });
  if (ownsWorkspace) await rm(workspaceDirectory, { recursive: true, force: true });
}
