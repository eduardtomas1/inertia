// @inertia-e2e-resource primary-display
import { expect, test, type Page } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let popup!: Page;
const title = "detached-chat-tools fixture";
const primaryModifier = process.platform === "darwin" ? "Meta" : "Control";

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "detached-chat-tools",
    initialState: "conversation",
    windowDisplay: "primary",
  });
  await app.page.locator(".workspace-header").getByRole("button", {
    name: title,
    exact: true,
  }).click();
  const opened = app.electronApp.waitForEvent("window");
  await app.page.getByRole("menuitem", { name: "Open chat in new window" }).click();
  popup = await opened;
  await popup.locator(".detached-chat-shell").waitFor();
  await popup.getByRole("textbox", { name: "Message" }).waitFor();
});

test.afterAll(async () => {
  await app?.close();
});

async function resizePopup(width: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, { expectedTitle, nextWidth }) => {
    const window = BrowserWindow.getAllWindows()
      .find((candidate) => candidate.getTitle().startsWith(expectedTitle));
    if (!window) throw new Error("Detached window is missing");
    window.setContentSize(nextWidth, 760);
  }, { expectedTitle: title, nextWidth: width });
  await expect.poll(() => popup.evaluate(() => document.documentElement.clientWidth)).toBe(width);
}

async function openPanel(): Promise<ReturnType<Page["getByRole"]>> {
  const toggle = popup.getByRole("button", { name: /^Toggle right panel/u });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const panel = popup.getByRole("complementary", { name: "Workspace tools" });
  await expect(panel).toBeVisible();
  return panel;
}

test("opens without sending a request the chat window is not allowed to make", async () => {
  await expect(popup.getByRole("main").getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(popup.getByRole("alert")).toHaveCount(0);
});

test("opens the main window's tools beside the chat, without the Browser", async () => {
  const panel = await openPanel();
  const launcher = panel.getByRole("group", { name: "Open a surface" });
  await expect(launcher.getByRole("button", { name: /^Plan/u })).toBeVisible();
  await expect(launcher.getByText("Browser", { exact: true })).toHaveCount(0);
  await launcher.getByRole("button", { name: /^Plan/u }).click();
  await expect(panel.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("tabpanel", { name: "Plan" })).toBeVisible();

  await panel.getByRole("button", { name: "Add panel surface" }).click();
  const addMenu = panel.getByRole("menu", { name: "Add panel surface" });
  await expect(addMenu.getByRole("menuitem", { name: /Browser/u })).toHaveCount(0);
  await addMenu.getByRole("menuitem", { name: /^Attachments/u }).click();
  await expect(panel.getByRole("tab", { name: "Attachments" })).toHaveAttribute("aria-selected", "true");

  await resizePopup(960);
  await expect(panel).toHaveClass(/is-inline/u);
  const width = await popup.evaluate(() => document.documentElement.clientWidth);
  const panelBox = await panel.boundingBox();
  const chatBox = await popup.locator(".workspace-chat-column").boundingBox();
  expect(panelBox && chatBox).toBeTruthy();
  expect(Math.round(panelBox!.x + panelBox!.width)).toBe(width);
  expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(panelBox!.x + 1);
  await resizePopup(640);
  await expect(panel).toHaveClass(/is-sheet/u);

  await popup.getByRole("button", { name: /^Toggle right panel/u }).click();
  await expect(panel).toBeHidden();
});

test("keeps the header actions clear of the corner controls at the default width", async () => {
  await resizePopup(640);
  const more = await popup.locator(".workspace-header").getByRole("button", { name: "More header actions" }).boundingBox();
  const corner = await popup.locator(".workspace-corner-controls").boundingBox();
  expect(more && corner).toBeTruthy();
  expect(more!.x + more!.width).toBeLessThanOrEqual(corner!.x);
});

test("offers the chat's own menu, rename and thread ID copy in the header", async () => {
  const titleButton = popup.locator(".workspace-header").getByRole("button", {
    name: title,
    exact: true,
  });
  await titleButton.click();
  const menu = popup.getByRole("menu", { name: `Thread actions for ${title}` });
  await expect(menu.getByRole("menuitem", { name: "Rename thread" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /split view|new window|archive|delete/iu })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Copy" }).click();
  await popup.getByRole("menuitem", { name: "Thread ID" }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

  await titleButton.focus();
  await popup.keyboard.press("F2");
  const input = popup.getByRole("textbox", { name: "Chat title" });
  await expect(input).toHaveValue(title);
  await popup.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(titleButton).toBeFocused();
});

test("keeps search, tasks and sidebar shortcuts in the main window", async () => {
  await popup.getByRole("textbox", { name: "Message" }).focus();
  for (const key of ["k", "t", "b"]) await popup.keyboard.press(`${primaryModifier}+${key}`);
  await popup.waitForTimeout(500);
  await expect(popup.getByRole("dialog")).toHaveCount(0);
  await expect(popup.locator('aside[aria-label="Project navigation"]')).toHaveCount(0);
  await expect(popup.getByRole("textbox", { name: "Message" })).toBeFocused();
});

test("shows this chat's workspace changes in the Changes tab", async () => {
  const panel = await openPanel();
  await panel.getByRole("button", { name: "Add panel surface" }).click();
  await panel.getByRole("menu", { name: "Add panel surface" }).getByRole("menuitem", { name: /^Changes/u }).click();
  await expect(panel.getByRole("tabpanel", { name: "Changes" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Diff content for sample.ts" })).toBeVisible();
  await expect(popup.getByRole("alert")).toHaveCount(0);
});

test("runs a terminal for this chat in the Terminal tab", async () => {
  const panel = await openPanel();
  await panel.getByRole("button", { name: "Add panel surface" }).click();
  await panel.getByRole("menu", { name: "Add panel surface" }).getByRole("menuitem", { name: /^Terminal/u }).click();
  await expect(panel.locator(".xterm")).toBeVisible();
  await expect(panel.locator(".xterm-rows")).toContainText(/\S/u);
  await expect(popup.getByRole("alert")).toHaveCount(0);
});

test("opens settings in the main window and keeps the chat window open", async () => {
  await popup.getByRole("textbox", { name: "Message" }).focus();
  await popup.keyboard.press(`${primaryModifier}+Comma`);
  await expect(app.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(popup.locator(".detached-chat-shell")).toBeVisible();
});
