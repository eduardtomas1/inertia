import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  MAC_BRAND_MIN_CLEAR_GAP,
  MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH,
  MAC_TRAFFIC_LIGHT_POSITION,
} from "../../src/shared/window-chrome";

const execFileAsync = promisify(execFile);

let electronApp: ElectronApplication;
let page: Page;
let testDirectory: string;
let workspaceDirectory: string;
const rendererErrors: string[] = [];
let previewServer: Server;
let previewUrl: string;

interface RuntimeTestSnapshot {
  phase: string;
  generation: number;
  pid: number | null;
  websocketUrl: string | null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runtimeSnapshot(): Promise<RuntimeTestSnapshot> {
  const snapshot = await electronApp.evaluate((_electron) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as { snapshot: () => RuntimeTestSnapshot } | undefined;
    return runtime?.snapshot() ?? null;
  });
  if (!snapshot) throw new Error("The test runtime supervisor is unavailable");
  return snapshot;
}

async function resizeWindow(width: number, height: number): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await page.waitForTimeout(250);
}

async function expectNoViewportOverflow(): Promise<void> {
  const measurements = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
  }));

  expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.innerWidth + 1);
  expect(measurements.bodyWidth).toBeLessThanOrEqual(measurements.innerWidth + 1);
  expect(measurements.documentHeight).toBeLessThanOrEqual(measurements.innerHeight + 1);
  expect(measurements.bodyHeight).toBeLessThanOrEqual(measurements.innerHeight + 1);
}

test.beforeAll(async () => {
  previewServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
    response.end("<!doctype html><title>Inertia preview</title><style>body{font-family:sans-serif;padding:40px}</style><h1>Preview is ready</h1>");
  });
  await new Promise<void>((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
  const address = previewServer.address();
  if (!address || typeof address === "string") throw new Error("Preview test server did not start");
  previewUrl = `http://127.0.0.1:${address.port}/`;
  testDirectory = await mkdtemp(join(tmpdir(), "inertia-e2e-"));
  workspaceDirectory = join(testDirectory, "Inertia");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(join(workspaceDirectory, "sample.ts"), "export const version = '0.0.1';\n", "utf8");
  await execFileAsync("git", ["init", "-q"], { cwd: workspaceDirectory });
  await execFileAsync("git", ["add", "sample.ts"], { cwd: workspaceDirectory });
  await execFileAsync("git", ["-c", "user.name=Inertia", "-c", "user.email=test@inertia.local", "commit", "-qm", "fixture"], { cwd: workspaceDirectory });
  await writeFile(join(workspaceDirectory, "sample.ts"), "export const version = '0.0.1';\nexport const ready = true;\n", "utf8");
  electronApp = await electron.launch({
    args: [".", `--user-data-dir=${join(testDirectory, "electron-profile")}`],
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: join(testDirectory, "data"),
      INERTIA_WORKSPACE_DIR: workspaceDirectory,
    },
  });
  page = await electronApp.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await page.getByRole("button", { name: "Add your first project" }).waitFor();
});

test.afterAll(async () => {
  await page?.evaluate(() => window.inertia.previewClose()).catch(() => undefined);
  previewServer?.closeAllConnections();
  await new Promise<void>((resolve) => previewServer?.close(() => resolve()));
  const runtimePid = (await runtimeSnapshot().catch(() => null))?.pid ?? null;
  await electronApp?.close();
  if (runtimePid) await expect.poll(() => processExists(runtimePid), { timeout: 5_000 }).toBe(false);
  if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
});

