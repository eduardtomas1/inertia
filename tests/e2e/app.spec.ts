import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  const workspaceDirectory = join(testDirectory, "Inertia");
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
  await page.getByText("Welcome to Inertia", { exact: true }).first().waitFor();
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

test("boots the local workspace and terminal", async () => {
  await resizeWindow(1440, 920);
  await expect(page.getByText("Local service ready", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Local", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Terminal panel").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome to Inertia", level: 1 })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Welcome to Inertia", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "New thread" }).first()).toBeEnabled();
  await expect(page.getByText("The previous run ended when Inertia closed. Send another message to continue.")).toBeVisible();
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  expect(await terminal.getAttribute("data-terminal-id")).not.toBe(beforeTerminalId);
  await expect(page.getByRole("alert")).toHaveCount(0);
  if (before.pid) await expect.poll(() => processExists(before.pid as number), { timeout: 5_000 }).toBe(false);
});

test("navigates settings, changes theme, and returns to chat", async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent accounts" })).toBeVisible();
  await page.getByRole("button", { name: "Keybindings", exact: true }).click();
  await expect(page.getByText("Toggle project navigation", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Go to workspace" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this V1 clear and calm.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Keep this V1 clear and calm.", { exact: true })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("dismisses and switches Composer menus without forcing a selection", async () => {
  await resizeWindow(1440, 920);
  const providerTrigger = page.getByRole("button", { name: "Choose provider and model" });
  const providerMenu = page.getByRole("menu", { name: "Provider and model" });

  await providerTrigger.click();
  await expect(providerTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(providerTrigger).toHaveAttribute("aria-controls", "composer-provider-menu");
  await expect(providerMenu).toBeVisible();

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

    await resizeWindow(760, 640);
    await page.getByRole("button", { name: "Toggle project navigation" }).click();
    await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    const compactMarkLeft = await page.locator(".brand-lockup").evaluate((lockup) => {
      const bounds = lockup.getBoundingClientRect();
      return bounds.left + Number.parseFloat(getComputedStyle(lockup).paddingLeft);
    });
    expect(compactMarkLeft - trafficLightClusterRight).toBeGreaterThanOrEqual(MAC_BRAND_MIN_CLEAR_GAP);
    await page.screenshot({ path: testInfo.outputPath("v004-brand-compact.png") });
    await page.getByRole("button", { name: "Close navigation" }).last().click();
    await resizeWindow(1440, 920);
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await brand.click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("opens the command palette and manages a thread", async () => {
  await resizeWindow(1440, 920);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByRole("dialog", { name: "Search Inertia" })).toBeVisible();
  await page.getByRole("dialog", { name: "Search Inertia" }).getByRole("option", { name: /New thread/ }).click();
  await expect(page.getByRole("heading", { name: "New thread", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Thread actions for New thread" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("textbox", { name: "Rename New thread" });
  await rename.fill("Focused V1 pass");
  await rename.press("Enter");
  await expect(page.getByRole("heading", { name: "Focused V1 pass", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Thread actions for Focused V1 pass" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to Inertia", level: 1 })).toBeVisible();

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
  await page.getByRole("tab", { name: /Terminal/ }).click();
  await page.getByRole("button", { name: "New terminal" }).click();
  await expect(page.getByRole("tab", { name: /Terminal 2/ })).toBeVisible();
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
  await page.getByRole("tab", { name: /Terminal/ }).click();
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

test("opens the categorized activity center", async () => {
  await page.getByRole("button", { name: "Open activity center" }).click();
  const center = page.getByRole("complementary", { name: "Activity center" });
  await expect(center).toBeVisible();
  for (const heading of ["Agents", "Checks", "Services", "Source Control"]) {
    await expect(center.getByRole("heading", { name: heading })).toBeVisible();
  }
  await center.getByRole("button", { name: "Close activity center" }).click();
  await expect(center).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
});

test("resizes and persists the internal workspace panes", async () => {
  await resizeWindow(1440, 920);
  await page.getByRole("tab", { name: /Terminal/ }).click();

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
  { width: 760, height: 640, label: "compact" },
]) {
  test(`keeps the ${size.label} layout reachable without overlap`, async () => {
    await resizeWindow(size.width, size.height);
    await expectNoViewportOverflow();
    await expect(page.locator(".workspace-header")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

    if (size.width <= 760) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toBeVisible();
      await expectNoViewportOverflow();
      await page.getByRole("button", { name: "Close navigation" }).last().click();
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

    expect(rendererErrors).toEqual([]);
  });
}
