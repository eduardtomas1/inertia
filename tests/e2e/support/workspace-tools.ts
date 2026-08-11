import type { Locator } from "@playwright/test";

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