test("starts without a demo and adds the first real project", async () => {
  await resizeWindow(1440, 920);
  await expect(page.getByText("Local service ready", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Local", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Bring a project into focus." })).toBeVisible();
  await expect(page.getByText("Getting Started", { exact: true })).toHaveCount(0);
  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await expect(sidebar.getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Work", exact: true }).click();
  await expect(sidebar.getByText("No projects yet", { exact: true })).toHaveCount(1);
  await expect(sidebar.getByText("No work yet", { exact: true })).toHaveCount(0);
  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Projects", exact: true }).click();

  await electronApp.evaluate(({ dialog }, directory) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [directory],
      bookmarks: [],
    }));
  }, workspaceDirectory);
  await page.getByRole("button", { name: "Add your first project" }).click();
  await expect(page.getByRole("heading", { name: "Start with a clear chat." })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "New chat", exact: true })).toHaveCount(1);
  await page.locator(".project-welcome").getByRole("button", { name: "New chat", exact: true }).click();

  await expect(page.getByLabel("Terminal panel").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

test("keeps the window alive and reconnects with a rotated capability after a runtime crash", async () => {
  const before = await runtimeSnapshot();
  const beforeUrl = await page.evaluate(() => window.inertia.getRuntimeConnection().then(({ websocketUrl }) => websocketUrl));
  const terminal = page.locator("aside.terminal-panel").first();
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  const beforeTerminalId = await terminal.getAttribute("data-terminal-id");
  const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
  const conversation = database.prepare("SELECT id FROM conversations ORDER BY created_at LIMIT 1").get() as { id: string };
  database.prepare("UPDATE conversations SET status = 'running' WHERE id = ?").run(conversation.id);
  database.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, 'assistant', ?, '[]', ?)")
    .run(
      randomUUID(),
      conversation.id,
      "# Timeline response\n\n```ts file=src/timeline.ts\nconst ready: boolean = true;\n```\n\n| Check | State |\n| --- | --- |\n| Renderer | ready |\n\n<script>window.__unsafeMarkdown = true</script>",
      new Date(Date.now() - 1_000).toISOString(),
    );
  database.prepare("INSERT INTO activities (id, conversation_id, run_id, kind, title, detail, status, created_at) VALUES (?, ?, ?, 'command', 'Interrupted E2E command', NULL, 'running', ?)")
    .run(randomUUID(), conversation.id, "e2e-interrupted-run", new Date().toISOString());
  database.close();
  await page.evaluate(() => { Reflect.set(window, "__inertiaNoReloadMarker", crypto.randomUUID()); });
  const marker = await page.evaluate(() => Reflect.get(window, "__inertiaNoReloadMarker") as string);

  const crashed = await electronApp.evaluate((_electron) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as { crash: () => RuntimeTestSnapshot } | undefined;
    if (!runtime) throw new Error("The test runtime supervisor is unavailable");
    return runtime.crash();
  });
  expect(crashed.pid).toBe(before.pid);

  await expect.poll(async () => {
    const current = await runtimeSnapshot();
    return current.phase === "ready" && current.generation > before.generation;
  }, { timeout: 10_000 }).toBe(true);
  const after = await runtimeSnapshot();
  const afterUrl = await page.evaluate(() => window.inertia.getRuntimeConnection().then(({ websocketUrl }) => websocketUrl));
  expect(after.generation).toBeGreaterThan(before.generation);
  expect(after.pid).not.toBe(before.pid);
  expect(afterUrl).not.toBe(beforeUrl);
  expect(await page.evaluate(() => Reflect.get(window, "__inertiaNoReloadMarker"))).toBe(marker);
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "New chat" }).first()).toBeEnabled();
  await expect(page.getByText("The previous run ended when Inertia closed. Send another message to continue.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Timeline response", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Markdown" })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__unsafeMarkdown"))).toBeUndefined();
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  expect(await terminal.getAttribute("data-terminal-id")).not.toBe(beforeTerminalId);
  await expect(page.getByRole("alert")).toHaveCount(0);
  if (before.pid) await expect.poll(() => processExists(before.pid as number), { timeout: 5_000 }).toBe(false);
});

