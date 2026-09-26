import { expect, type Locator } from "@playwright/test";

export async function expectFlatSettingsSections(settings: Locator): Promise<void> {
  // Observe the actual cascade. The former source-text negatives passed even
  // after the settings rules were deleted; positive spacing prevents that.
  await expect(settings.getByText("Make it yours", { exact: true })).toHaveCount(0);
  await expect(settings.getByText("Keep the workspace calm, capable, and predictable.", { exact: true }))
    .toHaveCount(0);
  await expect(settings.getByText("Personalize your workspace", { exact: true })).toHaveCount(0);
  await expect(settings.locator(".settings-navigation-heading")).toHaveCount(0);
  const toolbar = settings.locator(".settings-toolbar").first();
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveCSS("justify-content", "flex-end");
  await expect(toolbar).toHaveCSS("margin-bottom", "16px");
  // The working indicator intentionally outlines its specialized switch group.
  const rows = settings.locator(".settings-rows:not(.working-indicator-switches)");
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) await expect(row).toHaveCSS("border-top-width", "0px");
  const cards = settings.locator(".settings-card");
  expect(await cards.count()).toBeGreaterThan(0);
  for (const card of await cards.all()) {
    await expect(card).toBeVisible();
    const style = await card.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        spacing: Number.parseFloat(computed.marginBottom),
        border: Number.parseFloat(computed.borderTopWidth),
        background: computed.backgroundColor,
        shadow: computed.boxShadow,
      };
    });
    expect(style.spacing).toBeGreaterThan(0);
    expect(style.border).toBe(0);
    expect(style.background).toBe("rgba(0, 0, 0, 0)");
    expect(style.shadow).toBe("none");
  }
}
