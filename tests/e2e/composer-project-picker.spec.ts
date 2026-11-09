// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

for (const { projectName, truncated } of [
  { projectName: "sample", truncated: false },
  {
    projectName: "A deliberately long project name that needs truncation inside the composer",
    truncated: true,
  },
]) {
  test(`keeps ${truncated ? "long" : "short"} project names readable at full and split composer widths`, async () => {
    const app = await createAppFixture({
      name: "composer-project-picker",
      initialState: "conversation",
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(
          join(testDirectory, "data", "inertia.sqlite"),
          workspaceDirectory,
          { recoverInterruptedRuns: false },
        );
        try {
          for (const project of store.shellSnapshot().projects) {
            store.updateProject(project.id, { name: projectName });
          }
        } finally {
          store.close();
        }
      },
    });
    try {
      const page = app.page;
      await app.resizeWindow(1440, 920);
      await page.getByRole("button", { name: "Start a new chat" }).click();
      const composer = page.getByRole("region", { name: "Message composer" });
      const picker = composer.getByRole("button", { name: "Project", exact: true });
      await expect(picker).toBeEnabled();

      await expect(picker.locator("span")).toHaveText(projectName);
      for (const width of [760, 480, 360]) {
        // Constrain the real new-chat composer to the space a split pane gets.
        await composer.evaluate((element, maxWidth) => {
          element.style.maxWidth = `${maxWidth}px`;
        }, width);
        await expect.poll(() => composer.evaluate((element) => {
          const rail = element.querySelector<HTMLElement>(".composer-primary-rail")!;
          return rail.scrollWidth <= rail.clientWidth + 1;
        })).toBe(true);
        const geometry = await composer.evaluate((element) => {
          const trigger = element.querySelector<HTMLElement>(".composer-project-picker-trigger")!;
          const label = trigger.querySelector<HTMLElement>("span")!;
          const rail = element.querySelector<HTMLElement>(".composer-primary-rail")!;
          const branch = element.querySelector<HTMLElement>(".composer-checkout-context .composer-branch-control");
          const branchShown = Boolean(branch && getComputedStyle(branch).display !== "none");
          const triggerBounds = trigger.getBoundingClientRect();
          const railBounds = rail.getBoundingClientRect();
          return {
            width: element.getBoundingClientRect().width,
            labelWidth: label.clientWidth,
            labelScrollWidth: label.scrollWidth,
            triggerContained: triggerBounds.left >= railBounds.left
              && triggerBounds.right <= railBounds.right,
            controlsSeparated: !branchShown || triggerBounds.right < branch!.getBoundingClientRect().left,
            railFits: rail.scrollWidth <= rail.clientWidth + 1,
          };
        });
        expect(geometry.width).toBeCloseTo(width, 0);
        expect(geometry).toMatchObject({
          triggerContained: true,
          controlsSeparated: true,
          railFits: true,
        });
        if (!truncated) {
          expect(geometry.labelScrollWidth).toBeLessThanOrEqual(geometry.labelWidth);
        } else {
          expect(geometry.labelWidth).toBeGreaterThan(60);
          expect(geometry.labelScrollWidth).toBeGreaterThan(geometry.labelWidth);
        }
      }
      await app.expectNoViewportOverflow();
      expect(app.rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
}
