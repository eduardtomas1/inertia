import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

test("keeps compact Work sidebar geometry", async ({
  browserName: _browserName,
}, testInfo) => {
  const app = await createAppFixture({
    name: "work-sidebar-visual",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const databasePath = join(testDirectory, "data", "inertia.sqlite");
      const store = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      const seededSnapshot = store.shellSnapshot();
      const project = seededSnapshot.projects[0]!;
      const recent = store.updateConversation(seededSnapshot.conversations[0]!.id, {
        title: "Polish compact Work rows",
        branch: "codex/compact-work-tab",
      });
      const yesterday = store.createConversation(
        project.id,
        "Review provider metadata",
        { providerId: "claude", branch: "main", activate: false },
      );
      store.createConversation(
        project.id,
        "Validate Cursor handoff",
        { providerId: "cursor", branch: "cursor/provider-icon", activate: false },
      );
      store.createConversation(
        project.id,
        "Inspect Kimi ACP bridge",
        { providerId: "kimi", branch: "kimi/acp-bridge", activate: false },
      );
      store.createConversation(
        project.id,
        "Check OpenCode packaging",
        { providerId: "opencode", branch: "opencode/offline-assets", activate: false },
      );
      const earlier = store.createConversation(
        project.id,
        "Investigate keyboard focus behavior",
        { branch: "fix/sidebar-focus", activate: false },
      );
      const done = store.createConversation(
        project.id,
        "Remove redundant status filters",
        { branch: "codex/filter-cleanup", activate: false },
      );
      store.settleConversation(done.id, true);
      store.updateSettings({
        sidebarMode: "activity",
        providerIdentityLabels: {
          codex: "OpenAI",
          claude: "Anthropic",
          cursor: "Cursor",
          kimi: "Kimi Code",
          opencode: "OpenCode",
        },
      });
      store.selectConversation(recent.id);
      store.close();

      const database = new Database(databasePath);
      const yesterdayAt = new Date();
      yesterdayAt.setDate(yesterdayAt.getDate() - 1);
      const earlierAt = new Date();
      earlierAt.setDate(earlierAt.getDate() - 5);
      database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(yesterdayAt.toISOString(), yesterday.id);
      database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(earlierAt.toISOString(), earlier.id);
      database.close();
    },
  });

  try {
    await app.resizeWindow(1100, 760);
    const sidebar = app.page.getByRole("complementary", {
      name: "Project navigation",
      exact: true,
    });
    await expect(sidebar.getByRole("button", { name: "Work", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    const row = sidebar.getByRole("button", { name: /^Polish compact Work rows,/u });
    await expect(row).toBeVisible();
    const rowBox = await row.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.height).toBeGreaterThanOrEqual(42);
    expect(rowBox!.height).toBeLessThanOrEqual(48);
    const statusCue = row.locator('[data-work-status="idle"]');
    await expect(statusCue.locator("svg.lucide-minus")).toBeVisible();
    const statusBox = await statusCue.boundingBox();
    expect(statusBox).not.toBeNull();
    expect(statusBox!.width).toBeCloseTo(11, 3);
    expect(statusBox!.height).toBeCloseTo(11, 3);
    for (const providerId of ["codex", "claude", "cursor", "kimi", "opencode"]) {
      const icon = sidebar.locator(
        `.provider-brand-icon[data-provider-id="${providerId}"][data-provider-icon-kind="official"]`,
      ).first();
      await expect(icon).toBeVisible();
      const box = await icon.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeCloseTo(15, 3);
      expect(box!.height).toBeCloseTo(15, 3);
      const imageSize = await icon.locator("img").first().evaluate((image) => ({
        naturalWidth: (image as HTMLImageElement).naturalWidth,
        naturalHeight: (image as HTMLImageElement).naturalHeight,
      }));
      expect(imageSize.naturalWidth).toBeGreaterThan(0);
      expect(imageSize.naturalHeight).toBeGreaterThan(0);
      expect(await icon.locator("img").first().getAttribute("src"))
        .not.toMatch(/^https?:/u);
    }
    await expect(sidebar.locator(
      '.provider-brand-icon[data-provider-id="claude"]',
    ).first()).toHaveCSS("background-color", "rgb(255, 255, 255)");

    const defaultLightScreenshot = testInfo.outputPath(
      "chat-index-default-light-1100x760.png",
    );
    await app.page.screenshot({
      animations: "disabled",
      path: defaultLightScreenshot,
    });
    await testInfo.attach("chat-index-default-light-1100x760", {
      path: defaultLightScreenshot,
      contentType: "image/png",
    });

    const sidebarHandle = app.page.getByRole("separator", {
      name: "Resize project navigation",
    });
    await sidebarHandle.focus();
    await sidebarHandle.press("Home");
    await expect(sidebarHandle).toHaveAttribute("aria-valuenow", "220");
    const narrowState = await row.locator(".activity-thread-branch-meta")
      .evaluate((branch) => {
        const sidebarElement = branch.closest(".sidebar");
        return {
          branchDisplay: getComputedStyle(branch).display,
          sidebarWidth: sidebarElement?.getBoundingClientRect().width,
        };
      });
    expect(narrowState).toMatchObject({
      branchDisplay: "none",
      sidebarWidth: 220,
    });
    await expect(row.locator(".activity-thread-branch-meta")).toBeHidden();
    const narrowLightScreenshot = testInfo.outputPath(
      "chat-index-narrow-light-220px.png",
    );
    await app.page.screenshot({
      animations: "disabled",
      path: narrowLightScreenshot,
    });
    await testInfo.attach("chat-index-narrow-light-220px", {
      path: narrowLightScreenshot,
      contentType: "image/png",
    });

    await app.resizeWindow(1440, 900);
    await sidebarHandle.press("End");
    await expect(sidebarHandle).toHaveAttribute("aria-valuenow", "420");
    await expect(row.locator(".activity-thread-branch-meta")).toBeVisible();

    await app.page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
      document.documentElement.style.colorScheme = "dark";
    });
    await expect(sidebar.locator(
      '.provider-brand-icon[data-provider-id="codex"] .provider-brand-icon-source',
    ).first()).toHaveCSS("filter", "invert(1)");
    await expect(sidebar.locator(
      '.provider-brand-icon[data-provider-id="kimi"] .provider-brand-icon-source',
    ).first()).toHaveCSS("filter", "invert(1)");
    await expect(sidebar.locator(
      '.provider-brand-icon[data-provider-id="claude"]',
    ).first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    for (const providerId of ["cursor", "opencode"]) {
      const icon = sidebar.locator(
        `.provider-brand-icon[data-provider-id="${providerId}"]`,
      ).first();
      await expect(icon.locator(".provider-brand-icon-source.is-light"))
        .toBeHidden();
      await expect(icon.locator(".provider-brand-icon-source.is-dark"))
        .toBeVisible();
    }
    const wideDarkScreenshot = testInfo.outputPath(
      "chat-index-wide-dark-420px.png",
    );
    await app.page.screenshot({
      animations: "disabled",
      path: wideDarkScreenshot,
    });
    await testInfo.attach("chat-index-wide-dark-420px", {
      path: wideDarkScreenshot,
      contentType: "image/png",
    });
    await expect(sidebar.getByRole("group", { name: "Filter conversations" }))
      .toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "Earlier 1" }))
      .toHaveAttribute("aria-expanded", "false");
    await expect(sidebar.getByRole("button", { name: "Done 1" }))
      .toHaveAttribute("aria-expanded", "false");
    expect(await sidebar.locator(".project-list").evaluate((element) => (
      element.scrollWidth <= element.clientWidth
    ))).toBe(true);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
