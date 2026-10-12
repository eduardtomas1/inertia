import { expect, type Locator, type Page } from "@playwright/test";

import type { ModelSelection } from "../../../src/shared/model-routing";

export async function verifyQuietTurnFooter(input: {
  page: Page;
  turn: Locator;
  selection: Pick<ModelSelection, "harnessId" | "backendProfileId" | "modelId" | "alias">;
  capture: (name: string, target: Locator) => Promise<void>;
}): Promise<{ runDetails: Locator; runDetailsToggle: Locator }> {
  const { page, turn, selection, capture } = input;
  const turnMetaPrimary = turn.locator(".turn-meta-primary");
  const runDetailsToggle = turn.getByRole("button", { name: "Run details" });
  const runDetails = turn.locator(".turn-run-details");
  const footerOpacity = (): Promise<string> =>
    turnMetaPrimary.evaluate((element) => getComputedStyle(element).opacity);
  await page.mouse.move(1, 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(footerOpacity).toBe("0");
  await runDetailsToggle.focus();
  await expect.poll(footerOpacity).toBe("1");
  await expect(turnMetaPrimary).not.toContainText("Completed");
  await expect(turnMetaPrimary).toContainText("Worked 42s");
  await expect(turnMetaPrimary).not.toContainText(selection.harnessId);
  await expect(turnMetaPrimary).not.toContainText(selection.backendProfileId);
  await expect(turnMetaPrimary).not.toContainText(selection.modelId);
  await expect(runDetailsToggle).toHaveAttribute("aria-expanded", "false");
  await runDetailsToggle.click();
  await expect(runDetailsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(runDetails).toBeVisible();
  await expect(runDetails.getByRole("list", { name: "Agent work transcript" })).toBeVisible();
  await expect(runDetails).not.toContainText("Harness ID");
  const diagnosticsToggle = runDetails.getByRole("button", { name: "Diagnostics" });
  await expect(diagnosticsToggle).toHaveAttribute("aria-expanded", "false");
  await diagnosticsToggle.click();
  await expect(diagnosticsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(runDetails).toContainText("Harness ID");
  await expect(runDetails).toContainText(selection.harnessId);
  await expect(runDetails).toContainText("Requested alias");
  await expect(runDetails).toContainText(selection.alias ?? "Not requested");
  await expect(runDetails).toContainText("Session continuation");
  await capture("completed-run-details", turn.locator(".turn-meta"));
  await runDetailsToggle.click();
  await expect(runDetailsToggle).toHaveAttribute("aria-expanded", "false");
  return { runDetails, runDetailsToggle };
}
