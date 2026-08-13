import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];
let testDirectory!: string;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "language-aware-files",
    initialState: "conversation",
    windowDisplay: "primary",
    beforeLaunch: async ({ testDirectory: fixtureDirectory, workspaceDirectory }) => {
      const sourceDirectory = join(workspaceDirectory, "src", "demo");
      await mkdir(sourceDirectory, { recursive: true });
      const java = [
        "package demo;",
        "",
        "public final class OrderService {",
        ...Array.from(
          { length: 37 },
          (_, index) => `  // Stable service detail ${index + 1}`,
        ),
        "  public String exactPlace() {",
        '    return "ready";',
        "  }",
        "}",
      ].join("\n");
      await writeFile(
        join(sourceDirectory, "OrderService.java"),
        java,
        "utf8",
      );

      const databasePath = join(fixtureDirectory, "data", "inertia.sqlite");
      const store = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      const snapshot = store.shellSnapshot();
      if (!snapshot.activeConversationId) {
        store.close();
        throw new Error("The language-aware fixture has no conversation.");
      }
      store.updateSettings({ theme: "dark" });
      store.createMessage(
        snapshot.activeConversationId,
        [
          "The implementation is in [OrderService.java lines 41–43](src/demo/OrderService.java#L41-L43).",
          "",
          "```text file=src/demo/OrderService.java:41-43",
          "public String exactPlace() {",
          '  return "ready";',
          "}",
          "```",
        ].join("\n"),
        "assistant",
      );
      store.close();
    },
  });
  page = app.page;
  testDirectory = app.testDirectory;
});

test.afterAll(async () => {
  await app.close();
});

async function openExactJavaRange(opener: "code" | "link"): Promise<void> {
  if (opener === "code") {
    await page.getByRole("button", {
      name: "src/demo/OrderService.java:41-43",
    }).click();
  } else {
    await page.getByRole("link", {
      name: "OrderService.java lines 41–43",
    }).click();
  }
  const panel = page.getByRole("region", { name: "Project files" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Contents of src/demo/OrderService.java"))
    .toBeVisible();
  await expect(panel.getByTitle("Java recognized locally"))
    .toHaveText("Java");
  await expect(panel.getByText("Lines 41–43", { exact: true })).toBeVisible();
  const firstReferencedLine = panel.locator('[data-source-line="41"]');
  await expect(firstReferencedLine).toHaveClass(/is-referenced/u);
  await expect(firstReferencedLine).toBeFocused();
  await expect(panel.locator(".file-preview-line.is-referenced"))
    .toHaveCount(3);
  await expect(panel.locator(".file-preview-code .hljs-keyword").first())
    .toBeVisible();
}

test("opens a language-aware project link at its exact validated Java range", async ({
  browserName: _browserName,
}, testInfo) => {
  await app.resizeWindow(1440, 920);
  const darkTranscript = page.getByRole("region", {
    name: "Recovered legacy and orphaned history",
  });
  await expect(darkTranscript.locator(
    '.response-code-block[data-language-family="java"]',
  )).toBeVisible();
  const darkTranscriptEvidence = testInfo.outputPath(
    "language-aware-transcript-dark.png",
  );
  await darkTranscript.screenshot({
    animations: "disabled",
    path: darkTranscriptEvidence,
  });
  await testInfo.attach("language-aware-transcript-dark", {
    path: darkTranscriptEvidence,
    contentType: "image/png",
  });
  await openExactJavaRange("code");

  const panel = page.getByRole("region", { name: "Project files" });
  const badge = panel.getByTitle("Java recognized locally");
  const darkAccent = await badge.evaluate((element) =>
    getComputedStyle(element).color
  );
  expect(darkAccent).not.toBe("rgba(0, 0, 0, 0)");
  const darkEvidence = testInfo.outputPath("language-aware-files-dark.png");
  await panel.screenshot({ animations: "disabled", path: darkEvidence });
  await testInfo.attach("language-aware-files-dark", {
    path: darkEvidence,
    contentType: "image/png",
  });

  await page.emulateMedia({ forcedColors: "active" });
  await expect.poll(() => page.evaluate(() =>
    window.matchMedia("(forced-colors: active)").matches
  )).toBe(true);
  expect(await badge.evaluate((element) =>
    getComputedStyle(element).borderTopStyle
  )).toBe("solid");
  await page.emulateMedia({ forcedColors: "none" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await panel.locator(".file-language-icon").first().evaluate(
    (element) => getComputedStyle(element).animationName,
  )).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, app.workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  store.updateSettings({ theme: "light" });
  store.close();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightTranscript = page.getByRole("region", {
    name: "Recovered legacy and orphaned history",
  });
  const lightTranscriptEvidence = testInfo.outputPath(
    "language-aware-transcript-light.png",
  );
  await lightTranscript.screenshot({
    animations: "disabled",
    path: lightTranscriptEvidence,
  });
  await testInfo.attach("language-aware-transcript-light", {
    path: lightTranscriptEvidence,
    contentType: "image/png",
  });
  await openExactJavaRange("link");
  const lightPanel = page.getByRole("region", { name: "Project files" });
  const lightAccent = await lightPanel
    .getByTitle("Java recognized locally")
    .evaluate((element) => getComputedStyle(element).color);
  expect(lightAccent).not.toBe(darkAccent);
  const lightEvidence = testInfo.outputPath("language-aware-files-light.png");
  await lightPanel.screenshot({ animations: "disabled", path: lightEvidence });
  await testInfo.attach("language-aware-files-light", {
    path: lightEvidence,
    contentType: "image/png",
  });

  await app.resizeWindow(760, 760);
  const narrowPanel = page.getByRole("region", { name: "Project files" });
  const geometry = await narrowPanel.evaluate((element) => {
    const panelBounds = element.getBoundingClientRect();
    const preview = element.querySelector<HTMLElement>(".file-preview")
      ?.getBoundingClientRect();
    const line = element.querySelector<HTMLElement>(
      '[data-source-line="41"]',
    )?.getBoundingClientRect();
    return preview && line
      ? {
          previewInside: preview.left >= panelBounds.left - 1
            && preview.right <= panelBounds.right + 1,
          lineVisible: line.top >= preview.top - 1
            && line.bottom <= preview.bottom + 1,
        }
      : null;
  });
  expect(geometry).toEqual({ previewInside: true, lineVisible: true });
  await app.expectNoViewportOverflow();
  expect(app.rendererErrors).toEqual([]);
});
