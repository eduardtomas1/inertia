import { expect, type ElectronApplication, type Locator } from "@playwright/test";

export async function verifyFailureDiagnostics(
  diagnostics: Locator,
  capture: (name: string, target: Locator) => Promise<void>,
  clipboard: { electronApp: ElectronApplication; turnId: string; runId: string },
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
  await clipboard.electronApp.evaluate(({ clipboard }) => clipboard.writeText("before-diagnostics-copy"));
  const readClipboard = (): Promise<string> => clipboard.electronApp.evaluate(({ clipboard }) => clipboard.readText());
  await diagnostics.getByRole("button", { name: "Copy diagnostics" }).click();
  // Assert the durable native result, not a 1.5-second feedback label which a
  // busy desktop runner can miss. Feedback itself has a controlled DOM test.
  await expect.poll(readClipboard).toContain("Inertia turn failure diagnostics");
  const copied = await readClipboard();
  expect(copied).toContain(`Turn ID: ${clipboard.turnId}`);
  expect(copied).toContain(`Run ID: ${clipboard.runId}`);
  expect(copied).toContain("The provider connection closed before verification completed.");
  await capture("failed-diagnostics-expanded", diagnostics);
}
