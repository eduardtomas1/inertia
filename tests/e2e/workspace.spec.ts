import { expect, test } from "@playwright/test";

import {
  MAC_BRAND_MIN_CLEAR_GAP,
  MAC_BRAND_SAFE_INSET,
  MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH,
  MAC_TRAFFIC_LIGHT_POSITION,
} from "../../src/shared/window-chrome";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];
let rendererErrors!: AppFixture["rendererErrors"];
let resizeWindow!: AppFixture["resizeWindow"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "workspace-shell", initialState: "conversation" });
  page = app.page;
  rendererErrors = app.rendererErrors;
  resizeWindow = app.resizeWindow;
});

test.afterAll(async () => {
  await app.close();
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
  await sidebar.getByRole("searchbox", {
    name: "Search projects and conversations",
  }).click();
  await expect(projectMenu).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Project actions for Inertia" }).first().click();
  await projectMenu.getByRole("menuitemradio", { name: "Keep separate", exact: true }).click();

  const branchName = (await page
    .locator('[data-header-menu="branch"] > button span')
    .first()
    .textContent())?.trim();
  if (!branchName) {
    throw new Error("Current Git branch is unavailable");
  }
  const newChatAccessibleName = `New chat, Codex, Inertia, Branch ${branchName}, Idle`;

  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Work", exact: true }).click();
  await expect(sidebar).toHaveClass(/sidebar-mode-activity/u);
  await expect(sidebar.getByRole("heading", { name: "Recent" })).toBeVisible();
  const activityCard = sidebar.locator(".activity-thread.is-active");
  const threadCard = activityCard.getByRole("button", {
    name: newChatAccessibleName,
  });
  await expect(threadCard).toBeVisible();
  const trailing = activityCard.locator(".activity-thread-trailing");
  await expect(trailing.locator("time")).toBeVisible();
  await expect(trailing).toHaveCSS("opacity", "1");
  await activityCard.hover();
  await expect(trailing).toHaveCSS("opacity", "0");
  const threadActions = activityCard.getByRole("button", {
    name: "Thread actions for New chat",
  });
  await expect(threadActions).toHaveCSS("opacity", "1");

  const firstNavigationItem = sidebar.locator("[data-sidebar-nav]").first();
  await firstNavigationItem.focus();
  await firstNavigationItem.press("ArrowDown");
  expect(await firstNavigationItem.evaluate((item) => document.activeElement !== item)).toBe(true);

  await expect(threadActions).toHaveCSS("opacity", "1");
  await threadActions.click();
  await sidebar.getByRole("menuitem", { name: "Done" }).click();
  const doneToggle = sidebar.getByRole("button", { name: "Done 1" });
  await expect(doneToggle).toHaveAttribute("aria-expanded", "false");
  await doneToggle.click();
  const doneCard = sidebar.locator('.activity-thread[data-work-section="done"].is-active');
  await expect(doneCard.getByRole("button", {
    name: newChatAccessibleName,
  })).toBeVisible();
  await doneCard.getByRole("button", { name: "Thread actions for New chat" }).click();
  await sidebar.getByRole("menuitem", { name: "Reopen" }).click();
  await expect(sidebar.locator('.activity-thread[data-work-section="recent"].is-active').getByRole("button", {
    name: newChatAccessibleName,
  })).toBeVisible();

  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Projects", exact: true }).click();
  await expect(sidebar).toHaveClass(/sidebar-mode-classic/u);
  expect(rendererErrors).toEqual([]);
});

test("collapses composer settings without displacing send and right-aligns user turns", async () => {
  await resizeWindow(900, 600);
  const composer = page.locator(".composer");
  const more = page.getByRole("button", { name: "More composer options" });
  const send = page.getByRole("button", { name: "Send message" });
  const modelTrigger = page.getByRole("button", { name: /^Choose model\./u });
  await expect(more).toBeVisible();
  await expect(send).toBeVisible();
  await expect(modelTrigger).toBeVisible();

  const bounds = await composer.boundingBox();
  const sendBounds = await send.boundingBox();
  expect(bounds).not.toBeNull();
  expect(sendBounds).not.toBeNull();
  expect((sendBounds?.x ?? 0) + (sendBounds?.width ?? 0)).toBeLessThanOrEqual((bounds?.x ?? 0) + (bounds?.width ?? 0));

  await modelTrigger.click();
  const modelChooser = page.getByRole("dialog", { name: "Choose model" });
  await expect(modelChooser).toBeVisible();
  const chooserBounds = await modelChooser.boundingBox();
  expect(chooserBounds).not.toBeNull();
  expect(chooserBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((chooserBounds?.x ?? 0) + (chooserBounds?.width ?? 0))
    .toBeLessThanOrEqual(900);
  await page.keyboard.press("Escape");

  await more.click();
  const compactOptions = page.getByRole("menu", { name: "More composer options" });
  await expect(compactOptions.getByRole("menuitem", { name: /^Backend\b/ })).toHaveCount(0);
  await expect(compactOptions.getByRole("menuitem", { name: /^Model\b/ })).toHaveCount(0);
  const modeItem = compactOptions.getByRole("menuitem", { name: /^Mode\b/ });
  await expect(modeItem).toBeVisible();
  await expect(compactOptions.getByRole("menuitem", { name: /^Access\b/ })).toBeVisible();
  await modeItem.hover();
  const modeOptions = page.getByRole("menu", { name: "Mode options" });
  await expect(modeOptions).toBeVisible();
  await expect(modeOptions.getByRole("menuitemradio").first()).toBeVisible();
  await modeItem.click();
  await expect(modeOptions).toBeVisible();
  await page.mouse.move(20, 20);
  await expect(modeOptions).toBeHidden();
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
  const trigger = page.getByRole("button", { name: "Commit", exact: true });
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

test("keeps the macOS brand in the native titlebar row and starts a new chat", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  const shell = page.locator(".app-shell");
  const brand = page.getByRole("button", { name: "Start a new chat" });
  await expect(shell).toHaveClass(new RegExp(`platform-${process.platform}`));

  if (process.platform === "darwin") {
    const geometry = await page.evaluate(() => {
      const row = document.querySelector(".sidebar-brand")?.getBoundingClientRect();
      const shell = document.querySelector(".app-shell");
      const lockup = document.querySelector(".brand-lockup");
      const logo = document.querySelector(".brand-logo");
      const markStyles = lockup ? getComputedStyle(lockup, "::before") : null;
      const lockupStyles = lockup ? getComputedStyle(lockup) : null;
      const logoStyles = logo ? getComputedStyle(logo) : null;
      const lockupBounds = lockup?.getBoundingClientRect();
      return row && shell && lockupBounds && markStyles && lockupStyles && logoStyles ? {
        row: { top: row.top, height: row.height },
        markLeft: lockupBounds.left + Number.parseFloat(lockupStyles.paddingLeft),
        safeInset: Number.parseFloat(getComputedStyle(shell).getPropertyValue(
          "--mac-titlebar-brand-safe-inset",
        )),
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
    expect(geometry?.safeInset).toBe(MAC_BRAND_SAFE_INSET);
    expect(geometry?.markLeft).toBeGreaterThanOrEqual(MAC_BRAND_SAFE_INSET);
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
  await expect(page.getByRole("button", { name: "General", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await brand.click();
  await expect(page.getByRole("heading", {
    name: "What should we build today?",
  })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Project" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});
