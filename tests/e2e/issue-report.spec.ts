// @inertia-e2e-resource isolated
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { portableNodeExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const FIXED_NOW = Date.parse("2026-10-03T16:20:00.000Z");

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function openReport(app: AppFixture): Promise<void> {
  await app.page.clock.setFixedTime(FIXED_NOW);
  await app.page.getByRole("button", { name: "Settings", exact: true }).click();
  await app.page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Help", exact: true }).click();
  await expect(app.page.getByRole("textbox", { name: "What happened", exact: true })).toBeEnabled();
}

async function expectLayoutHolds(app: AppFixture): Promise<void> {
  await app.expectNoViewportOverflow();
  const layout = await app.page.locator(".issue-report").evaluate((element) => {
    const content = element.closest(".settings-content")!.getBoundingClientRect();
    const report = element.getBoundingClientRect();
    const outside = [...element.querySelectorAll("button, input, textarea, select")].flatMap((control) => {
      const rect = control.getBoundingClientRect();
      return rect.width === 0 || (rect.left >= report.left - 1 && rect.right <= report.right + 1) ? [] : [control.textContent || control.getAttribute("aria-label") || control.tagName];
    });
    const nested = [...element.querySelectorAll("button")].filter((button) => button.parentElement?.closest("button")).length;
    return { inside: report.left >= content.left - 1 && report.right <= content.right + 1, width: content.width, outside, nested };
  });
  expect(layout.inside).toBe(true);
  expect(layout.width).toBeLessThanOrEqual(862);
  expect(layout.outside).toEqual([]);
  expect(layout.nested).toBe(0);
  const gutters = await app.page.locator(".issue-report").evaluate((element) => {
    const report = element.getBoundingClientRect();
    const view = element.closest(".settings-view")!.getBoundingClientRect();
    const navigation = document.querySelector(".settings-navigation")!.getBoundingClientRect();
    const besideNavigation = navigation.bottom > report.top + 1;
    return { minimum: besideNavigation ? 20 : 14, left: report.left - (besideNavigation ? navigation.right : view.left), right: view.right - report.right };
  });
  expect(gutters.left).toBeGreaterThanOrEqual(gutters.minimum);
  expect(gutters.right).toBeGreaterThanOrEqual(gutters.minimum);
}

async function expectAlignedRow(page: Page, selector: string): Promise<void> {
  await page.mouse.move(0, 0);
  await expect.poll(() => page.locator(selector).first().evaluate((row) => {
    const centres = [...row.querySelectorAll(":scope > button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    return Math.max(...centres) - Math.min(...centres);
  })).toBeLessThan(0.5);
}

test("writes a plain report, previews the exact public issue and keeps it reviewable", async ({ browserName: _browserName }, info) => {
  test.setTimeout(150_000);
  const app = await createAppFixture({
    name: "issue-report",
    initialState: "conversation",
    beforeLaunch: async ({ testDirectory }) => {
      portableNodeExecutable(join(testDirectory, "provider-bin"), "gh");
      await writeFile(join(testDirectory, "data", "auth"), "process.exit(0);\n", "utf8");
    },
  });
  const page = app.page;
  try {
    await app.resizeWindow(1440, 920);
    await openReport(app);
    await expect(page.getByRole("heading", { name: "Report an issue", exact: true, level: 3 })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Steps to reproduce (optional)", exact: true })).toBeEnabled();
    await expect(page.getByRole("checkbox", { name: /^Attach diagnostics/u })).toBeChecked();
    const provider = page.getByRole("combobox", { name: "Provider", exact: true });
    await expect(provider).toHaveCSS("appearance", "base-select");
    await provider.click();
    await expect.poll(() => provider.evaluate((element) => element.matches(":open"))).toBe(true);
    await expect(provider.getByRole("option", { name: "Not sure" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(provider).toBeFocused();
    const form = await page.locator(".issue-report").evaluate((element) => {
      const field = element.querySelector("textarea")!.getBoundingClientRect();
      const primary = element.querySelector(".issue-report-actions .primary-button")!.getBoundingClientRect();
      const storage = [...document.querySelectorAll("button")].find((button) => button.textContent === "View storage & backups")!.getBoundingClientRect();
      return { aligned: Math.abs(field.right - primary.right) < 1, below: storage.top > element.getBoundingClientRect().bottom };
    });
    expect(form).toEqual({ aligned: true, below: true });
    await expect(page.locator(".issue-report-github")).toHaveCount(0);
    await expectLayoutHolds(app);
    for (const theme of ["light", "dark"] as const) {
      await setAppearanceInPlace(app, theme);
      await capture(page, info, `issue-report-form-${theme}-wide`);
    }
    await app.resizeWindow(1000, 800);
    await expectLayoutHolds(app);
    for (const theme of ["light", "dark"] as const) {
      await setAppearanceInPlace(app, theme);
      await capture(page, info, `issue-report-form-${theme}-narrow`);
    }
    await app.resizeWindow(760, 600);
    await expectLayoutHolds(app);
    await capture(page, info, "issue-report-form-dark-760x600");

    await app.resizeWindow(1440, 920);
    await page.getByRole("button", { name: "Preview issue" }).click();
    await expect(page.getByText("Describe what happened in at least 10 characters.", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "What happened", exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("textbox", { name: "What happened", exact: true })).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "What happened", exact: true }).fill("After cancelling a running chat, sending the next message leaves it waiting. I expected the next message to start normally.");
    await page.getByRole("textbox", { name: "Steps to reproduce (optional)", exact: true }).fill("1. Start a turn\n2. Cancel it\n3. Send another message");
    await provider.selectOption("claude");
    await page.getByRole("button", { name: "Preview issue" }).click();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("After cancelling a running chat, sending the next message leaves it waiting. I expected the next message to start…");
    const body = page.getByRole("textbox", { name: "Body", exact: true });
    await expect(body).toHaveValue(/## Steps to reproduce\n\n1\. Start a turn\n2\. Cancel it\n3\. Send another message/u);
    await expect(body).toHaveValue(/## Environment\n\n- Inertia: \S+ \((?:stable|canary)\)\n- OS: /u);
    await expect(body).toHaveValue(/- Provider: claude /u);
    await expect(body).toHaveValue(/- Inertia: \S+ \(stable\)\n- OS: (?:macOS|Windows|Linux) [0-9]/u);
    await expect(body).toHaveValue(/## Diagnostics\n\n(?:Recent diagnostics from the last 24 hours, pseudonymised by Inertia:\n```text\n\{|No diagnostics were recorded in the last 24 hours\.)/u);
    const bodyPath = info.outputPath("issue-report-body.md");
    await writeFile(bodyPath, await body.inputValue(), "utf8");
    await info.attach("issue-report-body.md", { path: bodyPath, contentType: "text/markdown" });
    await expect(page.getByRole("button", { name: "Create on GitHub" })).toBeEnabled();
    await expectAlignedRow(page, ".issue-report-actions");
    await page.getByRole("button", { name: "Open GitHub manually" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Create on GitHub" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Create on GitHub" })).toHaveCSS("outline-style", "solid");
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Cancelled chat stays waiting on the next message");
    await expectLayoutHolds(app);
    for (const theme of ["light", "dark"] as const) {
      await setAppearanceInPlace(app, theme);
      await capture(page, info, `issue-report-preview-${theme}-wide`);
    }
    await page.locator(".issue-report").getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "What happened", exact: true })).toBeFocused();
    await expect(page.getByRole("textbox", { name: "What happened", exact: true })).toHaveValue(/^After cancelling a running chat/u);
    await page.getByRole("button", { name: "Preview issue" }).click();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Cancelled chat stays waiting on the next message");

    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Help", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Cancelled chat stays waiting on the next message");
    await app.resizeWindow(1000, 800);
    await expectLayoutHolds(app);
    for (const theme of ["light", "dark"] as const) {
      await setAppearanceInPlace(app, theme);
      await capture(page, info, `issue-report-preview-${theme}-narrow`);
    }
    await app.resizeWindow(760, 600);
    await expectLayoutHolds(app);
    await capture(page, info, "issue-report-preview-dark-760x600");
  } finally { await app.close(); }
});

test("says GitHub CLI is not signed in before the user writes", async ({ browserName: _browserName }, info) => {
  const app = await createAppFixture({
    name: "issue-report-signed-out",
    initialState: "conversation",
    beforeLaunch: async ({ testDirectory }) => {
      portableNodeExecutable(join(testDirectory, "provider-bin"), "gh");
      await writeFile(join(testDirectory, "data", "auth"), "process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\\n');\nprocess.exit(1);\n", "utf8");
    },
  });
  try {
    await app.resizeWindow(1440, 920);
    await openReport(app);
    await expect(app.page.locator(".issue-report-github")).toHaveText("GitHub CLI is not signed in. Run gh auth login in a terminal, or open GitHub manually.");
    await expectLayoutHolds(app);
    for (const theme of ["light", "dark"] as const) {
      await setAppearanceInPlace(app, theme);
      await capture(app.page, info, `issue-report-signed-out-${theme}-wide`);
    }
  } finally { await app.close(); }
});

const FAKE_GH_AUTH = `const fs = require("fs");
fs.writeFileSync("auth-checked", "");
if (fs.existsSync("auth-fail")) {
  process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\\n");
  process.exit(1);
}
`;

const FAKE_GH_ISSUE = `const fs = require("fs");
if (process.argv[2] === "list") process.exit(0);
if (fs.existsSync("issue-ok")) {
  process.stdout.write("https://github.com/eduardtomas1/inertia/issues/999\\n");
  process.exit(0);
}
setTimeout(() => {
  process.stderr.write("error connecting to api.github.com\\ncheck your internet connection or https://githubstatus.com\\n");
  process.exit(1);
}, 2500);
`;

test("walks a report through failed, submitting, uncertain, retired and submitted with a stub GitHub CLI", async ({ browserName: _browserName }, info) => {
  test.setTimeout(150_000);
  let dataDirectory = "";
  const app = await createAppFixture({
    name: "issue-report-publication",
    initialState: "conversation",
    beforeLaunch: async ({ testDirectory }) => {
      dataDirectory = join(testDirectory, "data");
      portableNodeExecutable(join(testDirectory, "provider-bin"), "gh");
      await writeFile(join(dataDirectory, "auth"), FAKE_GH_AUTH, "utf8");
      await writeFile(join(dataDirectory, "issue"), FAKE_GH_ISSUE, "utf8");
    },
  });
  const page = app.page;
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  const create = page.getByRole("button", { name: "Create on GitHub" });
  const describe = async (text: string): Promise<void> => {
    await page.getByRole("textbox", { name: "What happened", exact: true }).fill(text);
    await page.getByRole("button", { name: "Preview issue" }).click();
    await expect(title).toBeFocused();
  };
  try {
    await app.resizeWindow(1440, 920);
    await openReport(app);
    await setAppearanceInPlace(app, "dark");
    await describe("The chat stays waiting after a cancelled turn.");

    await expect.poll(() => existsSync(join(dataDirectory, "auth-checked"))).toBe(true);
    await expect(page.locator(".issue-report-github")).toHaveCount(0);
    await writeFile(join(dataDirectory, "auth-fail"), "", "utf8");
    await create.click();
    await expect(page.getByRole("alert")).toHaveText("GitHub CLI is not signed in. Run gh auth login in a terminal, or open GitHub manually.");
    await expect(create).toBeEnabled();
    await expectLayoutHolds(app);
    await capture(page, info, "issue-report-failed-dark-wide");

    await rm(join(dataDirectory, "auth-fail"));
    await create.click();
    await expect(page.locator(".issue-report-actions .primary-button")).toHaveText("Creating…");
    await capture(page, info, "issue-report-submitting-dark-wide");
    const check = page.getByRole("button", { name: "Check submission" });
    await expect(check).toBeFocused({ timeout: 30_000 });
    await expect(page.locator(".issue-report-pending")).toContainText("GitHub could not be reached. GitHub may still have received the issue.");
    await expect(create).toHaveCount(0);
    await expectLayoutHolds(app);
    await capture(page, info, "issue-report-uncertain-dark-wide");

    await check.click();
    await expect(page.locator(".issue-report-pending")).toContainText("No matching issue is visible yet.");
    await expect(check).toBeFocused();
    await page.getByRole("button", { name: "Retire this report" }).click();
    await expect(page.getByRole("group", { name: "Retire uncertain publication?" })).toBeFocused();
    await expectLayoutHolds(app);
    await capture(page, info, "issue-report-retire-dark-wide");
    await page.getByRole("button", { name: "Confirm retirement" }).click();
    await expect(page.locator(".issue-report-messages")).toContainText("Publication tracking retired.");
    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute("readonly", "");
    await expectLayoutHolds(app);
    await capture(page, info, "issue-report-retired-dark-wide");

    await page.getByRole("button", { name: "Start another report" }).click();
    await describe("Sending a message after a cancelled turn never starts.");
    await writeFile(join(dataDirectory, "issue-ok"), "", "utf8");
    await create.click();
    await expect(page.getByRole("button", { name: "View issue" })).toBeFocused();
    await expect(page.locator(".issue-report-messages")).toContainText("Issue created in eduardtomas1/inertia.");
    await expectLayoutHolds(app);
    await capture(page, info, "issue-report-submitted-dark-wide");
  } finally { await app.close(); }
});
