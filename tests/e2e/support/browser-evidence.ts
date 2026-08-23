import { expect, type Locator, type TestInfo } from "@playwright/test";

import type { AppFixture } from "./app-fixture";

interface VerifyBrowserEvidenceOptions {
  app: AppFixture;
  page: AppFixture["page"];
  testInfo: TestInfo;
  primary: Locator;
  primaryPreview: Locator;
  secondaryPreview: Locator;
  primaryConversationId: string;
  typeDestinationUrl: string;
}

export async function verifyBrowserEvidence({
  app,
  page,
  testInfo,
  primary,
  primaryPreview,
  secondaryPreview,
  primaryConversationId,
  typeDestinationUrl,
}: VerifyBrowserEvidenceOptions): Promise<void> {
  await expect(app.electronApp.evaluate(
    async (_electron, conversationId) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          id: string,
          command: { action: "screenshot" },
        ) => Promise<{ ok: boolean }>;
      };
      return await runtime.agentBrowser(conversationId, { action: "screenshot" });
    },
    primaryConversationId,
  )).resolves.toMatchObject({ ok: true });

  const primaryEvidenceToggle = primaryPreview.getByRole("button", {
    name: /Evidence/u,
  });
  await expect(primaryEvidenceToggle).toContainText(/[1-9]\d*/u);
  await primaryEvidenceToggle.click();
  const evidenceTimeline = primaryPreview.getByRole("list", {
    name: "Browser evidence timeline",
  });
  await expect(evidenceTimeline).toBeVisible();
  await expect(evidenceTimeline.getByText("Console", { exact: true }).first())
    .toBeVisible();
  await expect(evidenceTimeline.getByText("Request", { exact: true }).first())
    .toBeVisible();
  await expect(evidenceTimeline.getByText("Screenshot", { exact: true }).first())
    .toBeVisible();
  await expect(evidenceTimeline).toContainText("Sensitive console detail hidden");
  const evidenceText = await evidenceTimeline.textContent();
  expect(evidenceText).not.toContain("browser-e2e-console-sentinel");
  expect(evidenceText).not.toContain("hunter2");
  expect(evidenceText).not.toContain("MONGODB_URI");
  expect(evidenceText).not.toContain("mongodb://alice");
  expect(evidenceText).not.toContain("Jane Doe");
  expect(evidenceText).not.toContain("private-server");
  expect(evidenceText).not.toContain("secret share");
  expect(evidenceText).not.toContain("src/private/config");
  expect(evidenceText).not.toContain("src/config");
  expect(evidenceText).not.toContain("src\\private\\config");
  expect(evidenceText).not.toContain("src/.env");
  expect(evidenceText).not.toContain("./Dockerfile");
  expect(evidenceText).not.toContain("browser-e2e-query-sentinel");
  expect(evidenceText).not.toContain("browser-e2e-body-sentinel");
  expect(evidenceText).not.toContain("browser-e2e-response-sentinel");

  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window?.contentView.children.find((candidate) => {
        const contents = Reflect.get(candidate, "webContents") as
          | { getURL: () => string }
          | undefined;
        return contents?.getURL() === url;
      });
      const bounds = view?.getBounds();
      return bounds ? { width: bounds.width, height: bounds.height } : null;
    },
    typeDestinationUrl,
  )).toEqual({ width: 0, height: 0 });

  await evidenceTimeline.getByText("Inspect capture").click();
  await expect(evidenceTimeline.getByRole("img", {
    name: /Browser screenshot from Page/u,
  })).toBeVisible();
  const primaryToolsResize = primary.getByRole("separator", {
    name: "Resize workspace tools",
  });
  await primaryToolsResize.press("End");
  await primaryToolsResize.evaluate((element) => {
    (element as HTMLElement).blur();
  });
  const browserEvidenceScreenshot = testInfo.outputPath(
    "inertia-browser-evidence-light.png",
  );
  await page.screenshot({
    animations: "disabled",
    path: browserEvidenceScreenshot,
  });
  await testInfo.attach("inertia-browser-evidence-light", {
    path: browserEvidenceScreenshot,
    contentType: "image/png",
  });

  const themeButton = page.getByRole("button", { name: /Change theme/u });
  if (!/current: dark/u.test(await themeButton.getAttribute("aria-label") ?? "")) {
    await themeButton.click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await app.resizeWindow(1_050, 820);
  await expect(primaryPreview.locator(".preview-evidence-toggle > span"))
    .toBeHidden();
  const compactEvidenceScreenshot = testInfo.outputPath(
    "inertia-browser-evidence-dark-compact.png",
  );
  await page.screenshot({
    animations: "disabled",
    path: compactEvidenceScreenshot,
  });
  await testInfo.attach("inertia-browser-evidence-dark-compact", {
    path: compactEvidenceScreenshot,
    contentType: "image/png",
  });
  await app.resizeWindow(1_440, 900);
  await themeButton.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await primaryToolsResize.press("Enter");

  const secondaryEvidenceToggle = secondaryPreview.getByRole("button", {
    name: /Evidence/u,
  });
  await secondaryEvidenceToggle.click();
  const secondaryEvidence = secondaryPreview.locator(".browser-evidence");
  await expect(secondaryEvidence).toBeVisible();
  await expect(secondaryEvidence.getByText("Console", { exact: true }))
    .toHaveCount(0);
  await expect(secondaryEvidence.getByText("Request", { exact: true }))
    .toHaveCount(0);
  await secondaryEvidence.getByRole("button", {
    name: "Close Browser evidence",
  }).click();

  await primaryPreview.getByRole("button", {
    name: "Close Browser evidence",
  }).press("Escape");
  await expect.poll(() => primaryEvidenceToggle.evaluate(
    (element) => document.activeElement === element,
  )).toBe(true);
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window?.contentView.children.find((candidate) => {
        const contents = Reflect.get(candidate, "webContents") as
          | { getURL: () => string }
          | undefined;
        return contents?.getURL() === url;
      });
      const bounds = view?.getBounds();
      return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
    },
    typeDestinationUrl,
  )).toBe(true);
}
