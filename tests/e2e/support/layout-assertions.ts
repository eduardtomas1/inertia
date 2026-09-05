import { expect, type Locator, type Page } from "@playwright/test";

export async function verifyMobileNavigationControls(page: Page): Promise<void> {
  const navigation = page.getByRole("complementary", {
    name: "Project navigation",
    exact: true,
  });
  // CSS can expose the close control before the media-query state settles.
  // Establish the closed drawer before exercising its open/close controls.
  await expect(page.locator(".sidebar")).toHaveAttribute("aria-hidden", "true");
  await page.getByRole("button", { name: "Toggle project navigation" }).click();
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "Close navigation" }).click();
  await expect(navigation).toBeHidden();
}

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
    const shellChildren = [...(shell?.children ?? [])];
    const preDockChildren = shellChildren.slice(0, -1);
    const dockBounds = dock.getBoundingClientRect();
    const shellBounds = shell?.getBoundingClientRect();
    const shellStyle = shell ? getComputedStyle(shell) : null;
    return {
      dockEndsShell: shell?.lastElementChild === dock,
      preDockGoalOnly: preDockChildren.length <= 1
        && preDockChildren.every((element) =>
          element.classList.contains("chat-goal-control")),
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

  expect(layout.dockEndsShell).toBe(true);
  expect(layout.preDockGoalOnly).toBe(true);
  expect(layout.directShellOnly).toBe(true);
  expect(layout.bottomPadding).toBeGreaterThanOrEqual(8);
  expect(layout.bottomPadding).toBeLessThanOrEqual(22);
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
