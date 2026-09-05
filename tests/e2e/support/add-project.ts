import { expect, type Page } from "@playwright/test";

/** Completes the local source flow using the fixture's native folder picker. */
export async function openLocalProjectFromDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Local folder/u }).click();
  await dialog.getByRole("button", { name: "Browse", exact: true }).click();
  await dialog.getByRole("button", { name: "Open project", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
