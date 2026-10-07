// @inertia-e2e-resource primary-display
import { expect, test, type Page } from "@playwright/test";

import { createAppFixture } from "./support/app-fixture";
import {
  FOREIGN_PAGE_TITLE,
  SCOPED_PAGE_TITLE,
  seedScopedHtmlRenderConversations,
} from "./support/html-render-fixture";

async function frameRender(page: Page, scheme: string, renderId: string, id: string): Promise<void> {
  await page.evaluate(([source, frameId]) => {
    const frame = document.createElement("iframe");
    frame.id = frameId;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = source;
    document.body.append(frame);
  }, [`${scheme}//render/${renderId}`, id] as const);
}

test("serves a detached chat window only the pages of its own chat", async ({ browserName: _browserName }) => {
  test.setTimeout(120_000);
  let renderIds: ReturnType<typeof seedScopedHtmlRenderConversations> | null = null;
  const app = await createAppFixture({
    name: "html-render-detached",
    initialState: "conversation",
    windowDisplay: "primary",
    beforeLaunch: (fixture) => {
      renderIds = seedScopedHtmlRenderConversations(fixture);
    },
  });
  const { page } = app;
  try {
    if (!renderIds) throw new Error("The scoped visual replies were not seeded.");
    const { scopedRenderId, foreignRenderId } = renderIds;
    const scopedFrame = `[data-testid="html-render-frame"][title="${SCOPED_PAGE_TITLE}"]`;
    await expect(page.frameLocator(scopedFrame).getByRole("heading", { name: SCOPED_PAGE_TITLE })).toBeVisible();
    const scheme = new URL(await page.locator(scopedFrame).getAttribute("src") ?? "").protocol;

    await page.locator(".workspace-header").getByRole("button", { name: "html-render-detached fixture", exact: true }).click();
    const opened = app.electronApp.waitForEvent("window");
    await page.getByRole("menuitem", { name: "Open chat in new window" }).click();
    const popup = await opened;
    await popup.locator(".detached-chat-shell").waitFor();
    await expect(popup.frameLocator(scopedFrame).getByRole("heading", { name: SCOPED_PAGE_TITLE })).toBeVisible();

    await frameRender(popup, scheme, scopedRenderId, "e2e-own");
    await frameRender(popup, scheme, foreignRenderId, "e2e-foreign");
    await expect(popup.frameLocator("#e2e-own").getByRole("heading", { name: SCOPED_PAGE_TITLE })).toBeVisible();
    await expect(popup.frameLocator("#e2e-foreign").getByText("This page is no longer available.")).toBeVisible();
    await expect(popup.frameLocator("#e2e-foreign").getByRole("heading", { name: FOREIGN_PAGE_TITLE })).toHaveCount(0);

    await frameRender(page, scheme, foreignRenderId, "e2e-foreign");
    await expect(page.frameLocator("#e2e-foreign").getByRole("heading", { name: FOREIGN_PAGE_TITLE })).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
