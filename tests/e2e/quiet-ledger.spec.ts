import { expect, test, type Locator } from "@playwright/test";

import { RuntimeStore } from "../../src/server/database";
import {
  createAppFixture,
  type AppFixture,
  type RuntimeTestSnapshot,
} from "./support/app-fixture";
import {
  capturePageWebSockets,
  publishCapturedWebSocketEvent,
} from "./support/browser-websocket-fixture";
import { createQuietLedgerFixture } from "./support/quiet-ledger-fixture";

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let rendererErrors!: AppFixture["rendererErrors"];
let runtimeSnapshot!: AppFixture["runtimeSnapshot"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "quiet-ledger", initialState: "conversation" });
  electronApp = app.electronApp;
  page = app.page;
  testDirectory = app.testDirectory;
  workspaceDirectory = app.workspaceDirectory;
  rendererErrors = app.rendererErrors;
  runtimeSnapshot = app.runtimeSnapshot;
  resizeWindow = app.resizeWindow;
  expectNoViewportOverflow = app.expectNoViewportOverflow;
});

test.afterAll(async () => {
  await app.close();
});

test("presents the Quiet Ledger states as one calm, responsive conversation", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  const {
    active,
    activeAt,
    approval,
    approvalRequest,
    cancelled,
    codexSelection,
    completed,
    conversation,
    databasePath,
    detailed,
    failed,
    fixturePrefix,
    kimi,
    originalSettings,
    previousConversationId,
    providerInputRequest,
    providerQuestion,
    warning,
  } = createQuietLedgerFixture({ testDirectory, workspaceDirectory });

  await capturePageWebSockets(page);
  const publishFixtureEvent = (event: object): Promise<void> =>
    publishCapturedWebSocketEvent(page, event);

  const captureScenario = async (name: string): Promise<void> => {
    const screenshotPath = testInfo.outputPath(`quiet-ledger-${name}.png`);
    await page.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`quiet-ledger-${name}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  };
  const captureElementScenario = async (
    name: string,
    target: Locator,
  ): Promise<void> => {
    const screenshotPath = testInfo.outputPath(`quiet-ledger-${name}.png`);
    await target.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`quiet-ledger-${name}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  };

  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Quiet Ledger visual fixture", level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const navigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
    if (!await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toBeVisible();
    }
    const workspacePanel = page.locator(".workspace-panel");
    if (await workspacePanel.isVisible()) {
      await page.getByRole("button", { name: "Close workspace tools" }).first().click();
      await expect(workspacePanel).toBeHidden();
    }

    const activeTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await activeTurn.scrollIntoViewIfNeeded();
    await expect(activeTurn.locator(".turn-execution-rail.is-live")).toBeVisible();
    await expect(activeTurn.locator(".turn-commentary-row")).toHaveCount(2);
    await expect(activeTurn.locator(".turn-activity-group")).toHaveCount(2);
    await expect(activeTurn.locator('[data-activity-visibility="recent"]')).toHaveCount(2);
    await expect(activeTurn.getByRole("button", { name: "+1 previous tool call" })).toHaveCount(2);
    await expect(activeTurn.getByRole("button", { name: "Stop Codex · OpenAI run" })).toBeVisible();
    await expect(activeTurn.locator(".turn-working-elapsed")).toHaveAttribute("aria-live", "off");
    await captureScenario("active-turn");
    const normalMotion = await activeTurn.locator(
      "[data-active-work-region]",
    ).evaluate((element) => ({
      mediaMatches: window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches,
      washAnimation: getComputedStyle(element, "::before").animationName,
    }));
    expect(normalMotion).toEqual({
      mediaMatches: false,
      washAnimation: "active-work-tonal-wash",
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedMotion = await activeTurn.locator(
      "[data-active-work-region]",
    ).evaluate((element) => {
      const runningGlyph = element.querySelector(
        ".agent-activity.is-running svg",
      );
      return {
        mediaMatches: window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches,
        washAnimation: getComputedStyle(element, "::before").animationName,
        glyphAnimation: runningGlyph
          ? getComputedStyle(runningGlyph).animationName
          : null,
      };
    });
    expect(reducedMotion).toEqual({
      mediaMatches: true,
      washAnimation: "none",
      glyphAnimation: "none",
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await publishFixtureEvent({
      type: "agent.text",
      conversationId: conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      text: "The live caret stays attached to this final paragraph.",
    });
    const streamingMarkdown = activeTurn.locator(
      ".turn-commentary-row.is-streaming .response-markdown",
    );
    await expect(streamingMarkdown).toHaveCount(1);
    const paragraphCaret = await streamingMarkdown.evaluate((element) => {
      const last = element.lastElementChild;
      const caret = last ? getComputedStyle(last, "::after") : null;
      return {
        lastTag: last?.tagName ?? null,
        caretContent: caret?.content ?? null,
        caretDisplay: caret?.display ?? null,
        duplicateCaret: element.parentElement?.querySelector(
          ":scope > .streaming-caret",
        ) !== null,
      };
    });
    expect(paragraphCaret).toEqual({
      lastTag: "P",
      caretContent: '""',
      caretDisplay: "inline-block",
      duplicateCaret: false,
    });
    await publishFixtureEvent({
      type: "agent.activity",
      activity: {
        id: "activity-stream-boundary",
        conversationId: conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        kind: "status",
        title: "Streaming paragraph captured",
        detail: null,
        status: "completed",
        createdAt: activeAt(16),
      },
    });
    await publishFixtureEvent({
      type: "agent.text",
      conversationId: conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      text: "```ts\nconst verified = true;\n```",
    });
    const codeCaret = await streamingMarkdown.evaluate((element) => {
      const last = element.lastElementChild;
      const caret = last ? getComputedStyle(last, "::after") : null;
      return {
        lastTag: last?.tagName ?? null,
        literalText: last?.textContent ?? null,
        caretContent: caret?.content ?? null,
        duplicateCaret: element.parentElement?.querySelector(
          ":scope > .streaming-caret",
        ) !== null,
      };
    });
    expect(codeCaret).toEqual({
      lastTag: "P",
      literalText: "```ts\nconst verified = true;\n```",
      caretContent: '""',
      duplicateCaret: false,
    });
    await captureElementScenario("streaming-caret-code", activeTurn);

    await page.getByRole("button", { name: "Open workspace tools" }).click();
    const previewTools = page.getByRole("complementary", {
      name: "Workspace tools",
    });
    await previewTools.getByRole("tab", {
      name: "Preview",
      exact: true,
    }).click();
    const hostilePreviewUrl = `${app.previewUrl}approval-overlay`;
    await previewTools.getByRole("textbox", {
      name: "Preview address",
    }).fill(hostilePreviewUrl);
    await previewTools.getByRole("button", {
      name: "Go",
      exact: true,
    }).click();
    await expect.poll(
      () => app.nativePreviewIsVisible(hostilePreviewUrl),
    ).toBe(true);

    await publishFixtureEvent({
      type: "agent.approval.requested",
      request: approvalRequest,
    });
    await expect.poll(
      () => app.nativePreviewIsVisible(hostilePreviewUrl),
    ).toBe(false);
    await previewTools.getByRole("button", {
      name: "Close workspace tools",
    }).click();
    await publishFixtureEvent({
      type: "agent.input.requested",
      request: providerInputRequest,
    });

    const approvalTurn = page.locator(
      `[data-turn-id="${approval.turn.id}"]`,
    );
    await approvalTurn.scrollIntoViewIfNeeded();
    const approvalCard = approvalTurn.locator(
      '[data-agent-request-state="approval"]',
    );
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard).toContainText(
      "Approve the focused renderer verification",
    );
    await expect(approvalCard).toContainText(
      "Codex paused for your review.",
    );
    const approveOnce = approvalCard.getByRole("button", {
      name: "Approve once",
    });
    await approveOnce.focus();
    await expect(approveOnce).toBeFocused();
    await captureScenario("approval-dark-1440x920");

    const providerQuestionTurn = page.locator(
      `[data-turn-id="${providerQuestion.turn.id}"]`,
    );
    await providerQuestionTurn.scrollIntoViewIfNeeded();
    const providerQuestionCard = providerQuestionTurn.locator(
      '[data-agent-request-state="question"]',
    );
    await expect(providerQuestionCard).toBeVisible();
    await expect(providerQuestionCard).toContainText(
      "Claude needs your input",
    );
    await expect(providerQuestionCard).toContainText(
      "Which provider presentation should this fixture preserve?",
    );
    const firstQuestionOption = providerQuestionCard.getByRole("radio", {
      name: /Quiet ledger/u,
    });
    await firstQuestionOption.focus();
    await expect(firstQuestionOption).toBeFocused();
    await captureScenario("provider-question-dark-1440x920");

    const completedTurn = page.locator(`[data-turn-id="${completed.turn.id}"]`);
    const detailedTurn = page.locator(`[data-turn-id="${detailed.turn.id}"]`);
    const kimiTurn = page.locator(`[data-turn-id="${kimi.turn.id}"]`);
    await completedTurn.scrollIntoViewIfNeeded();
    for (const successfulFixture of [completed, detailed, kimi]) {
      const successfulTurn = page.locator(`[data-turn-id="${successfulFixture.turn.id}"]`);
      await expect(successfulTurn.locator(".turn-settled-summary")).toHaveCount(0);
      await expect(successfulTurn.locator(".turn-duration")).toHaveText("Worked 42s");
      await expect(successfulTurn.getByText("Worked 42s", { exact: true })).toHaveCount(1);
    }
    const successfulGeometry = await Promise.all(
      [completedTurn, detailedTurn, kimiTurn].map((successfulTurn) =>
        successfulTurn.evaluate((element) => {
          const request = element.querySelector<HTMLElement>(
            '[data-turn-layer="user-request"]',
          )?.getBoundingClientRect();
          const answer = element.querySelector<HTMLElement>(
            '[data-turn-layer="final-answer"]',
          )?.getBoundingClientRect();
          const metadata = element.querySelector<HTMLElement>(
            ".turn-meta",
          )?.getBoundingClientRect();
          return request && answer && metadata
            ? {
                requestToAnswer: answer.top - request.bottom,
                answerToMetadata: metadata.top - answer.bottom,
                answerHeight: answer.height,
                metadataHeight: metadata.height,
              }
            : null;
        })),
    );
    for (const geometry of successfulGeometry) {
      expect(geometry).not.toBeNull();
      if (!geometry) continue;
      expect(geometry.requestToAnswer).toBeGreaterThanOrEqual(8);
      expect(geometry.requestToAnswer).toBeLessThanOrEqual(17);
      expect(geometry.answerToMetadata).toBeGreaterThanOrEqual(5);
      expect(geometry.answerToMetadata).toBeLessThanOrEqual(13);
      expect(geometry.metadataHeight).toBeLessThanOrEqual(
        geometry.answerHeight,
      );
    }
    const successfulTurnSeparation = await Promise.all([
      completedTurn.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      }),
      detailedTurn.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      }),
      kimiTurn.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      }),
    ]);
    expect(successfulTurnSeparation[1]!.top - successfulTurnSeparation[0]!.bottom)
      .toBeGreaterThanOrEqual(28);
    expect(successfulTurnSeparation[2]!.top - successfulTurnSeparation[1]!.bottom)
      .toBeGreaterThanOrEqual(28);
    const completedLayers = await completedTurn.locator(":scope > [data-turn-layer]").evaluateAll(
      (elements) => elements.map((element) => element.getAttribute("data-turn-layer")),
    );
    expect(completedLayers).toEqual([
      "user-request",
      "agent-execution",
      "final-answer",
      "supporting-ledger",
    ]);
    await expect(completedTurn.locator('[data-turn-layer="agent-execution"] [data-turn-layer="final-answer"]')).toHaveCount(0);
    await expect(completedTurn.locator('[data-turn-layer="final-answer"]')).toContainText("The provider route now");
    await expect(completedTurn.locator('[data-final-answer-identity="historical-model-selection"]'))
      .toHaveText("Codex · OpenAI · GPT-5.6");
    const turnMetaPrimary = completedTurn.locator(".turn-meta-primary");
    const runDetailsToggle = completedTurn.getByRole("button", { name: "Run details" });
    const runDetails = completedTurn.locator(".turn-run-details");
    await expect(turnMetaPrimary).toContainText("Completed");
    await expect(turnMetaPrimary).toContainText("Worked 42s");
    await expect(turnMetaPrimary).not.toContainText(codexSelection.harnessId);
    await expect(turnMetaPrimary).not.toContainText(codexSelection.backendProfileId);
    await expect(turnMetaPrimary).not.toContainText(codexSelection.modelId);
    await expect(runDetailsToggle).toHaveAttribute("aria-expanded", "false");
    await runDetailsToggle.click();
    await expect(runDetailsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(runDetails).toBeVisible();
    await expect(runDetails).toContainText("Harness ID");
    await expect(runDetails).toContainText(codexSelection.harnessId);
    await expect(runDetails).toContainText("Requested alias");
    await expect(runDetails).toContainText(codexSelection.alias ?? "Not requested");
    await expect(runDetails).toContainText("Session continuation");
    await expect(runDetails).toContainText("Execution transcript");
    await expect(runDetails.getByRole("list", { name: "Agent work transcript" })).toBeVisible();
    await captureElementScenario("completed-run-details", completedTurn.locator(".turn-meta"));
    await runDetailsToggle.click();
    await expect(runDetailsToggle).toHaveAttribute("aria-expanded", "false");
    const changedFiles = completedTurn.getByLabel("Changed by this turn");
    const changedFilesSummary = changedFiles.locator("summary");
    await expect(changedFiles).toContainText("3 files changed");
    await expect(changedFiles).toContainText("+162 −29 · main");
    await expect(changedFilesSummary).toHaveAttribute("aria-expanded", "false");
    const supportingGeometry = await completedTurn.evaluate((element) => {
      const metadata = element.querySelector<HTMLElement>(".turn-meta")
        ?.getBoundingClientRect();
      const changedFiles = element.querySelector<HTMLElement>(
        ".turn-changed-files",
      )?.getBoundingClientRect();
      const runDetailsToggle = element.querySelector<HTMLElement>(
        ".turn-run-details-toggle",
      )?.getBoundingClientRect();
      const changedFilesSummary = element.querySelector<HTMLElement>(
        ".turn-changed-files > summary",
      )?.getBoundingClientRect();
      return metadata && changedFiles && runDetailsToggle && changedFilesSummary
        ? {
            metadataToArtifact: changedFiles.top - metadata.bottom,
            runDetailsTargetHeight: runDetailsToggle.height,
            changedFilesTargetHeight: changedFilesSummary.height,
          }
        : null;
    });
    expect(supportingGeometry).not.toBeNull();
    if (supportingGeometry) {
      expect(supportingGeometry.metadataToArtifact).toBeGreaterThanOrEqual(0);
      expect(supportingGeometry.metadataToArtifact).toBeLessThanOrEqual(6);
      expect(supportingGeometry.runDetailsTargetHeight).toBeGreaterThanOrEqual(26);
      expect(supportingGeometry.changedFilesTargetHeight).toBeGreaterThanOrEqual(32);
    }
    await changedFilesSummary.click();
    await expect(changedFilesSummary).toHaveAttribute("aria-expanded", "true");
    await expect(changedFiles.locator('[role="listitem"]')).toHaveCount(3);
    await expect(changedFiles.getByRole("button", { name: "Open exact turn diff" })).toBeDisabled();
    await expect(changedFiles).toContainText(
      "The historical file summary is available without a stored patch.",
    );
    await expect(changedFiles.getByRole("button", {
      name: "Open src/renderer/src/components/ResponseTimeline.tsx",
    })).toBeEnabled();
    await captureElementScenario("completed-changed-files", changedFiles);
    await changedFilesSummary.click();
    await expect(changedFilesSummary).toHaveAttribute("aria-expanded", "false");
    await captureScenario("completed-answer");
    await captureElementScenario(
      "rich-markdown-dark",
      completedTurn.locator('[data-turn-layer="final-answer"]'),
    );

    await detailedTurn.scrollIntoViewIfNeeded();
    await captureScenario("settled-history-dark-1440x920");
    await detailedTurn.scrollIntoViewIfNeeded();
    const detailsSummary = detailedTurn.getByRole("button", { name: "Run details" });
    await expect(detailsSummary).toHaveAttribute("aria-expanded", "false");
    const followingKimiTurn = page.locator(`[data-turn-id="${kimi.turn.id}"]`);
    const beforeFollowingTurnTop = await followingKimiTurn.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    await detailsSummary.click();
    await expect(detailsSummary).toHaveAttribute("aria-expanded", "true");
    await expect(detailedTurn.locator(".turn-run-work-details")).toBeVisible();
    await expect.poll(() => followingKimiTurn.evaluate(
      (element, top) => Math.abs(element.getBoundingClientRect().top - top),
      beforeFollowingTurnTop,
    )).toBeLessThanOrEqual(2);
    await captureScenario("expanded-details");

    await kimiTurn.scrollIntoViewIfNeeded();
    await expect(kimiTurn.locator('[data-final-answer-identity="historical-model-selection"]'))
      .toHaveText("Claude · Kimi · K3");
    await captureScenario("kimi-through-claude");

    const warningTurn = page.locator(`[data-turn-id="${warning.turn.id}"]`);
    await warningTurn.scrollIntoViewIfNeeded();
    await expect(warningTurn.locator(".turn-settled-summary")).toContainText("Worked for 42s · 1 action");
    await expect(warningTurn.locator('[data-activity-severity="warning"]'))
      .toContainText("optional provider capability skipped");
    await expect(warningTurn.locator('[data-activity-severity="warning"]')).toBeVisible();

    const failedTurn = page.locator(`[data-turn-id="${failed.turn.id}"]`);
    await failedTurn.scrollIntoViewIfNeeded();
    await expect(failedTurn.locator(".turn-settled-summary")).toContainText("Failed after 42s · 2 actions");
    await expect(failedTurn.locator(".agent-activity.is-failed")).toContainText("Renderer verification failed");
    await expect(failedTurn.locator(".agent-activity.is-failed")).toBeVisible();
    const exceptionalGeometry = await Promise.all(
      [warningTurn, failedTurn].map((exceptionalTurn) =>
        exceptionalTurn.evaluate((element) => {
          const request = element.querySelector<HTMLElement>(
            '[data-turn-layer="user-request"]',
          )?.getBoundingClientRect();
          const execution = element.querySelector<HTMLElement>(
            '[data-turn-layer="agent-execution"]',
          )?.getBoundingClientRect();
          const answer = element.querySelector<HTMLElement>(
            '[data-turn-layer="final-answer"]',
          )?.getBoundingClientRect();
          const metadata = element.querySelector<HTMLElement>(
            ".turn-meta",
          )?.getBoundingClientRect();
          return request && execution && answer && metadata
            ? {
                requestToExecution: execution.top - request.bottom,
                executionToAnswer: answer.top - execution.bottom,
                answerToMetadata: metadata.top - answer.bottom,
                metadataHeight: metadata.height,
                answerHeight: answer.height,
              }
            : null;
        })),
    );
    for (const geometry of exceptionalGeometry) {
      expect(geometry).not.toBeNull();
      if (!geometry) continue;
      expect(geometry.requestToExecution).toBeGreaterThanOrEqual(8);
      expect(geometry.requestToExecution).toBeLessThanOrEqual(17);
      expect(geometry.executionToAnswer).toBeGreaterThanOrEqual(8);
      expect(geometry.executionToAnswer).toBeLessThanOrEqual(17);
      expect(geometry.answerToMetadata).toBeGreaterThanOrEqual(5);
      expect(geometry.answerToMetadata).toBeLessThanOrEqual(13);
      expect(geometry.metadataHeight).toBeLessThanOrEqual(
        geometry.answerHeight,
      );
    }
    await captureScenario("failed-tool");
    await captureScenario("exception-history-dark-1440x920");

    const cancelledTurn = page.locator(`[data-turn-id="${cancelled.turn.id}"]`);
    await cancelledTurn.scrollIntoViewIfNeeded();
    await expect(cancelledTurn.locator(".turn-settled-summary"))
      .toContainText("Stopped after 42s · 1 action");
    await expect(cancelledTurn.locator(".turn-settled-summary")).toBeVisible();

    const lightSettings = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
    lightSettings.updateSettings({ theme: "light" });
    lightSettings.close();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const lightCompletedTurn = page.locator(`[data-turn-id="${completed.turn.id}"]`);
    await lightCompletedTurn.scrollIntoViewIfNeeded();
    await expect(lightCompletedTurn.locator(".turn-settled-summary")).toHaveCount(0);
    await expect(lightCompletedTurn.getByText("Worked 42s", { exact: true })).toHaveCount(1);
    await captureElementScenario(
      "rich-markdown-light",
      lightCompletedTurn.locator('[data-turn-layer="final-answer"]'),
    );
    await page.locator(`[data-turn-id="${kimi.turn.id}"]`).scrollIntoViewIfNeeded();
    await captureScenario("settled-history-light-1440x920");
    await page.locator(`[data-turn-id="${failed.turn.id}"]`).scrollIntoViewIfNeeded();
    await captureScenario("exception-history-light-1440x920");

    const darkSettings = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
    darkSettings.updateSettings({ theme: "dark" });
    darkSettings.close();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(`[data-turn-id="${completed.turn.id}"] .turn-settled-summary`))
      .toHaveCount(0);

    await resizeWindow(760, 680);
    if (await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toBeHidden();
    }
    await kimiTurn.scrollIntoViewIfNeeded();
    await captureScenario("settled-history-narrow-760x680");
    await activeTurn.scrollIntoViewIfNeeded();
    await expect(activeTurn.getByRole("button", { name: "Stop Codex · OpenAI run" })).toBeVisible();
    await expectNoViewportOverflow();
    const narrowGeometry = await activeTurn.evaluate((element) => {
      const turn = element.getBoundingClientRect();
      const request = element.querySelector<HTMLElement>(".turn-user-request")?.getBoundingClientRect();
      const execution = element.querySelector<HTMLElement>(".turn-execution-rail")?.getBoundingClientRect();
      return {
        turnWidth: turn.width,
        requestInside: request
          ? request.left >= turn.left - 1 && request.right <= turn.right + 1
          : false,
        executionInside: execution
          ? execution.left >= turn.left - 1 && execution.right <= turn.right + 1
          : false,
      };
    });
    expect(narrowGeometry.turnWidth).toBeGreaterThan(0);
    expect(narrowGeometry.requestInside).toBe(true);
    expect(narrowGeometry.executionInside).toBe(true);
    await captureScenario("narrow-workspace");

    await completedTurn.scrollIntoViewIfNeeded();
    await runDetailsToggle.click();
    await changedFilesSummary.click();
    await expect(runDetails).toBeVisible();
    await expect(changedFiles.locator('[role="listitem"]')).toHaveCount(3);
    const narrowCompletedGeometry = await completedTurn.evaluate((element) => {
      const turn = element.getBoundingClientRect();
      const contained = (selector: string) => {
        const target = element.querySelector<HTMLElement>(selector)
          ?.getBoundingClientRect();
        return Boolean(
          target
          && target.left >= turn.left - 1
          && target.right <= turn.right + 1,
        );
      };
      const code = element.querySelector<HTMLElement>(
        ".response-code-block pre",
      );
      const table = element.querySelector<HTMLElement>(
        ".response-table-scroll",
      );
      const changedRows = [
        ...element.querySelectorAll<HTMLElement>(
          ".turn-changed-files [role='listitem']",
        ),
      ];
      return {
        requestInside: contained(".turn-user-request"),
        executionAbsent: !element.querySelector(".turn-execution-rail"),
        answerInside: contained(".turn-final-answer-document"),
        runDetailsInside: contained(".turn-run-details"),
        changedFilesInside: contained(".turn-changed-files"),
        codeShellInside: contained(".response-code-block"),
        tableShellInside: contained(".response-table-shell"),
        codeOverflowOwned: Boolean(
          code
          && code.scrollWidth > code.clientWidth + 1
          && getComputedStyle(code).overflowX === "auto",
        ),
        tableOverflowOwned: Boolean(
          table
          && getComputedStyle(table).overflowX === "auto",
        ),
        changedRowsInside: changedRows.every((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.left >= turn.left - 1 && bounds.right <= turn.right + 1;
        }),
      };
    });
    expect(narrowCompletedGeometry).toEqual({
      requestInside: true,
      executionAbsent: true,
      answerInside: true,
      runDetailsInside: true,
      changedFilesInside: true,
      codeShellInside: true,
      tableShellInside: true,
      codeOverflowOwned: true,
      tableOverflowOwned: true,
      changedRowsInside: true,
    });
    await captureScenario("narrow-completed-surfaces");
    await captureElementScenario(
      "narrow-rich-markdown",
      completedTurn.locator('[data-turn-layer="final-answer"]'),
    );
    await captureElementScenario(
      "narrow-changed-files",
      changedFiles,
    );
    await runDetailsToggle.click();
    await changedFilesSummary.click();

    const recentCompletion = new RuntimeStore(
      databasePath,
      workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    const recentCompletedAt = activeAt(52);
    const recentAnswer = recentCompletion.createMessage(
      conversation.id,
      "The active run has now settled into the same quiet historical presentation.",
      "assistant",
      [],
      active.turn.id,
      recentCompletedAt,
    );
    recentCompletion.updateAgentTurnLifecycle(active.turn.id, {
      status: "completed",
      completedAt: recentCompletedAt,
      updatedAt: recentCompletedAt,
      terminalAssistantMessageId: recentAnswer.id,
      terminalReason: "provider-completed",
    });
    recentCompletion.createTurnGitArtifact({
      id: `${fixturePrefix}-recent-pending-artifact`,
      turnId: active.turn.id,
      branch: "main",
      status: "pending",
      completeness: "partial",
      createdAt: recentCompletedAt,
    });
    recentCompletion.close();
    await page.reload();
    const recentlySettledTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await expect(recentlySettledTurn.locator(".turn-settled-summary")).toHaveCount(0);
    await expect(recentlySettledTurn.locator(".turn-duration")).toHaveText("Worked 52s");
    await expect(recentlySettledTurn.getByText("Worked 52s", { exact: true })).toHaveCount(1);
    await expect(recentlySettledTurn.locator(".turn-changed-files.is-pending"))
      .toContainText("Capturing changes…");
    await expect(recentlySettledTurn.locator(".turn-execution-rail.is-live")).toHaveCount(0);
    await expect(recentlySettledTurn.locator("[data-active-work-region]")).toHaveCount(0);
    await expect(recentlySettledTurn.getByRole("button", { name: /^Stop /u })).toHaveCount(0);

    await page.reload();
    const reloadedPendingTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await expect(reloadedPendingTurn.locator(".turn-changed-files.is-pending"))
      .toContainText("Capturing changes…");
    await expect(reloadedPendingTurn.locator(".turn-execution-rail.is-live")).toHaveCount(0);
    await expect(reloadedPendingTurn.locator("[data-active-work-region]")).toHaveCount(0);
    await expect(reloadedPendingTurn.getByRole("button", { name: /^Stop /u })).toHaveCount(0);

    const finalizeRecentArtifact = new RuntimeStore(
      databasePath,
      workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    finalizeRecentArtifact.completeTurnGitArtifact(active.turn.id, {
      files: [{
        path: "src/renderer/src/components/ResponseTimeline.tsx",
        previousPath: null,
        status: "modified",
        insertions: 12,
        deletions: 3,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      }],
      insertions: 12,
      deletions: 3,
      status: "ready",
      completeness: "complete",
      patchState: "none",
      capturedAt: activeAt(53),
      terminalAssistantMessageId: recentAnswer.id,
      updatedAt: activeAt(53),
    });
    finalizeRecentArtifact.close();
    await page.reload();
    const finalizedRecentTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await expect(finalizedRecentTurn.locator(".turn-changed-files.is-pending")).toHaveCount(0);
    await expect(finalizedRecentTurn.getByLabel("Changed by this turn"))
      .toContainText("1 file changed");
    await expect(finalizedRecentTurn.locator(".turn-execution-rail.is-live")).toHaveCount(0);
    await expect(finalizedRecentTurn.locator("[data-active-work-region]")).toHaveCount(0);
    await expect(finalizedRecentTurn.getByRole("button", { name: /^Stop /u })).toHaveCount(0);

    const beforeReconnect = await runtimeSnapshot();
    const rendererGenerationBeforeReconnect = await page.locator(".app-shell")
      .getAttribute("data-runtime-generation");
    await electronApp.evaluate((_electron) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        crash: () => RuntimeTestSnapshot;
      } | undefined;
      if (!runtime) throw new Error("The test runtime supervisor is unavailable");
      runtime.crash();
    });
    await expect.poll(async () => {
      const current = await runtimeSnapshot();
      return current.phase === "ready" && current.generation > beforeReconnect.generation;
    }, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => page.locator(".app-shell").getAttribute("data-runtime-generation"))
      .not.toBe(rendererGenerationBeforeReconnect);
    await expect(page.getByRole("heading", {
      name: "Quiet Ledger visual fixture",
      level: 1,
    })).toBeVisible();
    const reconnectedRecentTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await expect(reconnectedRecentTurn.locator(".turn-settled-summary")).toHaveCount(0);
    await expect(reconnectedRecentTurn.getByText("Worked 52s", { exact: true })).toHaveCount(1);
    expect(rendererErrors).toEqual([]);
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
    cleanup.updateSettings({
      theme: originalSettings.theme,
      interfaceScale: originalSettings.interfaceScale,
      responseDensity: originalSettings.responseDensity,
      defaultCodeWrap: originalSettings.defaultCodeWrap,
      autoCollapseWorkLog: originalSettings.autoCollapseWorkLog,
      showChangedFileSummaries: originalSettings.showChangedFileSummaries,
      showTimestamps: originalSettings.showTimestamps,
    });
    cleanup.selectConversation(previousConversationId);
    cleanup.deleteConversation(conversation.id);
    cleanup.close();
    await resizeWindow(1440, 920);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({
      timeout: 10_000,
    });
    const navigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
    if (!await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toBeVisible();
    }
    if (!await page.locator(".workspace-panel").isVisible()) {
      await page.getByRole("button", { name: "Open workspace tools" }).click();
      await expect(page.locator(".workspace-panel")).toBeVisible();
    }
  }
});
