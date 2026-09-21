import { expect, type Locator, type Page } from "@playwright/test";

export function rightPanelToggle(page: Page): Locator {
  return page.locator("[data-panel-layout-controls] [data-right-panel-toggle]");
}

export async function ensureWorkspaceTools(page: Page): Promise<Locator> {
  const panel = page.locator(".workspace-panel");
  if (!await panel.isVisible({ timeout: 500 }).catch(() => false)) {
    const opener = rightPanelToggle(page);
    await expect.poll(async () =>
      await panel.isVisible({ timeout: 500 }).catch(() => false)
      || await opener.isEnabled({ timeout: 500 }).catch(() => false),
    ).toBe(true);
    if (!await panel.isVisible({ timeout: 500 }).catch(() => false)) {
      await opener.click();
    }
  }
  await panel.waitFor({ state: "visible" });
  return panel;
}

export async function closeWorkspaceTools(page: Page): Promise<void> {
  const toggle = rightPanelToggle(page);
  if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
}

export async function selectWorkspaceTool(
  panel: Locator,
  name: string,
): Promise<void> {
  const tabId = name === "Browser" ? "preview" : name.toLowerCase();
  const tab = panel.locator(`[data-workspace-tab="${tabId}"]`);
  if (await tab.isVisible().catch(() => false)) {
    await tab.click();
    return;
  }

  const launcher = panel.getByRole("group", { name: "Open a surface" });
  if (await launcher.isVisible().catch(() => false)) {
    await launcher.getByRole("button", { name: new RegExp(`^${name}`, "u") }).click();
  } else {
    await panel.getByRole("button", { name: "Add panel surface" }).click();
    await panel.page().getByRole("menu", { name: "Add panel surface" })
      .getByRole("menuitem", { name: new RegExp(`^${name}`, "u") })
      .click();
  }
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

export async function openConversationPaneTool(
  pane: Locator,
  chatTitle: string,
  tab: "Changes" | "Files" | "Terminal" | "Goal" | "Browser",
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
