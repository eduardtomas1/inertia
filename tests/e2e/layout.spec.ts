// @inertia-e2e-resource isolated
import { expect, test, type Locator, type TestInfo } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, openTerminalDock, rightPanelToggle, selectWorkspaceTool } from "./support/workspace-tools";
import { setAppearance, setAppearanceInPlace } from "./support/appearance";

let app!: AppFixture;
let page!: AppFixture["page"];
let rendererErrors!: AppFixture["rendererErrors"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "layout", initialState: "conversation" });
  page = app.page;
  rendererErrors = app.rendererErrors;
  resizeWindow = app.resizeWindow;
  expectNoViewportOverflow = app.expectNoViewportOverflow;
});

test.afterAll(async () => {
  await app.close();
});

async function panelGeometry(): Promise<{
  frame: DOMRectLike;
  header: DOMRectLike;
  chat: DOMRectLike;
  panel: DOMRectLike;
  sheet: boolean;
} | null> {
  return await page.evaluate(async () => {
    // Sheet entrance motion translates the panel beyond its final frame bounds.
    // Measure after that finite motion finishes; keep the containment checks strict.
    // An occluded window can stall the document timeline; never wait longer
    // than the entrance motion itself before measuring.
    const panelElement = document.querySelector(".workspace-panel");
    const settled = Promise.all((panelElement?.getAnimations() ?? [])
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    const rect = (selector: string) => {
      const bounds = document.querySelector(selector)?.getBoundingClientRect();
      return bounds
        ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }
        : null;
    };
    const frame = rect(".workspace-frame");
    const header = rect(".workspace-header");
    const chat = rect(".chat-workspace");
    const panel = rect(".workspace-panel");
    return frame && header && chat && panel ? {
      frame,
      header,
      chat,
      panel,
      sheet: document.querySelector(".workspace-panel")?.classList.contains("is-sheet") ?? false,
    } : null;
  });
}

interface DOMRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

test("starts with the chat alone and hosts surfaces in a responsive right panel", async ({ browserName: _browserName }, testInfo) => {
  const toggle = rightPanelToggle(page);
  const panel = page.locator(".workspace-panel");
  await resizeWindow(1440, 920);
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const header = page.locator(".workspace-header");
  await expect(header.getByRole("group", { name: "Open checkout" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Toggle terminal/u })).toBeVisible();

  for (const theme of ["dark", "light"] as const) {
    await resizeWindow(1440, 920);
    await setAppearance(page, theme);

    for (const size of [
      { width: 1440, height: 920, label: "wide", sheet: false },
      { width: 860, height: 700, label: "sheet", sheet: true },
      { width: 760, height: 600, label: "compact", sheet: false },
    ]) {
      await resizeWindow(size.width, size.height);
      await ensureWorkspaceTools(page);
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await selectWorkspaceTool(panel, "Changes");
      await expect(page.getByRole("tab", { name: /^Changes/u })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByLabel("Terminal panel")).toHaveCount(0);
      await expectNoViewportOverflow();

      const geometry = await panelGeometry();
      expect(geometry).not.toBeNull();
      if (geometry) {
        expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.frame.left);
        expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.frame.top - 1);
        expect(geometry.panel.right).toBeLessThanOrEqual(geometry.frame.right + 1);
        expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.frame.bottom + 1);
        expect(geometry.sheet).toBe(size.sheet);
        if (size.sheet) {
          expect(geometry.panel.left).toBeLessThan(geometry.chat.right);
          expect(geometry.chat.right - geometry.chat.left).toBeGreaterThanOrEqual(360);
        } else {
          expect(geometry.chat.right).toBeLessThanOrEqual(geometry.panel.left + 1);
          expect(geometry.header.right).toBeLessThanOrEqual(geometry.panel.left + 1);
          expect(geometry.chat.right - geometry.chat.left).toBeGreaterThanOrEqual(359);
        }
      }

      const label = `right-panel-${theme}-${size.label}`;
      const screenshotPath = testInfo.outputPath(`${label}.png`);
      await page.screenshot({ animations: "disabled", path: screenshotPath });
      await testInfo.attach(label, { path: screenshotPath, contentType: "image/png" });

      if (size.sheet) {
        await page.getByRole("tab", { name: /^Changes/u }).focus();
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await expect(toggle).toBeFocused();
      } else if (size.label === "wide" && theme === "dark") {
        await page.getByRole("tab", { name: /^Changes/u }).focus();
        await page.keyboard.press("Delete");
        await expect(panel).toBeHidden();
        await toggle.focus();
        await page.keyboard.press("Enter");
        const launcher = panel.getByRole("group", { name: "Open a surface" });
        await expect(launcher).toBeFocused();
        await page.keyboard.press("u");
        await expect(page.getByRole("tab", { name: "Usage" })).toBeFocused();
        await expect(page.getByRole("region", { name: "Usage", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Add panel surface" }).click();
        const addMenu = page.getByRole("menu", { name: "Add panel surface" });
        await expect(addMenu.getByRole("menuitem").first()).toBeFocused();
        await page.keyboard.press("a");
        await expect(page.getByRole("tab", { name: /^Background tasks/u })).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("region", { name: "Background tasks" })).toBeVisible();
        await page.getByRole("button", { name: "Close Background tasks" }).click();
        await page.getByRole("button", { name: "Close Usage" }).click();
        await expect(panel).toBeHidden();
      } else {
        await toggle.click();
        await expect(panel).toBeHidden();
      }
    }
  }
  await resizeWindow(1440, 920);
  await setAppearance(page, "dark");
  expect(rendererErrors).toEqual([]);
});

