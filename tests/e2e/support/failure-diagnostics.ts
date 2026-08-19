import { expect, type Locator } from "@playwright/test";

export async function verifyFailureDiagnostics(
  diagnostics: Locator,
  capture: (name: string, target: Locator) => Promise<void>,
): Promise<void> {
  await expect(diagnostics).toContainText(
    "The provider connection closed before verification completed.",
  );
  const toggle = diagnostics.locator(".turn-failure-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(diagnostics.getByRole("heading", {
    name: "Provider & process",
  })).toBeVisible();
  await expect(diagnostics.getByRole("heading", {
    name: "Recent provider context",
  })).toBeVisible();
  await diagnostics.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(diagnostics.getByRole("button", {
    name: "Diagnostics copied",
  })).toBeVisible();
  await capture("failed-diagnostics-expanded", diagnostics);
}
