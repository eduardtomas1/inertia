// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { createAppFixture } from "./support/app-fixture";

test("preserves the private report chat and requires a reviewed preview before publication", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({ name: "issue-report", initialState: "conversation" });
  const page = app.page;
  try {
    await app.resizeWindow(1440, 1050);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const theme of ["Dark", "Light"]) {
      await page.getByRole("button", { name: "General", exact: true }).click();
      await page.getByRole("radio", { name: theme, exact: true }).click();
      await page.getByRole("button", { name: "Report an issue", exact: true }).click();
      await expect(page.getByLabel("What happened?")).toBeEnabled();
      await app.expectNoViewportOverflow();
      const layout = await page.locator(".issue-report").evaluate((element) => {
        const content = element.closest(".settings-content")!.getBoundingClientRect();
        const report = element.getBoundingClientRect();
        const primary = element.querySelector(".issue-report-create-actions .primary-button")!.getBoundingClientRect();
        const field = element.querySelector("textarea")!.getBoundingClientRect();
        return { left: report.left - content.left, right: content.right - report.right, aligned: Math.abs(field.right - primary.right) < 1 };
      });
      expect(layout.left).toBeGreaterThanOrEqual(20);
      expect(layout.right).toBeGreaterThanOrEqual(20);
      expect(layout.aligned).toBe(true);
      const path = testInfo.outputPath(`issue-report-${theme.toLowerCase()}.png`);
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach(`issue-report-${theme.toLowerCase()}`, { path, contentType: "image/png" });
    }
    // Settings menus must stay in Chromium's top layer on Linux too.
    for (const name of ["Report agent and model", "Report reasoning", "Diagnostic scope"]) {
      const control = page.getByRole("combobox", { name, exact: true });
      await expect(control).toHaveCSS("appearance", "base-select");
      if (await control.isDisabled()) continue;
      await control.click();
      await expect.poll(() => control.evaluate((element) => element.matches(":open"))).toBe(true);
      await expect(control.getByRole("option").last()).toBeVisible();
      if (name === "Diagnostic scope") {
        const picker = testInfo.outputPath("issue-report-scope-picker.png");
        await page.screenshot({ path: picker, animations: "disabled" });
        await testInfo.attach("In-page issue-report picker", { path: picker, contentType: "image/png" });
      }
      await page.keyboard.press("Escape");
      await expect(control).toBeFocused();
    }
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
    const actionAlignment = await page.locator(".issue-report-publication-actions").evaluate((element) => {
      const primary = element.querySelector(".primary-button")!.getBoundingClientRect();
      const secondary = element.querySelector(".secondary-button")!.getBoundingClientRect();
      return Math.abs(primary.top + primary.height / 2 - secondary.top - secondary.height / 2);
    });
    expect(actionAlignment).toBeLessThan(1);
    await expect(page.locator(".issue-report-footer").getByRole("button", { name: "Start another draft" })).toBeVisible();
    await page.getByRole("button", { name: "Open GitHub manually" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Submit issue to GitHub" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Submit issue to GitHub" })).toHaveCSS("outline-style", "solid");
    const chat = testInfo.outputPath("issue-report-chat.png");
    await page.getByRole("heading", { name: "Report an issue", exact: true, level: 3 }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: chat, animations: "disabled" });
    await testInfo.attach("Saved private report chat", { path: chat, contentType: "image/png" });
    await page.getByRole("heading", { name: "Public issue preview", exact: true }).evaluate((element) => element.scrollIntoView({ block: "start" }));
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
    const overflowing = await page.locator(".issue-report").evaluate((element) => {
      const container = element.getBoundingClientRect();
      return [...element.querySelectorAll("button, input, textarea, select")].flatMap((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width === 0 || rect.left >= container.left - 1 && rect.right <= container.right + 1 ? []
          : [{ text: control.textContent, left: rect.left, right: rect.right, container: [container.left, container.right] }];
      });
    });
    const narrow = testInfo.outputPath("issue-report-narrow.png");
    await page.screenshot({ path: narrow, animations: "disabled" });
    await testInfo.attach("issue-report-narrow", { path: narrow, contentType: "image/png" });
    expect(overflowing).toEqual([]);
  } finally { await app.close(); }
});
