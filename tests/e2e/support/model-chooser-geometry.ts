import { expect, test, type Locator } from "@playwright/test";
import { modelChooserPlacementChecks } from "../../support/model-chooser-placement";
import type { AppFixture } from "./app-fixture";

export async function expectModelChooserPlacement(
  chooser: Locator,
  requiredVertical?: "above" | "below",
): Promise<void> {
  await expect(chooser).toHaveAttribute("data-composer-popover-positioned", "true");
  // Native windows can be shorter than requested: hosted macOS runners
  // clamp 920px requests to 684px. Assert the independent fit calculation
  // against settled renderer geometry, including the 8px gap and padding.
  let lastGeometry: unknown;
  try {
    await expect.poll(async () => {
      const geometry = await chooser.evaluate((element) => {
        const frame = element.getBoundingClientRect();
        const anchor = element.closest(".model-chooser-anchor")!
          .querySelector("button")!.getBoundingClientRect();
        const workspace = element.closest(".chat-workspace")!.getBoundingClientRect();
        return {
          frame: { top: frame.top, bottom: frame.bottom, height: frame.height },
          anchor: { top: anchor.top, bottom: anchor.bottom },
          workspace: { top: workspace.top, bottom: workspace.bottom },
          viewportHeight: innerHeight,
          visualViewportHeight: visualViewport?.height,
          vertical: element.getAttribute("data-popover-vertical"),
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          maxHeight: getComputedStyle(element).maxHeight,
        };
      });
      lastGeometry = geometry;
      return modelChooserPlacementChecks(geometry);
    }).toEqual({ correctSide: true, anchored: true, insideWorkspace: true });
    if (requiredVertical) {
      await expect(chooser).toHaveAttribute("data-popover-vertical", requiredVertical);
    }
  } catch (error) {
    await test.info().attach("model-chooser-placement.json", {
      body: JSON.stringify({ requiredVertical, geometry: lastGeometry }, null, 2),
      contentType: "application/json",
    });
    throw error;
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
