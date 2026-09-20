import { type Locator } from "@playwright/test";

/**
 * Prompt presets and scratch prompts are rows in the composer's overflow menu.
 * Specs reach them through this helper so they do not encode which shape the
 * control currently has.
 */
export async function openComposerSurface(
  scope: Locator,
  name: "Prompt presets" | "Scratch prompts",
): Promise<void> {
  const direct = scope.getByRole("button", { name, exact: true });
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }
  await scope.getByRole("button", { name: "More composer options" }).click();
  await scope.getByRole("menuitem", { name }).click();
}

/** Reads a surface's summary line from the overflow, leaving the menu closed. */
export async function composerSurfaceSummary(
  scope: Locator,
  name: "Prompt presets" | "Scratch prompts",
): Promise<string> {
  await scope.getByRole("button", { name: "More composer options" }).click();
  const summary = (await scope.getByRole("menuitem", { name }).innerText()).trim();
  await scope.page().keyboard.press("Escape");
  return summary;
}
