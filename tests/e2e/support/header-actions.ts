import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The header keeps the controls that report state and moves the rest into one
 * overflow menu. Specs reach a control through this helper so they do not have
 * to know which shape it currently has.
 */
export async function headerAction(
  page: Page,
  name: string | RegExp,
  exact = true,
): Promise<Locator> {
  const options = typeof name === "string" ? { name, exact } : { name };
  const direct = page.getByRole("button", options);
  if (await direct.isVisible().catch(() => false)) return direct;
  const more = page.getByRole("button", { name: "More workspace actions" });
  await expect(more).toBeVisible();
  if (await more.getAttribute("aria-expanded") !== "true") await more.click();
  return page.getByRole("menuitem", options);
}

/** Leaves the overflow menu closed after an assertion-only visit. */
export async function closeHeaderOverflow(page: Page): Promise<void> {
  const more = page.getByRole("button", { name: "More workspace actions" });
  if (await more.getAttribute("aria-expanded").catch(() => null) === "true") {
    await page.keyboard.press("Escape");
  }
}
