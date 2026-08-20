import { expect, test, type Page } from "@playwright/test";

import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let page!: Page;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "detached-chat-window",
    initialState: "conversation",
    windowDisplay: "primary",
  });
  page = app.page;
});

test.afterAll(async () => {
  await app?.close();
});

async function openDetachedWindow(title: string): Promise<Page> {
  const opened = app.electronApp.waitForEvent("window");
  await page.getByRole("button", {
    name: `Open ${title} in a new window`,
  }).click();
  const popup = await opened;
  await popup.locator(".detached-chat-shell").waitFor();
  return popup;
}

test("moves one live chat between a remembered native window and the main app", async () => {
  const title = "detached-chat-window fixture";
  const draft = "Keep this exact draft while the view moves.";
  const popupDraft = `${draft} Updated inside the popup.`;
  await page.getByRole("textbox", { name: "Message" }).fill(draft);

  const popup = await openDetachedWindow(title);
  await expect(page.getByRole("region", {
    name: `Detached chat: ${title}`,
  })).toContainText("Chat window active");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await expect(popup.getByRole("heading", { name: title })).toBeVisible();
  await expect(popup.getByRole("textbox", { name: "Message" }))
    .toHaveValue(draft);
  await expect(popup.locator('aside[aria-label="Project navigation"]'))
    .toHaveCount(0);
  await expect(popup.getByRole("button", { name: /new chat/iu }))
    .toHaveCount(0);
  await expect(popup.getByRole("button", { name: /prompt presets/iu }))
    .toHaveCount(0);

  await popup.getByRole("button", { name: "Keep chat window on top" }).click();
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }, expectedTitle) => BrowserWindow.getAllWindows()
      .find((window) => window.getTitle().startsWith(expectedTitle))
      ?.isAlwaysOnTop() ?? false,
    title,
  )).toBe(true);

  const rememberedBounds = await app.electronApp.evaluate(
    ({ BrowserWindow }, expectedTitle) => {
      const window = BrowserWindow.getAllWindows()
        .find((candidate) => candidate.getTitle().startsWith(expectedTitle));
      if (!window) throw new Error("Detached window is missing");
      window.setBounds({ x: 120, y: 110, width: 704, height: 668 });
      return window.getBounds();
    },
    title,
  );
  expect(rememberedBounds).toMatchObject({ width: 704, height: 668 });
  await popup.getByRole("textbox", { name: "Message" }).fill(popupDraft);

  await Promise.all([
    popup.waitForEvent("close"),
    popup.getByRole("button", { name: "Close chat window" })
      .click({ noWaitAfter: true }),
  ]);
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  )).toBe(1);
  await expect.poll(() => page.evaluate(
    () => window.inertia.getDetachedChatWindows(),
  )).toEqual([]);
  await expect(page.getByRole("region", {
    name: `Detached chat: ${title}`,
  })).toContainText("Chat window closed");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);

  await page.getByRole("button", { name: "Open chat here" }).click();
  await expect(page.getByRole("textbox", { name: "Message" }))
    .toHaveValue(popupDraft);

  const reopened = await openDetachedWindow(title);
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }, expectedTitle) => BrowserWindow.getAllWindows()
      .find((window) => window.getTitle().startsWith(expectedTitle))
      ?.getBounds() ?? null,
    title,
  )).toMatchObject({ width: 704, height: 668 });

  await Promise.all([
    reopened.waitForEvent("close"),
    reopened.getByRole("button", {
      name: "Return chat to main window",
    }).click({ noWaitAfter: true }),
  ]);
  await expect(page.getByRole("textbox", { name: "Message" }))
    .toHaveValue(popupDraft);
  await expect(page.getByRole("region", {
    name: `Detached chat: ${title}`,
  })).toHaveCount(0);
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  )).toBe(1);
});
