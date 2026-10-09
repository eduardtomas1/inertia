import { expect, type Locator, type Page } from "@playwright/test";

export async function openComposerTools(scope: Page | Locator): Promise<void> {
  const toggles = scope.getByRole("button", { name: "More tools", exact: true });
  await expect(toggles.first()).toBeVisible();
  for (const toggle of await toggles.all()) {
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

export async function expectGitStatusInHeader(page: Page): Promise<void> {
  const header = page.locator(".workspace-header");
  await expect(header.getByRole("group", { name: "Git actions" })
    .or(header.getByRole("menuitem", { name: "Git actions", includeHidden: true }))
    .first()).toBeAttached();
}