test("resizes and persists the internal workspace panes", async () => {
  await resizeWindow(1440, 920);
  await ensureWorkspaceTools(page);
  await openTerminalDock(page);

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
  await ensureWorkspaceTools(page);
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Files");
  const navigationToggle = page.getByRole("button", { name: "Toggle project navigation" });
  await navigationToggle.click();
  await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("inertia:layout:sidebar-collapsed:v1"))).toBe("true");
  await navigationToggle.click();
  await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toBeVisible();

  const toolsToggle = rightPanelToggle(page);
  await toolsToggle.click();
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await expect.poll(() => page.evaluate(() => ({
    legacy: window.localStorage.getItem("inertia:layout:active-tool:v1"),
    lastTool: window.localStorage.getItem(
      "inertia:layout:last-workspace-tool:v2",
    ),
  }))).toEqual({ legacy: null, lastTool: null });
  await expect.poll(() => page.evaluate(() => Object.entries(window.localStorage)
    .filter(([key]) => key.startsWith("inertia:layout:workspace-panel:"))
    .map(([, value]) => JSON.parse(value)))).toEqual([
      expect.objectContaining({ isOpen: false, activeSurfaceId: "files", surfaces: expect.arrayContaining(["files"]) }),
    ]);
  const readingCanvas = await page.evaluate(() => {
    const workspaceBody = document.querySelector<HTMLElement>(".workspace-body");
    const chat = document.querySelector<HTMLElement>(".chat-workspace");
    const visibleTurn = [...document.querySelectorAll<HTMLElement>(".response-turn")]
      .find((turn) => {
        const bounds = turn.getBoundingClientRect();
        return bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
      }) ?? document.querySelector<HTMLElement>(".empty-thread");
    if (!workspaceBody || !chat || !visibleTurn) return null;
    const chatBounds = chat.getBoundingClientRect();
    const turnBounds = visibleTurn.getBoundingClientRect();
    return {
      hasTools: workspaceBody.classList.contains("has-tools"),
      canvasBackground: getComputedStyle(workspaceBody).backgroundColor,
      chatBackground: getComputedStyle(chat).backgroundColor,
      chatCenter: chatBounds.left + (chatBounds.width / 2),
      turnCenter: turnBounds.left + (turnBounds.width / 2),
    };
  });
  expect(readingCanvas).not.toBeNull();
  expect(readingCanvas?.hasTools).toBe(false);
  expect(readingCanvas?.chatBackground).toBe(readingCanvas?.canvasBackground);
  expect(Math.abs((readingCanvas?.chatCenter ?? 0) - (readingCanvas?.turnCenter ?? 0))).toBeLessThanOrEqual(1);
  await page.reload();
  await page.locator('.app-shell[data-connection-status="online"]').waitFor();
  await expect(toolsToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await toolsToggle.click();
  await expect(page.locator(".workspace-panel")).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Files/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".workspace-body")).toHaveClass(/has-tools/u);
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

