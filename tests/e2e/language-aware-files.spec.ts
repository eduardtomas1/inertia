import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "language-aware-files",
    initialState: "conversation",
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const sourceDirectory = join(workspaceDirectory, "src", "main", "java");
      await mkdir(sourceDirectory, { recursive: true });
      const source = Array.from({ length: 72 }, (_, index) => {
        const line = index + 1;
        if (line === 1) return "package example;";
        if (line === 33) return "public final class Service {";
        if (line === 34) return "  private final int answer = 42;";
        if (line === 35) return "  public int answer() { return answer; }";
        if (line === 36) return "}";
        return `// source line ${line}`;
      }).join("\n");
      await writeFile(join(sourceDirectory, "Service.java"), source, "utf8");

      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const conversation = store.shellSnapshot().conversations[0];
      if (!conversation) throw new Error("Fixture conversation is unavailable");
      store.updateSettings({ theme: "dark" });
      store.createMessage(
        conversation.id,
        [
          "Open [the Java service](src/main/java/Service.java#L33-L36).",
          "",
          "```java file=src/main/java/Service.java",
          "public final class Service {",
          "  private final int answer = 42;",
          "}",
          "```",
        ].join("\n"),
        "assistant",
      );
      store.close();
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

async function expectSourceRangeVisible(): Promise<void> {
  const preview = page.locator(".file-preview-code");
  const geometry = await preview.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const targets = [...element.querySelectorAll<HTMLElement>(
      ".file-preview-line-numbers > .is-source-target",
    )].map((target) => target.getBoundingClientRect());
    return {
      viewport: { top: viewport.top, bottom: viewport.bottom },
      targets: targets.map(({ top, bottom }) => ({ top, bottom })),
    };
  });
  expect(geometry.targets).toHaveLength(4);
  expect(geometry.targets[0]!.top).toBeGreaterThanOrEqual(
    geometry.viewport.top - 1,
  );
  expect(geometry.targets.at(-1)!.bottom).toBeLessThanOrEqual(
    geometry.viewport.bottom + 1,
  );
}

test("opens locally recognized Java at a validated source range", async ({
  browserName: _browserName,
}, testInfo) => {
  await app.resizeWindow(1200, 820);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const link = page.getByRole("link", { name: "the Java service" });
  await expect(link).toHaveAttribute("href", "src/main/java/Service.java#L33-L36");
  await expect(link).toHaveAttribute("data-language", "java");
  await expect(link).toHaveAttribute("data-language-accent", "amber");
  const codeBlock = page.locator(
    '.response-code-block[data-language="java"][data-language-accent="amber"]',
  );
  await expect(codeBlock).toBeVisible();
  await expect(codeBlock.locator("code.hljs.language-java .hljs-keyword").first())
    .toHaveText("public");
  await page.screenshot({
    path: testInfo.outputPath("language-aware-transcript-dark.png"),
  });

  await link.click();
  const panel = page.getByRole("region", { name: "Project files" });
  await expect(panel).toBeVisible();
  const preview = panel.getByLabel(
    "Contents of src/main/java/Service.java, lines 33 to 36",
  );
  await expect(preview).toBeFocused();
  await expect(preview).toHaveAttribute("data-source-start-line", "33");
  await expect(preview).toHaveAttribute("data-source-end-line", "36");
  await expect(panel.locator(".file-language")).toHaveText("Java");
  await expect(panel.locator("code.hljs.language-java .hljs-keyword").first())
    .toHaveText("package");
  await expect(panel).not.toContainText(app.workspaceDirectory);
  await expectSourceRangeVisible();
  await page.screenshot({
    path: testInfo.outputPath("language-aware-files-dark.png"),
  });

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: testInfo.outputPath("language-aware-files-light.png"),
  });

  await app.resizeWindow(760, 760);
  await app.expectNoViewportOverflow();
  await expect(panel).toBeVisible();
  await expectSourceRangeVisible();
  await page.screenshot({
    path: testInfo.outputPath("language-aware-files-narrow.png"),
  });
  expect(app.rendererErrors).toEqual([]);
});
