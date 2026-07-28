import { expect, type Locator, type Page } from "@playwright/test";

export async function expectNoViewportOverflow(page: Page): Promise<void> {
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

export async function expectComposerEndsAtDock(composer: Locator): Promise<void> {
  await expect(composer).toBeVisible();
  const layout = await composer.evaluate((dock) => {
    const shell = dock.parentElement;
    const region = shell?.parentElement;
    const dockBounds = dock.getBoundingClientRect();
    const shellBounds = shell?.getBoundingClientRect();
    const shellStyle = shell ? getComputedStyle(shell) : null;
    return {
      directDockOnly: shell?.children.length === 1
        && shell.firstElementChild === dock
        && shell.lastElementChild === dock,
      directShellOnly: region?.children.length === 1
        && region.firstElementChild === shell
        && region.lastElementChild === shell,
      bottomPadding: Number.parseFloat(shellStyle?.paddingBottom ?? "NaN"),
      bottomGap: shellBounds ? shellBounds.bottom - dockBounds.bottom : Number.NaN,
      detachedContextRows: region?.querySelectorAll(
        ":scope > .provider-readiness, :scope > .composer-usage, :scope > .composer-footer, :scope > .composer-note",
      ).length ?? -1,
    };
  });

  expect(layout.directDockOnly).toBe(true);
  expect(layout.directShellOnly).toBe(true);
  expect(layout.bottomPadding).toBeGreaterThanOrEqual(8);
  expect(layout.bottomPadding).toBeLessThanOrEqual(14);
  expect(Math.abs(layout.bottomGap - layout.bottomPadding)).toBeLessThanOrEqual(1);
  expect(layout.detachedContextRows).toBe(0);
}

export async function expectComposerReadinessContained(composer: Locator): Promise<void> {
  const readiness = composer.locator(".provider-readiness");
  if (await readiness.count() === 0) return;
  await expect(readiness).toBeVisible();
  await expect(readiness).not.toContainText("needs attention");
  await expect(readiness).toHaveAttribute(
    "data-route-repair",
    /^(?:add-key|connect|install|none|probe|refresh)$/u,
  );
  const geometry = await readiness.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const composerBounds = element.closest<HTMLElement>(".composer")
      ?.getBoundingClientRect();
    return {
      insideInline: Boolean(
        composerBounds
        && bounds.left >= composerBounds.left - 1
        && bounds.right <= composerBounds.right + 1,
      ),
      fits: element.scrollWidth <= element.clientWidth + 1,
    };
  });
  expect(geometry.insideInline).toBe(true);
  expect(geometry.fits).toBe(true);
}
