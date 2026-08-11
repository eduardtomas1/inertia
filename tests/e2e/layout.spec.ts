import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

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

async function ensureWorkspaceTools(): Promise<void> {
  const panel = page.locator(".workspace-panel");
  if (await panel.isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(panel).toBeVisible();
}

test("opens Environment by default with reachable responsive geometry", async ({ browserName: _browserName }, testInfo) => {
  const themeButton = page.getByRole("button", { name: /Change theme/u });
  if (!/current: dark/u.test(await themeButton.getAttribute("aria-label") ?? "")) {
    await themeButton.click();
  }
  await expect(themeButton).toHaveAttribute("aria-label", /current: dark/u);
  for (const size of [
    { width: 1440, height: 920, label: "wide" },
    { width: 760, height: 600, label: "compact" },
  ]) {
    await resizeWindow(size.width, size.height);
    const environmentTab = page.getByRole("tab", { name: "Environment" });
    await expect(environmentTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Environment" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Inertia" })).toBeVisible();
    await expect(page.getByLabel("Terminal panel")).toHaveCount(0);
    await expectNoViewportOverflow();

    const geometry = await page.evaluate(() => {
      const frame = document.querySelector(".workspace-frame")?.getBoundingClientRect();
      const chat = document.querySelector(".chat-workspace")?.getBoundingClientRect();
      const environment = document.querySelector(".environment-panel")?.getBoundingClientRect();
      return frame && chat && environment ? {
        frame: { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom },
        chat: { left: chat.left, top: chat.top, right: chat.right, bottom: chat.bottom },
        environment: { left: environment.left, top: environment.top, right: environment.right, bottom: environment.bottom },
      } : null;
    });
    expect(geometry).not.toBeNull();
    if (geometry) {
      expect(geometry.environment.left).toBeGreaterThanOrEqual(geometry.frame.left);
      expect(geometry.environment.top).toBeGreaterThanOrEqual(geometry.frame.top);
      expect(geometry.environment.right).toBeLessThanOrEqual(geometry.frame.right + 1);
      expect(geometry.environment.bottom).toBeLessThanOrEqual(geometry.frame.bottom + 1);
      if (size.width > 1024) {
        expect(geometry.chat.right).toBeLessThanOrEqual(geometry.environment.left + 1);
      } else {
        expect(geometry.chat.bottom).toBeLessThanOrEqual(geometry.environment.top + 1);
      }
    }

    const screenshotPath = testInfo.outputPath(`environment-default-${size.label}.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(`environment-default-${size.label}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  }
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

test("resizes and persists the internal workspace panes", async () => {
  await resizeWindow(1440, 920);
  await ensureWorkspaceTools();
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
  await ensureWorkspaceTools();
  const navigationToggle = page.getByRole("button", { name: "Toggle project navigation" });
  await navigationToggle.click();
  await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("inertia:layout:sidebar-collapsed:v1"))).toBe("true");
  await navigationToggle.click();
  await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toBeVisible();

  const toolsToggle = page.getByRole("button", { name: "Close workspace tools" }).first();
  await toolsToggle.click();
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await expect.poll(() => page.evaluate(() => ({
    legacy: window.localStorage.getItem("inertia:layout:active-tool:v1"),
    lastTool: window.localStorage.getItem(
      "inertia:layout:last-workspace-tool:v2",
    ),
  }))).toEqual({ legacy: null, lastTool: "terminal" });
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
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(page.locator(".workspace-panel")).toBeVisible();
  await expect(page.locator(".workspace-body")).toHaveClass(/has-tools/u);
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
    await ensureWorkspaceTools();
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
      // Persisted usage, backend status, and split-terminal state may all be
      // visible at once. Keep multiple readable transcript lines reachable
      // without forcing those controls or the tool panel out of the viewport.
      // Windows can report a quarter-pixel less at fractional display scales.
      expect(transcriptHeight).toBeGreaterThanOrEqual(71.5);
    }

    expect(rendererErrors).toEqual([]);
  });
}
