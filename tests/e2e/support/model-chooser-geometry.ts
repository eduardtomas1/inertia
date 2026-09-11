import { expect, type Locator } from "@playwright/test";
import type { AppFixture } from "./app-fixture";

export async function expectModelChooserPlacement(
  chooser: Locator,
  requiredVertical?: "above" | "below",
): Promise<void> {
  await expect(chooser).toHaveAttribute("data-composer-popover-positioned", "true");
  // Native windows can be shorter than requested: hosted macOS runners
  // clamp 920px requests to 684px. Assert the independent fit calculation
  // against settled renderer geometry, including the 8px gap and padding.
  await expect.poll(() => chooser.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const anchor = element.closest(".model-chooser-anchor")!
      .querySelector("button")!.getBoundingClientRect();
    const workspace = element.closest(".chat-workspace")!.getBoundingClientRect();
    // Placement uses the visual viewport (Electron zoom/hosted native windows
    // can make it differ from the layout viewport). Keep the assertion on the
    // same coordinate space as the production positioning utility.
    const viewport = visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (viewport?.height ?? innerHeight);
    const availableBelow = Math.min(viewportBottom, workspace.bottom) - anchor.bottom - 16;
    const expectedVertical = frame.height <= availableBelow ? "below" : "above";
    return {
      correctSide: element.getAttribute("data-popover-vertical") === expectedVertical,
      anchored: expectedVertical === "below"
        ? frame.top >= anchor.bottom + 7.5
        : frame.bottom <= anchor.top - 7.5,
      insideWorkspace: frame.top >= Math.max(viewportTop, workspace.top) + 7.5
        && frame.bottom <= Math.min(viewportBottom, workspace.bottom) - 7.5,
    };
  })).toEqual({ correctSide: true, anchored: true, insideWorkspace: true });
  if (requiredVertical) {
    await expect(chooser).toHaveAttribute("data-popover-vertical", requiredVertical);
  }
}

export async function expectModelChooserVerticalFallback(
  app: AppFixture,
  chooser: Locator,
): Promise<void> {
  // Reproduce the hosted macOS height and prove both directions on every
  // display. Real Electron zoom supplies 920 CSS pixels for the below case.
  await app.resizeWindow(1440, 684);
  await expectModelChooserPlacement(chooser, "above");
  const nativeHeight = await app.page.evaluate(() => innerHeight);
  const nativeWindow = await app.electronApp.browserWindow(app.page);
  try {
    await nativeWindow.evaluate((window, height) => {
      window.webContents.setZoomFactor(Math.min(1, height / 920));
    }, nativeHeight);
    await expect.poll(() => app.page.evaluate(() => innerHeight)).toBeGreaterThanOrEqual(919);
    await expectModelChooserPlacement(chooser, "below");
  } finally {
    await nativeWindow.evaluate((window) => window.webContents.setZoomFactor(1));
    await nativeWindow.dispose();
  }
  await expect.poll(() => app.page.evaluate(() => innerHeight)).toBe(nativeHeight);
}
