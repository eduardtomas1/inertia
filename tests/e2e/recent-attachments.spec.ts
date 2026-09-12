// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { copyFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
test.afterAll(async () => { await app?.close(); });
test("recent attachments show real thumbnails, open retained previews and handle a missing file", async ({ browserName: _browserName }, testInfo) => {
  app = await createAppFixture({ name: "recent-attachments", initialState: "conversation", windowDisplay: "primary" });
  await copyFile(resolve("resources/icons/512x512.png"), app.attachmentImagePath);
  const page = app.page;
  await app.electronApp.evaluate(({ dialog }, paths) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: paths, bookmarks: [] }));
  }, [app.attachmentImagePath, app.attachmentDocumentPath]);
  await page.getByRole("button", { name: "Attach images, documents, or spreadsheets" }).click();
  await expect(page.locator(".composer-attachments img")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Review these example attachments.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const recent = page.getByRole("list", { name: "Recent attachments" });
  await expect(recent).toBeVisible();
  const image = recent.locator("img");
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(512);
  const source = await image.getAttribute("src");
  expect(source).toMatch(/^inertia:\/\/bundle\/attachment-preview\/[0-9a-f-]{36}$/u);
  expect(source).not.toContain(app.testDirectory);
  const capture = async (name: string): Promise<void> => {
    await app.expectNoViewportOverflow(); const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  for (const theme of ["dark", "light"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: theme === "dark" ? "Dark" : "Light", exact: true }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(recent).toBeVisible();
    for (const button of await recent.getByRole("button").all()) {
      const layout = await button.evaluate((node) => {
        const box = node.getBoundingClientRect(); const icon = node.querySelector(".sent-attachment-thumbnail")!.getBoundingClientRect();
        const text = node.querySelector(".sent-attachment-copy")!.getBoundingClientRect();
        return { height: box.height, width: box.width, iconWidth: icon.width, gap: text.left - icon.right, overflow: node.scrollWidth > node.clientWidth };
      });
      expect(layout.height).toBeGreaterThanOrEqual(54); expect(layout.iconWidth).toBe(48); expect(layout.gap).toBe(9); expect(layout.overflow).toBe(false);
    }
    await capture(`recent-attachments-${theme}`);
    await recent.getByRole("button", { name: /Preview attachment .*\.png$/u }).focus();
    await page.keyboard.press("Enter");
    const preview = page.getByRole("dialog").filter({ has: page.locator(".attachment-preview-stage") });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.locator(".attachment-preview-stage img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(512);
    await capture(`recent-image-preview-${theme}`);
    await page.keyboard.press("Escape"); await expect(preview).toBeHidden();
    await expect(recent.getByRole("button", { name: /Preview attachment .*\.png$/u })).toBeFocused();
  }
  await recent.getByRole("button", { name: /Preview attachment .*\.pdf$/u }).click();
  const document = page.locator(".attachment-preview-dialog");
  await expect(document).toBeVisible();
  await expect(document.getByRole("button", { name: "Open in PDF app" })).toBeVisible();
  await capture("recent-document-preview-light");
  await page.keyboard.press("Escape");
  await page.reload(); await expect(recent).toBeVisible();
  await expect.poll(() => recent.locator("img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(512);
  expect(app.rendererErrors).toEqual([]);
  // Move, rather than delete, only this fixture's retained copy to test absence.
  const id = source!.split("/").at(-1)!;
  const retained = join(app.testDirectory, "data", "conversation-attachments", id, `${id}.png`);
  await rename(retained, `${retained}.missing-fixture`);
  await page.reload(); await expect(recent.locator('[data-thumbnail-state="unavailable"]')).toBeVisible();
  await recent.getByRole("button", { name: /Preview attachment .*\.png$/u }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Preview unavailable" })).toBeVisible();
  await capture("recent-missing-preview-light");
  expect(app.rendererErrors.length).toBeGreaterThan(0);
  expect(app.rendererErrors.every((error) => error === "HTTP 404 GET image inertia://bundle/attachment-preview/redacted"
    || error === "Failed to load resource: the server responded with a status of 404 (Not Found) (inertia://bundle/attachment-preview/redacted:1:1)")).toBe(true);
});
