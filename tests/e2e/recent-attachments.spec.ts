// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { copyFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

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
  await selectWorkspaceTool(await ensureWorkspaceTools(page), "Agents");
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
      expect(Math.round(layout.height * 100) / 100).toBeGreaterThanOrEqual(54); expect(layout.iconWidth).toBe(48); expect(layout.gap).toBe(9); expect(layout.overflow).toBe(false);
    }
    await capture(`recent-attachments-${theme}`);
    await recent.getByRole("button", { name: /Preview attachment .*\.png$/u }).focus();
    await page.keyboard.press("Enter");
    const preview = page.getByRole("dialog").filter({ has: page.locator(".attachment-preview-stage") });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.locator(".attachment-preview-stage img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(512);
    await capture(`recent-image-preview-${theme}`);
    const stage = preview.getByRole("group", { name: /^Zoomable preview of / });
    const level = stage.getByLabel("Zoom level");
    await expect(level).toHaveText("100%");
    await expect(stage).toHaveAttribute("data-zoomed", "false");
    await expect(stage.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    // Zooming has to scale the rendered image, not just the reported level.
    const fitted = (await stage.locator("img").boundingBox())!;
    await stage.getByRole("button", { name: "Zoom in" }).click();
    await stage.getByRole("button", { name: "Zoom in" }).click();
    await expect(level).toHaveText("225%");
    await expect(stage).toHaveAttribute("data-zoomed", "true");
    const magnified = (await stage.locator("img").boundingBox())!;
    expect(magnified.width).toBeGreaterThan(fitted.width * 2);
    // The magnified image still covers the stage it is clipped by.
    const clip = (await preview.locator(".attachment-preview-stage").boundingBox())!;
    expect(magnified.x).toBeLessThanOrEqual(clip.x + 1);
    expect(magnified.x + magnified.width).toBeGreaterThanOrEqual(clip.x + clip.width - 1);
    await capture(`recent-image-zoom-${theme}`);
    await stage.getByRole("button", { name: "Reset zoom" }).click();
    await expect(level).toHaveText("100%");
    await expect(stage).toHaveAttribute("data-zoomed", "false");
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
  await page.keyboard.press("Escape");

  // Past the recent set the panel expands into a scrollable gallery of every
  // attachment in the chat. Distinct icon sizes keep the imports distinct.
  const gallerySources = [
    "1024x1024", "256x256", "192x192", "128x128",
    "64x64", "48x48", "32x32", "24x24",
  ];
  const galleryPaths: string[] = [];
  for (const name of gallerySources) {
    const target = join(app.testDirectory, `gallery-${name}.png`);
    await copyFile(resolve(`resources/icons/${name}.png`), target);
    galleryPaths.push(target);
  }
  await app.electronApp.evaluate(({ dialog }, paths) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: paths, bookmarks: [] }));
  }, galleryPaths);
  await page.getByRole("button", { name: "Attach images, documents, or spreadsheets" }).click();
  await expect(page.locator(".composer-attachments img")).toHaveCount(gallerySources.length);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("More media for the gallery.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(recent.getByRole("listitem")).toHaveCount(3);
  const expand = page.getByRole("button", { name: "Show all 10" });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expand.click();
  const gallery = page.getByRole("list", { name: "All attachments" });
  await expect(gallery.getByRole("listitem")).toHaveCount(10);
  await app.expectNoViewportOverflow();
  // Newest first; check while the leading tile is still in the scrollport.
  await expect.poll(() => gallery.locator("img").first().evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(24);
  // The gallery stays inside a bounded scroller instead of stretching the
  // panel. Whether it actually overflows depends on the window, so assert the
  // bound and that scrolling is offered exactly when the tiles outgrow it.
  const scroll = page.locator(".environment-attachments-gallery");
  const scroller = await scroll.evaluate((node) => {
    const style = getComputedStyle(node);
    node.scrollTop = node.scrollHeight;
    return {
      overflowY: style.overflowY,
      maxHeight: Number.parseFloat(style.maxHeight),
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    };
  });
  expect(scroller.overflowY).toBe("auto");
  expect(scroller.clientHeight).toBeLessThanOrEqual(scroller.maxHeight + 1);
  expect(scroller.scrollTop > 0)
    .toBe(scroller.scrollHeight > scroller.clientHeight);
  await capture("recent-attachments-gallery-light");
  await page.getByRole("button", { name: "Show fewer" }).click();
  await expect(page.getByRole("list", { name: "Recent attachments" })).toBeVisible();
});
