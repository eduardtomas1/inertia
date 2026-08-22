import { expect, type Locator, type Page } from "@playwright/test";

export async function ensureWorkspaceTools(page: Page): Promise<Locator> {
  const panel = page.locator(".workspace-panel");
  if (!await panel.isVisible().catch(() => false)) {
    const opener = page.getByRole("button", { name: "Open workspace tools" });
    await expect.poll(async () =>
      await panel.isVisible().catch(() => false)
      || await opener.isEnabled().catch(() => false),
    ).toBe(true);
    if (!await panel.isVisible().catch(() => false)) await opener.click();
  }
  await panel.waitFor({ state: "visible" });
  return panel;
}

export async function selectWorkspaceTool(
  panel: Locator,
  name: string,
): Promise<void> {
  const tab = panel.locator(
    `[data-workspace-tab="${name.toLowerCase()}"]`,
  );
  if (await tab.isVisible().catch(() => false)) {
    await tab.click();
    return;
  }

  await panel.getByLabel("Choose workspace tool").click();
  await panel.getByRole("button", { name, exact: true }).click();
}

export async function openConversationPaneTool(
  pane: Locator,
  chatTitle: string,
  tab: "Changes" | "Files" | "Terminal" | "Goal" | "Preview",
): Promise<Locator> {
  const tools = pane.getByRole("complementary", { name: "Workspace tools" });
  if (!await tools.isVisible().catch(() => false)) {
    await pane.getByRole("button", {
      name: `Open tools for ${chatTitle}`,
    }).click();
  }
  await selectWorkspaceTool(tools, tab);
  return tools;
}
