// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { createAppFixture } from "./support/app-fixture";

test("preserves the private report chat and requires a reviewed preview before publication", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({ name: "issue-report", initialState: "conversation" });
  const page = app.page;
  try {
    await app.resizeWindow(1440, 1050);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Light", exact: true }).click();
    await page.getByRole("button", { name: "Report an issue", exact: true }).click();
    await page.getByLabel("What happened?").fill("After cancelling a running chat, sending the next message leaves it waiting. I expected the next message to start normally. Steps: start a turn, cancel it, then send another message.");
    const form = testInfo.outputPath("issue-report-describe.png");
    await page.screenshot({ path: form, animations: "disabled" });
    await testInfo.attach("Report description and controls", { path: form, contentType: "image/png" });
    await page.getByRole("button", { name: "Create private report chat" }).click();
    await expect(page.getByLabel("Private report chat")).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit issue to GitHub" })).toHaveCount(0);
    await page.getByRole("button", { name: "Edit issue preview" }).click();
    await page.getByLabel("Issue title").fill("Cancelled chat remains waiting on the next message");
    await page.getByRole("button", { name: "Save and review preview" }).click();
    await expect(page.getByRole("button", { name: "Submit issue to GitHub" })).toBeEnabled();
    const chat = testInfo.outputPath("issue-report-chat.png");
    await page.getByRole("heading", { name: "Report an issue", exact: true, level: 3 }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: chat, animations: "disabled" });
    await testInfo.attach("Saved private report chat", { path: chat, contentType: "image/png" });
    await page.getByRole("button", { name: "Submit issue to GitHub" }).scrollIntoViewIfNeeded();
    const preview = testInfo.outputPath("issue-report-preview.png");
    await page.screenshot({ path: preview, animations: "disabled" });
    await testInfo.attach("Reviewed public issue preview", { path: preview, contentType: "image/png" });
    // External publication is exercised with mocks in the server tests, never this real desktop.
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await page.getByRole("button", { name: "Report an issue", exact: true }).click();
    await expect(page.getByText("Cancelled chat remains waiting on the next message", { exact: true })).toBeVisible();
    await app.resizeWindow(900, 850);
    await app.expectNoViewportOverflow();
    await expect(page.getByRole("button", { name: "Submit issue to GitHub" })).toBeEnabled();
  } finally { await app.close(); }
});
