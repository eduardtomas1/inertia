// @inertia-e2e-resource primary-display
import { expect, test, type Locator } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";
import { expectPaneComposerClearOfTerminalHandle, openPaneTerminal, openTerminalDock } from "./support/workspace-tools";

async function expectComposerReserved(column: Locator): Promise<void> {
  await expectPaneComposerClearOfTerminalHandle(column);
  await expect.poll(() => column.evaluate((element) => {
    const workspace = element.querySelector(".chat-workspace")!.getBoundingClientRect();
    const composer = element.querySelector(".composer-region")!.getBoundingClientRect();
    const reserve = Number.parseFloat((element as HTMLElement).style.getPropertyValue("--chat-minimum-height"));
    return {
      reserveCoversComposer: reserve >= composer.height,
      composerInsideChat: composer.top >= workspace.top - 1 && composer.bottom <= workspace.bottom + 1,
    };
  })).toEqual({ reserveCoversComposer: true, composerInsideChat: true });
}

for (const navigation of ["settings", "split"] as const) {
  test(`reserves the tall composer above the terminal after leaving ${navigation}`, async ({ browserName: _browserName }, testInfo) => {
    const name = `chat-minimum-${navigation}`;
    const app = await createAppFixture({
      name, initialState: "conversation", seedSecondProject: true, windowDisplay: "primary",
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
        try {
          store.updateSettings({ interfaceScale: "large", responseDensity: "comfortable" });
          for (const conversation of store.shellSnapshot().conversations) {
            store.createMessage(conversation.id, "Keep the draft and terminal usable when changing views.", "assistant");
          }
        } finally { store.close(); }
      },
    });
    try {
      const { page } = app;
      await app.resizeWindow(1440, 760);
      await app.electronApp.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(1.25);
      });
      await expect(page.locator("html")).toHaveAttribute("data-interface-scale", "large");
      const draft = Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1}`).join("\n");
      await page.getByRole("textbox", { name: "Message", exact: true }).fill(draft);
      const dock = await openTerminalDock(page);
      await expect(dock.locator(".terminal-panel[data-terminal-id]")).toHaveAttribute("data-terminal-id", /.+/u);
      const column = page.locator(".workspace-chat-column");
      const resize = column.getByRole("separator", { name: "Resize terminal" });
      await resize.focus();
      await resize.press("End");
      await expect(resize).toHaveAttribute("aria-valuenow", "640");
      await expectComposerReserved(column);

      if (navigation === "settings") {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await expect(page.getByRole("main", { name: "Settings", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Workspace", exact: true }).click();
      } else {
        const companion = `${name} companion`;
        await page.locator(".activity-thread-select").filter({ hasText: companion }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Add this chat to split view" }).click();
        await expect(page.getByRole("main", { name: "Split conversation workspace" })).toBeVisible();
        const primary = page.getByRole("region", { name: `Primary chat: Inertia · ${name} fixture` });
        await openPaneTerminal(primary, `${name} fixture`);
        await expectComposerReserved(primary.locator(".conversation-pane-workspace"));
        await page.getByRole("button", { name: `Close split chat ${companion}` }).click();
      }
      await expect(column).toBeVisible();
      await expect(column.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(draft);
      await expect(column.locator(".terminal-dock")).toBeVisible();
      await expectComposerReserved(column);
      await app.expectNoViewportOverflow();
      expect(app.rendererErrors).toEqual([]);
      const screenshot = testInfo.outputPath(`composer-after-${navigation}.png`);
      await page.screenshot({ path: screenshot, animations: "disabled" });
      await testInfo.attach(`composer-after-${navigation}`, { path: screenshot, contentType: "image/png" });
    } finally { await app.close(); }
  });
}
