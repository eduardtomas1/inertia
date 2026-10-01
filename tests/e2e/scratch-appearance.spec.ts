// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";
import { createAppFixture } from "./support/app-fixture";

// Persisted-chat fixtures exercise the actual renderer and theme application.
// Creation/provider execution is covered separately in scratch-chat.
for (const theme of ["light", "dark"] as const) {
  test(`shows a separate project-free section and selector in ${theme} appearance`, async () => {
    const info = test.info();
    const app = await createAppFixture({ name: `scratch-appearance-${theme}`, initialState: "conversation",
      beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
        try {
          const scratch = new ScratchWorkspace(store, join(testDirectory, "data"));
          const project = await scratch.ensureProject();
          await scratch.createConversation(project.id, "Plan a relaxed weekend", {});
          store.updateSettings({ theme });
        } finally { store.close(); }
      },
    });
    const { page } = app;
    try {
      await app.resizeWindow(1440, 1000);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { name: "No project 1", exact: true })).toBeVisible();
      await expect(page.getByText("Chat folder", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Start a new chat", exact: true }).click();
      await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
      await page.getByRole("textbox", { name: "Message" }).fill("Help me plan a relaxed weekend in a new city.");
      await app.expectNoViewportOverflow();
      await expect(page.getByText("The local service disconnected before finishing this request.", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`scratch-draft-${theme}.png`), animations: "disabled" });
      if (theme === "light") {
        await page.getByRole("button", { name: "Project", exact: true }).click();
        await expect(page.getByRole("option", { name: "No project", exact: true })).toHaveCount(1);
        await page.screenshot({ path: info.outputPath("scratch-project-selector.png"), animations: "disabled" });
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Filter work by project", exact: true }).click();
        await expect(page.getByRole("option", { name: "No project", exact: true })).toHaveCount(0);
        await page.keyboard.press("Escape");
      } else {
        await app.resizeWindow(1000, 800);
        await app.expectNoViewportOverflow();
        await page.screenshot({ path: info.outputPath("scratch-draft-narrow.png"), animations: "disabled" });
      }
      expect(app.rendererErrors).toEqual([]);
    } finally { await app.close(); }
  });
}
