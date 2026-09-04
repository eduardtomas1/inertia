import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

import type { DiffSelectionReviewAnswer } from "../../src/shared/contracts";
import {
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { selectionAnswerFixtureMarkup } from "./support/selection-answer-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { selectWorkspaceTool } from "./support/workspace-tools";

let app!: AppFixture;
let page!: AppFixture["page"];
let rendererErrors!: AppFixture["rendererErrors"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "review", initialState: "conversation" });
  page = app.page;
  rendererErrors = app.rendererErrors;
  resizeWindow = app.resizeWindow;
  expectNoViewportOverflow = app.expectNoViewportOverflow;
});

test.afterAll(async () => {
  await app.close();
});

async function ensureWorkspaceTools(): Promise<void> {
  if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace tools" }).click();
  }
}

test("keeps the Changes panel readable when the side tool area is narrow", async () => {
  await resizeWindow(1024, 800);
  const gitMenuTrigger = page.getByRole("button", { name: "More Git actions" });
  await expect(gitMenuTrigger).toBeVisible();
  await expect(gitMenuTrigger.locator("svg").last()).toBeVisible();
  await resizeWindow(1040, 800);
  await ensureWorkspaceTools();
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Changes");
  const picker = page.getByRole("combobox", { name: "Repository and changed file" });
  await expect(picker).toBeVisible();
  await expect(picker.locator("option:checked")).toHaveText("M · sample.ts");
  await expect(page.getByLabel("Git repositories and changed files")).toBeHidden();
  await expect(page.getByLabel(/Diff for|Unified diff/)).toBeVisible();
  await expect(gitMenuTrigger).toHaveCount(0);

  await resizeWindow(760, 800);
  const rootActions = page.getByLabel("Actions for Inertia", { exact: true });
  const commit = rootActions.getByRole("button", { name: "Commit" });
  await expect(rootActions).toBeVisible();
  await expect(commit).toBeVisible();
  await commit.click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expectNoViewportOverflow();
  await resizeWindow(1040, 800);
  expect(rendererErrors).toEqual([]);
});

test("adds a selected diff range to the next agent prompt", async () => {
  await resizeWindow(1440, 920);
  await ensureWorkspaceTools();
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Changes");
  const addedLine = page.locator(".diff-line.is-addition").filter({ hasText: "export const ready = true;" }).first();
  await expect(addedLine).toBeVisible();
  await addedLine.click();
  await expect(page.getByRole("button", { name: "Add to prompt" })).toBeVisible();
  await page.getByRole("button", { name: "Add to prompt" }).click();
  await expect(page.getByLabel("Selected diff context", { exact: true })).toContainText("Diff selection in sample.ts");
  await page.getByRole("button", { name: "Remove selected diff context" }).click();
  await expect(page.getByLabel("Selected diff context", { exact: true })).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
});

test("keeps a contextual selection answer readable and dismissible across responsive layouts", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  await ensureWorkspaceTools();
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Changes");
  const hunkHeader = page.locator(".diff-hunk-header").first();
  await expect(hunkHeader).toBeVisible();

  const longBackendName =
    "Claude harness · Enterprise gateway with an intentionally long private backend name";
  const longModelName =
    "Claude Sonnet research preview with an intentionally long model display name";
  const modelSelection = {
    ...providerNativeModelSelection({
      providerId: "claude",
      modelId: "claude-sonnet-research-preview-with-a-long-identifier",
      alias: longModelName,
      reasoningEffort: "high",
    }),
    backendProfileId: "custom:e2e-contextual-review",
    backendProfileDisplayName: longBackendName,
    backendConfigurationRevision: 7,
  } as const;
  const longAnswer = Array.from({ length: 18 }, (_, index) =>
    `Finding ${index + 1}: the selected line keeps the runtime state explicit, preserves the exact backend route, and avoids turning a contextual review question into ordinary transcript history.`,
  ).join("\n\n");
  const answer: DiffSelectionReviewAnswer = {
    conversationId: randomUUID(),
    fingerprint: "b".repeat(64),
    filePath: "sample.ts",
    hunkId: "e2e-hunk",
    selectedLineCount: 12,
    question:
      "Explain the compatibility, lifecycle, and user-facing consequences of this selected diff without losing its exact routing context.",
    answer: longAnswer,
    providerId: "claude",
    modelSelection,
    generatedAt: "2026-07-25T12:00:00.000Z",
  };
  const markup = selectionAnswerFixtureMarkup(answer);

  await hunkHeader.evaluate((header, cardMarkup) => {
    header.insertAdjacentHTML("afterend", cardMarkup);
    const card = header.nextElementSibling;
    card?.querySelector<HTMLButtonElement>('[aria-label="Dismiss selection answer"]')
      ?.addEventListener("click", () => card.remove());
  }, markup);

  const card = page.getByLabel("Agent answer about selected lines");
  const answerBody = card.locator(".diff-selection-answer-body");
  const dismiss = card.getByRole("button", { name: "Dismiss selection answer" });
  await expect(card).toContainText(longBackendName);
  await expect(card).toContainText(longModelName);
  await expect(card).toContainText("Finding 18");

  for (const viewport of [
    { width: 1440, height: 920, slug: "wide" },
    { width: 900, height: 760, slug: "medium" },
    { width: 760, height: 760, slug: "narrow" },
  ] as const) {
    await resizeWindow(viewport.width, viewport.height);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await expect(dismiss).toBeVisible();
    const geometry = await card.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const body = element.querySelector<HTMLElement>(".diff-selection-answer-body");
      const meta = element.querySelector<HTMLElement>("header small");
      const close = element.querySelector<HTMLElement>('[aria-label="Dismiss selection answer"]');
      return {
        left: bounds.left,
        right: bounds.right,
        viewportWidth: window.innerWidth,
        bodyClientHeight: body?.clientHeight ?? 0,
        bodyScrollHeight: body?.scrollHeight ?? 0,
        metadataFontSize: Number.parseFloat(getComputedStyle(meta!).fontSize),
        closeLeft: close?.getBoundingClientRect().left ?? -1,
        closeRight: close?.getBoundingClientRect().right ?? -1,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.bodyScrollHeight).toBeGreaterThan(geometry.bodyClientHeight);
    expect(geometry.metadataFontSize).toBeGreaterThanOrEqual(8.5);
    expect(geometry.closeLeft).toBeGreaterThanOrEqual(geometry.left);
    expect(geometry.closeRight).toBeLessThanOrEqual(geometry.right + 1);
    await answerBody.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => answerBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expectNoViewportOverflow();
    const screenshotPath = testInfo.outputPath(
      `selection-answer-${viewport.slug}-${viewport.width}x${viewport.height}.png`,
    );
    await page.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`selection-answer-${viewport.slug}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  }

  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await dismiss.press("Enter");
  await expect(card).toHaveCount(0);
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});