test("navigates settings, changes theme, and returns to chat", async () => {
  const terminalPanel = page.locator("aside.terminal-panel").first();
  const terminalFontSize = await terminalPanel.getAttribute("data-terminal-font-size");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(async () => {
    try {
      return JSON.parse(await readFile(join(testDirectory, "electron-profile", "window-appearance.json"), "utf8"));
    } catch {
      return null;
    }
  }).toEqual({ theme: "dark" });
  const nativeAppearance = await electronApp.evaluate(({ BrowserWindow, nativeTheme }) => ({
    background: BrowserWindow.getAllWindows()[0]?.getBackgroundColor() ?? "",
    themeSource: nativeTheme.themeSource,
  }));
  expect(nativeAppearance.themeSource).toBe("dark");
  expect(nativeAppearance.background).toMatch(/^#101013(?:ff)?$/iu);
  await page.getByRole("radiogroup", { name: "Interface scale" }).getByRole("radio", { name: "Comfortable" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-interface-scale", "comfortable");
  await page.getByRole("radiogroup", { name: "Response density" }).getByRole("radio", { name: "Comfortable" }).click();
  await page.getByRole("switch", { name: "Wrap code by default" }).click();
  await expect(page.getByRole("switch", { name: "Wrap code by default" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent accounts" })).toBeVisible();
  await page.getByRole("button", { name: "Keybindings", exact: true }).click();
  await expect(page.getByText("Toggle project navigation", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Go to workspace" }).click();
  await expect(page.locator("aside.terminal-panel").first()).toHaveAttribute("data-terminal-font-size", terminalFontSize ?? "13");
  await expect(page.locator(".chat-workspace")).toHaveClass(/response-density-comfortable/u);
  await expect(page.locator(".response-code-block pre").first()).toHaveClass(/wraps/u);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this V1 clear and calm.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByLabel("Thread transcript").getByText("Keep this V1 clear and calm.", { exact: true }),
  ).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("changes the visible theme on every quick-toggle click", async () => {
  const html = page.locator("html");
  const themeTrigger = page.getByRole("button", { name: /^Change theme \(current:/ });

  for (let click = 0; click < 3; click += 1) {
    const before = await html.getAttribute("data-theme");
    await themeTrigger.click();
    await expect.poll(() => html.getAttribute("data-theme")).not.toBe(before);
  }

  expect(rendererErrors).toEqual([]);
});

test("reveals the fixed local runtime diagnostics directory from settings", async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Archive & data", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local data" })).toBeVisible();
  await expect(page.getByText("Local-only lifecycle and failure metadata.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Reveal log folder" }).click();
  await expect(page.getByRole("status")).toHaveText("Runtime log folder opened.");

  const logDirectory = join(testDirectory, "electron-profile", "logs", "runtime");
  await expect.poll(async () => (await stat(logDirectory)).isDirectory()).toBe(true);
  if (process.platform !== "win32") {
    expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
  }
  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(rendererErrors).toEqual([]);
});

test("persists composer usage modes without losing the followed transcript", async () => {
  await resizeWindow(1440, 920);
  const transcript = page.getByLabel("Thread transcript");
  const compact = page.getByRole("region", { name: "Usage and context" });
  await expect(compact).toHaveAttribute("data-mode", "compact");
  const expand = compact.getByRole("button", { name: "Expand usage and context" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("compact");
  await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });

  await expand.focus();
  await expand.press("Space");
  const expanded = page.getByRole("region", { name: "Usage and context" });
  await expect(expanded).toHaveAttribute("data-mode", "expanded");
  await expect(expanded.getByText("Context remaining", { exact: true })).toBeVisible();
  await expect(expanded.getByText("Provider quota", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("expanded");

  const collapse = expanded.getByRole("button", { name: "Collapse usage and context" });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.focus();
  await collapse.press("Enter");

  const collapsed = page.getByRole("region", { name: "Usage and context" });
  await expect(collapsed).toHaveAttribute("data-mode", "compact");
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("compact");
  await expect.poll(() => transcript.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(2);

  await collapsed.getByRole("button", { name: "Expand usage and context" }).click();
  await expect(page.getByRole("region", { name: "Usage and context" })).toHaveAttribute("data-mode", "expanded");
  await page.getByRole("region", { name: "Usage and context" }).getByRole("button", { name: "Hide usage and context" }).click();
  await expect(page.getByRole("region", { name: "Usage and context" })).toHaveCount(0);
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("hidden");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const usageModes = page.getByRole("radiogroup", { name: "Usage and context display" });
  await expect(usageModes.getByRole("radio", { name: "Hidden" })).toHaveAttribute("aria-checked", "true");
  await usageModes.getByRole("radio", { name: "Expanded" }).click();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  const autoCollapsed = page.getByRole("region", { name: "Usage and context" });
  await expect(autoCollapsed).toHaveAttribute("data-mode", "compact");
  await expect(autoCollapsed).toHaveAttribute("data-auto-collapsed", "true");
  await expect(autoCollapsed).toHaveAttribute("data-collapse-reason", /^(?:space|unavailable)$/u);
  await autoCollapsed.getByRole("button", { name: "Expand usage and context" }).click();
  await expect(page.getByRole("region", { name: "Usage and context" })).toHaveAttribute("data-mode", "expanded");
  expect(rendererErrors).toEqual([]);
});

test("applies every interface scale live and remains usable at common Linux display scales", async () => {
  await resizeWindow(1440, 920);
  const terminalFontSize = await page.locator("aside.terminal-panel").first().getAttribute("data-terminal-font-size");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const scaleGroup = page.getByRole("radiogroup", { name: "Interface scale" });
  const expected = [
    ["Compact", "compact", "12.5px", "30px"],
    ["Default", "default", "13.5px", "32px"],
    ["Comfortable", "comfortable", "14.5px", "35px"],
    ["Large", "large", "16px", "38px"],
  ] as const;

  for (const [label, value, fontSize, controlHeight] of expected) {
    await scaleGroup.getByRole("radio", { name: label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-interface-scale", value);
    const measurements = await page.locator(".app-shell").evaluate((shell) => ({
      fontSize: getComputedStyle(shell).fontSize,
      controlHeight: getComputedStyle(document.documentElement).getPropertyValue("--ui-control-height").trim(),
    }));
    expect(measurements).toEqual({ fontSize, controlHeight });
  }

  for (const zoomFactor of [1, 1.25, 1.5]) {
    await electronApp.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor);
    }, zoomFactor);
    await resizeWindow(1920, 1080);
    await expectNoViewportOverflow();
  }

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
  await resizeWindow(900, 720);
  await expectNoViewportOverflow();
  await expect(page.getByRole("button", { name: "Go to workspace" })).toBeVisible();
  await scaleGroup.getByRole("radio", { name: "Comfortable", exact: true }).click();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  await expect(page.locator("aside.terminal-panel").first()).toHaveAttribute("data-terminal-font-size", terminalFontSize ?? "13");
  await expectNoViewportOverflow();
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

test("switches between Projects and Work and manages chat history", async () => {
  await resizeWindow(1440, 920);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();

  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await sidebar.getByRole("button", { name: "Project actions for Inertia" }).first().click();
  const projectMenu = sidebar.getByRole("menu", { name: "Project actions for Inertia" });
  await expect(projectMenu.getByRole("menuitem", { name: "Open folder" })).toBeVisible();
  await expect(projectMenu.getByRole("menuitem", { name: "New chat" })).toHaveCount(0);
  await expect(projectMenu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(projectMenu.getByText("Grouping behavior", { exact: true })).toBeVisible();
  await projectMenu.getByRole("menuitemradio", { name: "Keep separate", exact: true }).click();

  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Work", exact: true }).click();
  await expect(sidebar).toHaveClass(/sidebar-mode-activity/u);
  await expect(sidebar.getByRole("heading", { name: "Recent" })).toBeVisible();
  const activityCard = sidebar.locator(".activity-thread.is-card.is-active");
  const threadCard = activityCard.getByRole("button", { name: "New chat, Idle" });
  await expect(threadCard).toBeVisible();
  const relativeTime = activityCard.locator(".activity-thread-topline time");
  await expect(relativeTime).toHaveCSS("opacity", "1");
  await activityCard.hover();
  await expect(relativeTime).toHaveCSS("opacity", "1");

  const firstNavigationItem = sidebar.locator("[data-sidebar-nav]").first();
  await firstNavigationItem.focus();
  await firstNavigationItem.press("ArrowDown");
  expect(await firstNavigationItem.evaluate((item) => document.activeElement !== item)).toBe(true);

  await activityCard.getByRole("button", { name: "Thread actions for New chat" }).click();
  await sidebar.getByRole("menuitem", { name: "Done" }).click();
  await expect(sidebar.getByText("History", { exact: true })).toBeVisible();
  const historyCard = sidebar.locator(".activity-thread.is-history.is-active");
  await expect(historyCard.getByRole("button", { name: "New chat, Idle" })).toBeVisible();
  await historyCard.getByRole("button", { name: "Thread actions for New chat" }).click();
  await sidebar.getByRole("menuitem", { name: "Reopen" }).click();
  await expect(sidebar.locator(".activity-thread.is-card").getByRole("button", { name: "New chat, Idle" })).toBeVisible();

  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Projects", exact: true }).click();
  await expect(sidebar).toHaveClass(/sidebar-mode-classic/u);
  expect(rendererErrors).toEqual([]);
});

test("dismisses and switches Composer menus without forcing a selection", async () => {
  await resizeWindow(1440, 920);
  const workspaceHeader = page.locator(".workspace-header");
  const closeTools = workspaceHeader.getByRole("button", { name: "Close workspace tools" });
  if (await closeTools.isVisible()) await closeTools.click();
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("@sam");
  await expect(page.getByRole("listbox", { name: "Project files" }).getByRole("option").first()).toHaveAttribute("aria-selected", "false");
  await composer.fill("/p");
  await expect(page.getByRole("listbox", { name: "Composer commands" }).getByRole("option", { name: /plan/i })).toHaveAttribute("aria-selected", "false");
  await composer.fill("");

  const providerTrigger = page.getByRole("button", { name: "Choose provider and model" });
  const providerMenu = page.getByRole("menu", { name: "Provider and model" });

  await providerTrigger.click();
  await expect(providerTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(providerTrigger).toHaveAttribute("aria-controls", "composer-provider-menu");
  await expect(providerMenu).toBeVisible();
  await expect(providerMenu.getByRole("menuitemradio").filter({ hasText: /^Claude/u })).toBeEnabled();

  await providerMenu.getByText("Provider", { exact: true }).click();
  await expect(providerMenu).toBeVisible();

  await page.locator(".workspace-header").click({ position: { x: 12, y: 12 } });
  await expect(providerMenu).toBeHidden();
  await expect(providerTrigger).toHaveAttribute("aria-expanded", "false");

  await providerTrigger.click();
  await page.keyboard.press("Escape");
  await expect(providerMenu).toBeHidden();
  await expect(providerTrigger).toBeFocused();

  await providerTrigger.click();
  const modeTrigger = page.getByRole("button", { name: "Choose work mode" });
  const modeMenu = page.getByRole("menu", { name: "Work mode" });
  await modeTrigger.click();
  await expect(providerMenu).toBeHidden();
  await expect(modeMenu).toBeVisible();

  const currentMode = await modeTrigger.locator("span").first().textContent();
  const nextMode = currentMode === "Build" ? "Plan" : "Build";
  await modeMenu.getByRole("menuitemradio", { name: new RegExp(`^${nextMode}`) }).click();
  await expect(modeMenu).toBeHidden();
  await expect(modeTrigger).toBeFocused();
  await expect(modeTrigger.locator("span").first()).toHaveText(nextMode);

  const messageId = randomUUID();
  const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
  const state = database.prepare("SELECT active_conversation_id FROM app_state WHERE id = 1").get() as { active_conversation_id: string };
  database.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, 'user', ?, '[]', ?)")
    .run(messageId, state.active_conversation_id, "Keep this chat with its original agent.", new Date().toISOString());
  database.close();
  try {
    await page.reload();
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    await providerTrigger.click();
    await expect(providerMenu.getByText("This chat keeps its original agent. Start a new chat to use another.")).toBeVisible();
    await expect(providerMenu.getByRole("menuitemradio").filter({ hasText: /^Claude/u })).toBeDisabled();
  } finally {
    const cleanupDatabase = new Database(join(testDirectory, "data", "inertia.sqlite"));
    cleanupDatabase.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    cleanupDatabase.close();
    await page.reload();
    await page.getByRole("textbox", { name: "Message" }).waitFor();
  }
  await workspaceHeader.getByRole("button", { name: "Open workspace tools" }).click();
  expect(rendererErrors).toEqual([]);
});

test("collapses composer settings without displacing send and right-aligns user turns", async () => {
  await resizeWindow(1180, 600);
  const composer = page.locator(".composer");
  const more = page.getByRole("button", { name: "More composer options" });
  const send = page.getByRole("button", { name: "Send message" });
  await expect(more).toBeVisible();
  await expect(send).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose provider and model" })).toBeHidden();

  const bounds = await composer.boundingBox();
  const sendBounds = await send.boundingBox();
  expect(bounds).not.toBeNull();
  expect(sendBounds).not.toBeNull();
  expect((sendBounds?.x ?? 0) + (sendBounds?.width ?? 0)).toBeLessThanOrEqual((bounds?.x ?? 0) + (bounds?.width ?? 0));

  await more.click();
  const compactOptions = page.getByRole("menu", { name: "More composer options" });
  const providerItem = compactOptions.getByRole("menuitem", { name: /^Provider\b/ });
  await expect(providerItem).toBeVisible();
  const modelItem = compactOptions.getByRole("menuitem", { name: /^Model\b/ });
  await expect(modelItem).toBeVisible();
  await expect(compactOptions.getByRole("menuitem", { name: /^Mode\b/ })).toBeVisible();
  await expect(compactOptions.getByRole("menuitem", { name: /^Access\b/ })).toBeVisible();
  await providerItem.hover();
  const providerOptions = page.getByRole("menu", { name: "Provider options" });
  await expect(providerOptions).toBeVisible();
  await expect(providerOptions.getByRole("menuitemradio").first()).toBeVisible();
  await providerItem.click();
  await expect(providerOptions).toBeVisible();
  await page.mouse.move(20, 20);
  await expect(providerOptions).toBeHidden();
  await expect(compactOptions).toBeVisible();
  await page.keyboard.press("Escape");

  const userAlignmentGap = await page.evaluate(() => {
    const timeline = document.querySelector(".response-timeline");
    if (!timeline) throw new Error("Response timeline is unavailable");
    const turn = document.createElement("section");
    turn.className = "response-turn";
    const message = document.createElement("article");
    message.className = "message is-user";
    message.innerHTML = '<div class="message-meta"><span>You</span></div><div class="message-body">Alignment probe</div>';
    turn.append(message);
    timeline.append(turn);
    const turnBounds = turn.getBoundingClientRect();
    const messageBounds = message.getBoundingClientRect();
    turn.remove();
    return Math.abs(turnBounds.right - messageBounds.right);
  });
  expect(userAlignmentGap).toBeLessThanOrEqual(1);
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

test("contains commit dialog focus and restores its trigger", async () => {
  await resizeWindow(1440, 920);
  const trigger = page.getByRole("button", { name: "Commit & push", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  const message = dialog.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeFocused();

  const close = dialog.getByRole("button", { name: "Close commit dialog" });
  await close.focus();
  await close.press("Shift+Tab");
  await expect(message).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(rendererErrors).toEqual([]);
});

test("keeps the macOS brand in the native titlebar row and navigates it home", async ({}, testInfo) => {
  await resizeWindow(1440, 920);
  const shell = page.locator(".app-shell");
  const brand = page.getByRole("button", { name: "Go to workspace" });
  await expect(shell).toHaveClass(new RegExp(`platform-${process.platform}`));

  if (process.platform === "darwin") {
    const geometry = await page.evaluate(() => {
      const row = document.querySelector(".sidebar-brand")?.getBoundingClientRect();
      const lockup = document.querySelector(".brand-lockup");
      const logo = document.querySelector(".brand-logo");
      const markStyles = lockup ? getComputedStyle(lockup, "::before") : null;
      const lockupStyles = lockup ? getComputedStyle(lockup) : null;
      const logoStyles = logo ? getComputedStyle(logo) : null;
      const lockupBounds = lockup?.getBoundingClientRect();
      return row && lockupBounds && markStyles && lockupStyles && logoStyles ? {
        row: { top: row.top, height: row.height },
        markLeft: lockupBounds.left + Number.parseFloat(lockupStyles.paddingLeft),
        mark: { width: markStyles.width, height: markStyles.height, maskImage: markStyles.maskImage },
        logoDisplay: logoStyles.display,
      } : null;
    });
    expect(geometry).not.toBeNull();
    expect(geometry?.row.top).toBeCloseTo(12, 0);
    expect(geometry?.row.height).toBeLessThanOrEqual(30);
    expect(geometry?.mark.width).toBe("24px");
    expect(geometry?.mark.height).toBe("24px");
    expect(geometry?.mark.maskImage).toContain("inertia-logo.png");
    expect(geometry?.logoDisplay).toBe("none");
    const trafficLightClusterRight = MAC_TRAFFIC_LIGHT_POSITION.x + MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH;
    expect((geometry?.markLeft ?? 0) - trafficLightClusterRight).toBeGreaterThanOrEqual(MAC_BRAND_MIN_CLEAR_GAP);
    await page.screenshot({ path: testInfo.outputPath("v004-brand-wide.png") });

    try {
      await resizeWindow(760, 640);
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toBeVisible();
      await expect.poll(async () => {
        const compactMarkLeft = await page.locator(".brand-lockup").evaluate((lockup) => {
          const bounds = lockup.getBoundingClientRect();
          return bounds.left + Number.parseFloat(getComputedStyle(lockup).paddingLeft);
        });
        return compactMarkLeft - trafficLightClusterRight;
      }).toBeGreaterThanOrEqual(MAC_BRAND_MIN_CLEAR_GAP);
      await page.screenshot({ path: testInfo.outputPath("v004-brand-compact.png") });
    } finally {
      const closeNavigation = page.getByRole("button", { name: "Close navigation" }).last();
      if (await closeNavigation.isVisible().catch(() => false)) await closeNavigation.click();
      await resizeWindow(1440, 920);
    }
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await brand.click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("opens the command palette and manages a thread", async () => {
  await resizeWindow(1440, 920);
  const initialThreadCount = await page.locator(".conversation-item").count();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByRole("dialog", { name: "Search Inertia" })).toBeVisible();
  await page.getByRole("dialog", { name: "Search Inertia" })
    .getByRole("option")
    .filter({ hasText: "Start work in the current project" })
    .click();
  await expect(page.locator(".conversation-item")).toHaveCount(initialThreadCount + 1);
  await expect(page.locator(".conversation-row.is-active")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();

  await page.locator(".conversation-item").filter({ has: page.locator(".conversation-row.is-active") })
    .getByRole("button", { name: "Thread actions for New chat" })
    .click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("textbox", { name: "Rename New chat" });
  await rename.fill("Focused V1 pass");
  await rename.press("Enter");
  await expect(page.getByRole("heading", { name: "Focused V1 pass", level: 1 })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Thread actions for Focused V1 pass" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "Focused V1 pass", level: 1 })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thread actions for Focused V1 pass" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

  const terminalInput = page.locator(".xterm-helper-textarea").first();
  await terminalInput.focus();
  await page.keyboard.press("Control+K");
  const search = page.getByRole("combobox", { name: "Search commands, projects, and threads" });
  await search.fill("settings");
  await expect(page.getByRole("option", { name: /Open settings/ })).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(rendererErrors).toEqual([]);
});

test("switches workspace tools, opens multiple terminals, and loads a safe native preview", async () => {
  await resizeWindow(1440, 920);
  await page.getByRole("tab", { name: /Changes/ }).click();
  await expect(page.getByLabel("Workspace changes")).toBeVisible();
  await page.getByRole("tab", { name: /Files/ }).click();
  await expect(page.getByRole("region", { name: "Project files" })).toBeVisible();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal" }).click();
  const secondTerminalTab = page.getByRole("tab", { name: "Terminal 2", exact: true });
  await expect(secondTerminalTab).toBeVisible();
  await expect(secondTerminalTab).toHaveAttribute("aria-selected", "true");
  await expect(secondTerminalTab).toHaveJSProperty("tagName", "BUTTON");
  await page.getByRole("button", { name: "Close Terminal 2" }).click();
  await expect(secondTerminalTab).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Terminal 1", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "New terminal" }).click();
  await page.getByRole("button", { name: "Split terminals" }).click();
  await expect(page.locator(".terminal-session-grid")).toHaveClass(/is-split/);
  const liveTerminals = page.locator(".terminal-panel[data-terminal-id]");
  await expect(liveTerminals).toHaveCount(2);
  const terminalIdsBefore = (await liveTerminals.evaluateAll((terminals) => terminals.map((terminal) => terminal.getAttribute("data-terminal-id")).sort())).filter(Boolean);

  await page.getByRole("tab", { name: /Changes/ }).click();
  await page.getByRole("tab", { name: /Files/ }).click();
  await page.getByRole("tab", { name: /Preview/ }).click();
  const address = page.getByRole("textbox", { name: "Preview address" });
  await address.fill(previewUrl);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => electronApp.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL() === url), previewUrl)).toBe(true);
  await page.getByRole("tab", { name: /Plan/ }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Terminal 2/ })).toBeVisible();
  await page.locator(".workspace-panel").getByRole("button", { name: "Close workspace tools" }).click();
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(page.getByRole("tab", { name: /Terminal 2/ })).toBeVisible();
  await expect(liveTerminals).toHaveCount(2);
  const terminalIdsAfter = (await liveTerminals.evaluateAll((terminals) => terminals.map((terminal) => terminal.getAttribute("data-terminal-id")).sort())).filter(Boolean);
  expect(terminalIdsAfter).toEqual(terminalIdsBefore);
  expect(rendererErrors).toEqual([]);
});

test("keeps the Changes panel readable when the side tool area is narrow", async () => {
  await resizeWindow(1180, 800);
  await page.getByRole("tab", { name: /Changes/ }).click();
  const picker = page.getByRole("combobox", { name: "Changed file" });
  await expect(picker).toBeVisible();
  await expect(picker.locator("option:checked")).toHaveText("M · sample.ts");
  await expect(page.getByLabel("Changed files")).toBeHidden();
  await expect(page.getByLabel(/Diff for|Unified diff/)).toBeVisible();
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

test("adds a selected diff range to the next agent prompt", async () => {
  await resizeWindow(1440, 920);
  await page.getByRole("tab", { name: /Changes/ }).click();
  const addedLine = page.locator(".diff-line.is-addition").filter({ hasText: "export const ready = true;" }).first();
  await expect(addedLine).toBeVisible();
  await addedLine.click();
  await expect(page.getByRole("button", { name: "Add to prompt" })).toBeVisible();
  await page.getByRole("button", { name: "Add to prompt" }).click();
  await expect(page.getByLabel("Selected diff context", { exact: true })).toContainText("Diff selection in sample.ts");
  await page.getByRole("button", { name: "Remove selected diff context" }).click();
  await expect(page.getByLabel("Selected diff context", { exact: true })).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
});

test("opens and dismisses the prioritized Runs surface accessibly", async () => {
  const trigger = page.getByRole("button", { name: /^Open runs/u });
  await trigger.focus();
  await trigger.click();
  const center = page.getByRole("dialog", { name: "Runs" });
  await expect(center).toBeVisible();
  await expect(center).toBeFocused();
  await expect(center.getByRole("heading", { name: "Runs" })).toBeVisible();

  const runRows = center.locator(".activity-run");
  if (await runRows.count()) {
    const timestamp = runRows.first().locator("time");
    await expect(timestamp).toHaveCSS("opacity", "1");
    await runRows.first().hover();
    await expect(timestamp).toHaveCSS("opacity", "1");
  } else {
    await expect(center.getByRole("status")).toContainText("All clear");
  }

  const runsControls = center.locator("button:not([disabled])");
  const firstRunsControl = runsControls.first();
  const lastRunsControl = runsControls.last();
  await lastRunsControl.focus();
  await page.keyboard.press("Tab");
  await expect(firstRunsControl).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(lastRunsControl).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(center).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Runs" })).toBeVisible();
  await page.locator(".activity-center-backdrop").click({ position: { x: 3, y: 3 } });
  await expect(page.getByRole("dialog", { name: "Runs" })).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
});

test("resizes and persists the internal workspace panes", async () => {
  await resizeWindow(1440, 920);
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();

  const sidebarHandle = page.getByRole("separator", { name: "Resize project navigation" });
  const sidebarBefore = Number(await sidebarHandle.getAttribute("aria-valuenow"));
  await sidebarHandle.focus();
  await sidebarHandle.press("ArrowRight");
  await expect.poll(async () => Number(await sidebarHandle.getAttribute("aria-valuenow"))).toBeGreaterThan(sidebarBefore);

  const toolsHandle = page.getByRole("separator", { name: "Resize workspace tools" });
  const toolsBefore = Number(await toolsHandle.getAttribute("aria-valuenow"));
  await toolsHandle.focus();
  await toolsHandle.press("ArrowRight");
  await expect.poll(async () => Number(await toolsHandle.getAttribute("aria-valuenow"))).toBeLessThan(toolsBefore);

  const splitButton = page.getByRole("button", { name: "Split terminals" });
  if (await splitButton.getAttribute("aria-pressed") !== "true") await splitButton.click();
  const terminalHandle = page.getByRole("separator", { name: "Resize split terminals" });
  const terminalBefore = Number(await terminalHandle.getAttribute("aria-valuenow"));
  await terminalHandle.focus();
  await terminalHandle.press("ArrowLeft");
  await expect.poll(async () => Number(await terminalHandle.getAttribute("aria-valuenow"))).toBeLessThan(terminalBefore);

  const persisted = await page.evaluate(() => ({
    sidebar: window.localStorage.getItem("inertia:layout:sidebar-width:v1"),
    tools: window.localStorage.getItem("inertia:layout:workspace-tools-width:v1"),
    terminal: window.localStorage.getItem("inertia:layout:terminal-split-percent:v1"),
  }));
  expect(Number(persisted.sidebar)).toBeGreaterThan(sidebarBefore);
  expect(Number(persisted.tools)).toBeLessThan(toolsBefore);
  expect(Number(persisted.terminal)).toBeLessThan(terminalBefore);
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

test("collapses and restores both workspace sides without losing layout", async () => {
  await resizeWindow(1440, 920);
  const navigationToggle = page.getByRole("button", { name: "Toggle project navigation" });
  await navigationToggle.click();
  await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("inertia:layout:sidebar-collapsed:v1"))).toBe("true");
  await navigationToggle.click();
  await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toBeVisible();

  const toolsToggle = page.getByRole("button", { name: "Close workspace tools" }).first();
  await toolsToggle.click();
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("inertia:layout:active-tool:v1"))).toBe("collapsed");
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(page.locator(".workspace-panel")).toBeVisible();
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

for (const size of [
  { width: 1440, height: 920, label: "wide" },
  { width: 1024, height: 760, label: "stacked" },
  { width: 760, height: 600, label: "compact" },
]) {
  test(`keeps the ${size.label} layout reachable without overlap`, async () => {
    await resizeWindow(size.width, size.height);
    await expectNoViewportOverflow();
    await expect(page.locator(".workspace-header")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

    if (size.width <= 760) {
      const navigationToggle = page.getByRole("button", { name: "Toggle project navigation" });
      await navigationToggle.click();
      const mobileSidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
      await expect(mobileSidebar).toBeVisible();
      await expect(mobileSidebar.getByRole("button", { name: "Close navigation" })).toBeFocused();
      await expect(page.locator(".workspace-shell")).toHaveAttribute("inert", "");
      await expectNoViewportOverflow();
      const drawerControls = mobileSidebar.locator('button:not([disabled]), input:not([disabled])');
      const firstDrawerControl = drawerControls.first();
      const lastDrawerControl = drawerControls.last();
      await lastDrawerControl.focus();
      await page.keyboard.press("Tab");
      await expect(firstDrawerControl).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(lastDrawerControl).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(mobileSidebar).toBeHidden();
      await expect(navigationToggle).toBeFocused();
      await expect(page.locator(".workspace-shell")).not.toHaveAttribute("inert", "");
      await expect(page.locator(".sidebar-scrim")).toHaveAttribute("tabindex", "-1");
      await expect(page.locator(".sidebar-scrim")).toHaveAttribute("aria-hidden", "true");
    }

    const geometry = await page.evaluate(() => {
      const frame = document.querySelector(".workspace-frame")?.getBoundingClientRect();
      const chat = document.querySelector(".chat-workspace")?.getBoundingClientRect();
      const tools = document.querySelector(".workspace-panel")?.getBoundingClientRect();
      return frame && chat && tools ? { frame: { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom }, chat: { left: chat.left, top: chat.top, right: chat.right, bottom: chat.bottom }, tools: { left: tools.left, top: tools.top, right: tools.right, bottom: tools.bottom } } : null;
    });
    expect(geometry).not.toBeNull();
    if (geometry) {
      expect(geometry.frame.left).toBeGreaterThanOrEqual(0);
      expect(geometry.frame.top).toBeGreaterThanOrEqual(0);
      expect(geometry.frame.right).toBeLessThanOrEqual(size.width + 1);
      expect(geometry.frame.bottom).toBeLessThanOrEqual(size.height + 1);
      if (size.width > 1024) expect(geometry.chat.right).toBeLessThanOrEqual(geometry.tools.left + 1);
      else expect(geometry.chat.bottom).toBeLessThanOrEqual(geometry.tools.top + 1);
    }
    if (size.width <= 760) {
      const transcriptHeight = await page.getByLabel("Thread transcript").evaluate((element) => element.getBoundingClientRect().height);
      expect(transcriptHeight).toBeGreaterThanOrEqual(100);
    }

    expect(rendererErrors).toEqual([]);
  });
}
