import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

test("uses the command palette surface for project search and keeps keyboard focus inside", async () => {
  const app = await createAppFixture({ name: "project-search", initialState: "conversation", windowDisplay: "primary" });
  try {
    await app.resizeWindow(1100, 760);
    const page = app.page;
    const trigger = page.getByRole("button", { name: "Filter work by project" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Choose project filter" });
    await expect(dialog).toHaveClass(/command-palette/u);
    const search = dialog.getByRole("combobox", { name: "Search projects" });
    await expect(search).toBeFocused();
    await search.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: /^Project actions for/u }).last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(search).toBeFocused();
    await search.fill("missing-project");
    await expect(dialog.getByText("No matching projects")).toBeVisible();
    await search.fill("");
    await search.press("Home");
    await search.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await app.resizeWindow(760, 600);
    // The compact drawer can be hidden after the resize; open it explicitly.
    const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
    await expect(page.locator(".sidebar")).toHaveAttribute("aria-hidden", "true");
    await page.getByRole("button", { name: "Toggle project navigation" }).click();
    await expect(sidebar).toBeVisible();
    await trigger.click();
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await search.press("Escape");
    await expect(trigger).toBeFocused();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

test("shows animated provider compaction and honors reduced motion", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({ name: "context-compaction", initialState: "conversation", windowDisplay: "primary" });
  try {
    const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    const conversation = store.shellSnapshot().conversations[0]!;
    const { turn } = store.beginAgentTurn({
      conversationId: conversation.id, runId: "compaction-visual-run", content: "Review the remaining changes and check the implementation.",
      providerId: "codex", modelSelection: conversation.modelSelection,
      reasoningEffort: "high", interactionMode: "build", accessMode: "supervised", configurationRevision: conversation.modelSelection.backendConfigurationRevision, association: "authoritative",
    });
    const now = new Date().toISOString();
    store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: now, updatedAt: now });
    store.updateConversation(conversation.id, { status: "running", title: "Review the remaining changes" });
    store.updateSettings({ theme: "dark" });
    store.addActivity({ conversationId: conversation.id, turnId: turn.id, runId: turn.runId, kind: "status", title: "Context compaction", status: "running", detail: null });
    store.selectConversation(conversation.id);
    store.close();
    await app.resizeWindow(1100, 760);
    await app.page.reload();
    const status = app.page.locator('[data-active-agent-phase="compacting"] .turn-working-status');
    await expect(status).toHaveText("Compacting context…");
    const tools = app.page.getByRole("button", { name: "Close workspace tools" });
    if (await tools.isVisible()) {
      await tools.click();
      await expect(app.page.locator(".workspace-panel")).toBeHidden();
    }
    const icon = status.locator(".context-compaction-icon > g");
    await expect.poll(() => icon.evaluate((node) => node.getAnimations().some((animation) => animation.playState === "running"))).toBe(true);
    const screenshot = testInfo.outputPath("inertia-context-compaction.png");
    await app.page.screenshot({ path: screenshot });
    await testInfo.attach("context-compaction", { path: screenshot, contentType: "image/png" });
    await app.page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => icon.evaluate((node) => node.getAnimations().length)).toBe(0);
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
