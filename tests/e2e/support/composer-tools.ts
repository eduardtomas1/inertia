import { expect, type Locator, type Page } from "@playwright/test";

export async function openComposerTools(scope: Page | Locator): Promise<void> {
  const toggles = scope.getByRole("button", { name: "More tools", exact: true });
  await expect(toggles.first()).toBeVisible();
  for (const toggle of await toggles.all()) {
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

export async function expectComposerBranch(page: Page, branch?: string): Promise<void> {
  const button = page.getByRole("group", { name: "Chat checkout context" })
    .getByRole("button", branch ? { name: `Branch ${branch}`, exact: true } : { name: /^Branch /u });
  await expect(button).toBeVisible();
  if (branch) await expect(button).toContainText(branch);
}