test("closes panel tabs with the middle button and keeps the active one in view", async () => {
  await resizeWindow(1440, 920);
  const panel = await ensureWorkspaceTools(page);
  for (const name of ["Changes", "Files", "Plan", "Attachments"]) await selectWorkspaceTool(panel, name);
  const order = async () => await page.locator(".workspace-panel [data-tab-key]")
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-key")));

  await panel.locator('[data-tab-key="plan"]').click({ button: "middle" });
  await expect(panel.locator('[data-tab-key="plan"]')).toHaveCount(0);

  for (const name of ["Plan", "Goal", "Usage", "Background tasks"]) await selectWorkspaceTool(panel, name);
  const toolsHandle = page.getByRole("separator", { name: "Resize workspace tools" });
  await toolsHandle.focus();
  await toolsHandle.press("Home");
  const list = panel.getByRole("tablist", { name: "Panel surfaces" });
  await expect.poll(() => list.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const first = (await order())[0]!;
  await panel.locator(`[data-workspace-tab="${first}"]`).click();
  await list.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.getByRole("textbox", { name: "Message", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+w");
  await expect(panel.locator(`[data-tab-key="${first}"]`)).toHaveCount(0);
  const next = (await order())[0]!;
  await expect(panel.locator(`[data-workspace-tab="${next}"]`)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => list.evaluate((element, key) => {
    const tab = element.querySelector(`[data-tab-key="${key}"]`)!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return tab.left >= bounds.left - 1 && tab.right <= bounds.right + 1;
  }, next)).toBe(true);
  await toolsHandle.focus();
  await toolsHandle.press("Enter");
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

for (const size of [
  { width: 1440, height: 920, label: "wide" },
  { width: 1024, height: 760, label: "medium" },
  { width: 760, height: 600, label: "compact" },
]) {
  test(`keeps the ${size.label} layout reachable without overlap`, async () => {
    await resizeWindow(size.width, size.height);
    await ensureWorkspaceTools(page);
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
      // Keep the original controls' identities: focusing the update trigger can
      // append its detail panel, which must not change the expected wrap target.
      const drawerControls = await mobileSidebar.locator('button:visible:not([disabled]), input:visible:not([disabled])').all();
      const firstDrawerControl = drawerControls[0];
      const lastDrawerControl = drawerControls[drawerControls.length - 1];
      await lastDrawerControl.focus();
      await page.keyboard.press("Tab");
      await expect(firstDrawerControl).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(lastDrawerControl).toBeFocused();
      const updateDetails = mobileSidebar.getByRole("dialog", { name: "Application update details" });
      await expect(updateDetails).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(updateDetails).toBeHidden();
      await expect(mobileSidebar).toBeVisible();
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
      const sheet = await page.locator(".workspace-panel").evaluate((element) => element.classList.contains("is-sheet"));
      if (sheet) expect(geometry.tools.left).toBeGreaterThan(geometry.chat.left);
      else expect(geometry.chat.right).toBeLessThanOrEqual(geometry.tools.left + 1);
    }
    if (size.width <= 760) {
      const transcriptHeight = await page.getByLabel("Thread transcript").evaluate((element) => element.getBoundingClientRect().height);
      // Persisted usage, backend status, and split-terminal state may all be
      // visible at once. Keep multiple readable transcript lines reachable
      // without forcing those controls or the tool panel out of the viewport.
      // Windows can report a quarter-pixel less at fractional display scales.
      expect(transcriptHeight).toBeGreaterThanOrEqual(71.5);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
      const palette = page.getByRole("dialog", { name: "Search Inertia" });
      await palette.getByRole("combobox").fill("help");
      await palette.getByRole("option", { name: /Open help/u }).click();
      const help = page.getByRole("dialog", { name: "Help" });
      await expect(help).toBeVisible();
      await expect.poll(() => help.evaluate((element) => (
        element.getAnimations().every((animation) => animation.playState === "finished")
      ))).toBe(true);
      const bounds = await help.boundingBox();
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await page.keyboard.press("Escape");
      await expect(help).toHaveCount(0);
    }

    expect(rendererErrors).toEqual([]);
  });
}

async function settleHelp(help: Locator): Promise<void> {
  await expect.poll(() => help.evaluate((element) => (
    element.getAnimations({ subtree: true }).every((animation) => animation.playState === "finished"
      || animation.effect?.getTiming().iterations === Infinity)
  ))).toBe(true);
}

async function captureHelp(help: Locator, testInfo: TestInfo, name: string): Promise<void> {
  await settleHelp(help);
  await page.mouse.move(0, 0);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function expectHelpFits(help: Locator): Promise<void> {
  const geometry = await help.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const results = element.querySelector(".help-guide-results");
    return {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
      resultsOverflow: results ? results.scrollWidth - results.clientWidth : 0,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.resultsOverflow).toBeLessThanOrEqual(0);
  await expectNoViewportOverflow();
}

test("searches Help, moves through the results and opens an entry's setting", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  await setAppearanceInPlace(app, "dark");
  await page.clock.setFixedTime(new Date("2026-10-03T10:00:00.000Z"));
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const help = page.getByRole("dialog", { name: "Help" });
  const field = help.getByRole("searchbox", { name: "Search help" });
  const results = help.getByRole("region", { name: "Search results" });
  const status = help.getByRole("status");
  await expect(field).toBeFocused();
  await expect(help.getByRole("tab", { name: "Getting started" })).toHaveAttribute("aria-selected", "true");
  await captureHelp(help, testInfo, "help-search-topics-dark-wide");

  await page.keyboard.type("snooz");
  await expect(help.getByRole("tablist")).toHaveCount(0);
  await expect(status).toHaveText("2 results");
  await expect(results.getByRole("group", { name: "Following work" })).toBeVisible();
  await expect(results.getByRole("group", { name: "Usage and limits" })).toBeVisible();
  await expect(results.locator("mark").first()).toBeVisible();
  await expect(help.getByText(/Topic \d+ of/u)).toHaveCount(0);
  await expect(help.getByRole("button", { name: "Done" })).toBeVisible();
  await expectHelpFits(help);
  await captureHelp(help, testInfo, "help-search-results-dark-wide");

  await setAppearanceInPlace(app, "light");
  await captureHelp(help, testInfo, "help-search-results-light-wide");

  for (const size of [
    { width: 1000, height: 800, label: "narrow" },
    { width: 760, height: 600, label: "760x600" },
  ]) {
    await resizeWindow(size.width, size.height);
    for (const theme of ["light", "dark"] as const) {
      await setAppearanceInPlace(app, theme);
      await expectHelpFits(help);
      await captureHelp(help, testInfo, `help-search-results-${theme}-${size.label}`);
    }
  }

  await resizeWindow(1440, 920);
  await field.fill("zebra");
  await expect(status).toHaveText("No matches");
  await expect(help.getByText("No matches.")).toBeVisible();
  await captureHelp(help, testInfo, "help-search-no-matches-dark-wide");

  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await expect(help.getByRole("tab", { name: "Getting started" })).toHaveAttribute("aria-selected", "true");
  await setAppearanceInPlace(app, "light");
  await captureHelp(help, testInfo, "help-search-topics-light-wide");
  await setAppearanceInPlace(app, "dark");

  await page.keyboard.type("custom colours");
  await expect(status).toHaveText("1 result");
  await page.keyboard.press("ArrowDown");
  const result = results.getByRole("button", { name: "Custom colours" });
  await expect(result).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(field).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(help).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Appearance" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Custom colours" })).toBeVisible();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});
