// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

test("contains usage details and the Limits shortcut in a stacked workspace", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({ name: "usage-popover-placement",
    initialState: "conversation", windowDisplay: "primary" });
  try {
    for (const theme of ["dark", "light"] as const) {
      const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"),
        app.workspaceDirectory, { recoverInterruptedRuns: false });
      try { store.updateSettings({ theme, interfaceScale: "large" }); }
      finally { store.close(); }
      await app.page.reload();
      await expect(app.page.getByRole("textbox", { name: "Message" })).toBeVisible();
      if (!await app.page.locator(".workspace-panel:visible").count()) {
        await app.page.getByRole("button", { name: "Open workspace tools", exact: true }).click();
      }
      // A 760px request is constrained to 684px on the native CI display.
      await app.resizeWindow(1024, 684);
      await expect(app.page.locator("html")).toHaveAttribute("data-theme", theme);
      const trigger = app.page.locator(".usage-popover-trigger");
      await trigger.click();
      const popover = app.page.getByRole("dialog", { name: "Usage & context", exact: true });
      await expect(popover).toBeVisible();
      await expect(popover.getByRole("button", { name: "All provider limits" })).toBeVisible();
      const geometry = await popover.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const workspace = element.closest<HTMLElement>(".workspace-frame")!.getBoundingClientRect();
        const chat = element.closest<HTMLElement>(".chat-workspace")!.getBoundingClientRect();
        const tools = document.querySelector<HTMLElement>(".workspace-panel")!.getBoundingClientRect();
        return {
          bounds: bounds.toJSON(), workspace: workspace.toJSON(), chat: chat.toJSON(),
          stacked: chat.bottom <= tools.top + 1,
          insideViewport: bounds.top >= -1 && bounds.right <= window.innerWidth + 1
            && bounds.bottom <= window.innerHeight + 1 && bounds.left >= -1,
          insideWorkspace: bounds.top >= workspace.top - 1 && bounds.right <= workspace.right + 1
            && bounds.bottom <= workspace.bottom + 1 && bounds.left >= workspace.left - 1,
          insideChat: bounds.top >= chat.top - 1 && bounds.right <= chat.right + 1
            && bounds.bottom <= chat.bottom + 1 && bounds.left >= chat.left - 1,
          scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        };
      });
      const geometryPath = testInfo.outputPath(`usage-${theme}-geometry.json`);
      await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
      await testInfo.attach(`usage-${theme}-geometry`, { path: geometryPath, contentType: "application/json" });
      await app.page.screenshot({ path: testInfo.outputPath(`usage-${theme}.png`), animations: "disabled" });
      expect(geometry).toMatchObject({ stacked: true, insideViewport: true, insideWorkspace: true, insideChat: true });
      const hide = popover.getByRole("button", { name: "Hide usage", exact: true });
      await hide.focus();
      await expect(hide).toBeInViewport();
      await app.page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
      await expect(trigger).toBeFocused();
    }
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
