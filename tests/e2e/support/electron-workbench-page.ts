import { expect, type ElectronApplication, type Page } from "@playwright/test";

/** Restored auxiliary windows may finish loading before the workbench. */
export async function waitForWorkbenchPage(app: ElectronApplication): Promise<Page> {
  let workbench: Page | undefined;
  await expect.poll(() => {
    workbench = app.windows().find((page) => new URL(page.url()).pathname.endsWith("/index.html"));
    return Boolean(workbench);
  }, { timeout: 30_000, message: "Wait for the built workbench, regardless of auxiliary window order" }).toBe(true);
  return workbench!;
}

export async function positionWorkbenchOnPrimary(app: ElectronApplication, page: Page): Promise<void> {
  const origin = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const nativeWindow = await app.browserWindow(page);
  try { await nativeWindow.evaluate((window, point) => window.setPosition(point.x, point.y), origin); }
  finally { await nativeWindow.dispose(); }
}
