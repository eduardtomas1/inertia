import { expect, type Locator, type Page } from "@playwright/test";

export async function openComposerTools(scope: Page | Locator): Promise<void> {
  const toggles = scope.getByRole("button", { name: "More tools", exact: true });
  await expect(toggles.first()).toBeVisible();
  for (const toggle of await toggles.all()) {
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}
