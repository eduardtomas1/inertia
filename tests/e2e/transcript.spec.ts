import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { INTERFACE_SCALE_WILL_CHANGE_EVENT } from "../../src/renderer/src/utils/interfaceScale";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let rendererErrors!: AppFixture["rendererErrors"];
let resizeWindow!: AppFixture["resizeWindow"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "transcript", initialState: "conversation" });
  page = app.page;
  testDirectory = app.testDirectory;
  workspaceDirectory = app.workspaceDirectory;
  rendererErrors = app.rendererErrors;
  resizeWindow = app.resizeWindow;
});

test.afterAll(async () => {
  await app.close();
});

test("keeps a long transcript bounded, anchored, and keyboard navigable", async () => {
  await resizeWindow(1440, 920);
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  let snapshot = store.shellSnapshot();
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) {
    const project = store.createProject("Inertia", workspaceDirectory);
    store.createConversation(project.id, "E2E base conversation");
    snapshot = store.shellSnapshot();
  }
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) throw new Error("Long transcript fixture setup failed.");
  const previousConversationId = snapshot.activeConversationId;
  const originalTheme = snapshot.settings.theme;
  const conversation = store.createConversation(snapshot.activeProjectId, "Long transcript fixture");
  const weightedConversation = store.createConversation(
    snapshot.activeProjectId,
    "Weighted transcript fixture",
    { activate: false },
  );
  const fixturePrefix = `virtual-e2e-${randomUUID()}`;
  const baseTime = Date.now() - 180_000;
  for (let index = 0; index < 120; index += 1) {
    const requestedAt = new Date(baseTime + index * 1_000).toISOString();
    const startedAt = new Date(baseTime + index * 1_000 + 100).toISOString();
    const completedAt = new Date(baseTime + index * 1_000 + 500).toISOString();
    const id = `${fixturePrefix}-turn-${String(index).padStart(3, "0")}`;
    const { turn } = store.beginAgentTurn({
      id,
      conversationId: conversation.id,
      runId: `${fixturePrefix}-run-${index}`,
      content: `Virtualized request ${index}`,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      model: "gpt-5.6",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 1,
      association: "authoritative",
      requestedAt,
    });
    store.addActivity({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      kind: "tool",
      title: `Checked fixture ${index}`,
      detail: "A measured work-log row for scroll-anchor validation.",
      status: "completed",
    });
    const answer = store.createMessage(
      conversation.id,
      `Final answer ${index}`,
      "assistant",
      [],
      null,
      completedAt,
    );
    store.updateAgentTurnLifecycle(turn.id, {
      status: "completed",
      startedAt,
      completedAt,
      updatedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      terminalReason: "provider-completed",
    });
    store.createTurnGitArtifact({
      id: `${fixturePrefix}-artifact-${index}`,
      turnId: turn.id,
      branch: "main",
      createdAt: completedAt,
    });
    store.completeTurnGitArtifact(turn.id, {
      files: [{
        path: `src/fixtures/turn-${index}.ts`,
        previousPath: null,
        status: "M",
        insertions: 4,
        deletions: 1,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      }],
      insertions: 4,
      deletions: 1,
      status: "ready",
      completeness: "complete",
      patchState: "none",
      capturedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      updatedAt: completedAt,
    });
  }
  const weightedDetail = `weighted-detail-${"x".repeat(2_762)}`;
  for (let index = 0; index < 36; index += 1) {
    const requestedAt = new Date(baseTime + index * 1_000).toISOString();
    const completedAt = new Date(baseTime + index * 1_000 + 500).toISOString();
    const id = `${fixturePrefix}-weighted-${String(index).padStart(2, "0")}`;
    const { turn } = store.beginAgentTurn({
      id,
      conversationId: weightedConversation.id,
      runId: `${fixturePrefix}-weighted-run-${index}`,
      content: `Weighted request ${index}`,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      model: "gpt-5.6",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 1,
      association: "authoritative",
      requestedAt,
    });
    const commentaryCount = index < 29 ? 3 : 2;
    for (let commentary = 0; commentary < commentaryCount; commentary += 1) {
      store.createMessage(
        weightedConversation.id,
        `Commentary ${index}.${commentary}`,
        "assistant",
        [],
        turn.id,
        completedAt,
      );
    }
    for (let activity = 0; activity < 34; activity += 1) {
      store.addActivity({
        conversationId: weightedConversation.id,
        runId: turn.runId,
        turnId: turn.id,
        kind: "command",
        title: `Weighted command ${index}.${activity}`,
        detail: activity === 0 && index === 0
          ? `CLOSED_WEIGHTED_SENTINEL\n${weightedDetail}`
          : weightedDetail,
        status: "completed",
      });
    }
    const answer = store.createMessage(
      weightedConversation.id,
      `Weighted answer ${index}`,
      "assistant",
      [],
      null,
      completedAt,
    );
    store.updateAgentTurnLifecycle(turn.id, {
      status: "completed",
      startedAt: requestedAt,
      completedAt,
      updatedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      terminalReason: "provider-completed",
    });
  }
  store.selectConversation(weightedConversation.id);
  store.close();

  try {
    await page.reload();
    await expect(page.getByRole("heading", {
      name: "Weighted transcript fixture",
      level: 1,
    })).toBeVisible();
    const weightedTranscript = page.getByLabel("Thread transcript");
    const weightedVirtualWindow = weightedTranscript.getByRole("feed", {
      name: "36 conversation turns",
    });
    await expect(weightedVirtualWindow).toBeVisible();
    await expect.poll(
      () => weightedVirtualWindow.locator(".response-virtual-item").count(),
    ).toBeLessThan(24);
    const weightedFeedSemantics = await weightedVirtualWindow.evaluate(
      (feed) => [...feed.children].map((child) => ({
        tagName: child.tagName,
        label: child.getAttribute("aria-label"),
        position: child.getAttribute("aria-posinset"),
        size: child.getAttribute("aria-setsize"),
      })),
    );
    expect(weightedFeedSemantics.length).toBeGreaterThan(0);
    expect(weightedFeedSemantics.every(({ tagName, label, position, size }) =>
      tagName === "ARTICLE"
      && /^Turn \d+: Weighted request \d+$/u.test(label ?? "")
      && Number(position) > 0
      && size === "36")).toBe(true);
    const weightedFeedAx = await weightedVirtualWindow.ariaSnapshot();
    expect(weightedFeedAx).toContain('- feed "36 conversation turns"');
    expect(weightedFeedAx).toMatch(
      /article "Turn \d+: Weighted request \d+"/u,
    );
    expect(await page.locator("body").textContent())
      .not.toContain("CLOSED_WEIGHTED_SENTINEL");

    const selectLong = new RuntimeStore(
      databasePath,
      workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    selectLong.selectConversation(conversation.id);
    selectLong.close();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Long transcript fixture", level: 1 })).toBeVisible();
    const navigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
    if (await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toHaveCount(0);
    }
    const workspacePanel = page.locator(".workspace-panel");
    if (await workspacePanel.isVisible()) {
      await page.getByRole("button", { name: "Close workspace tools" }).first().click();
      await expect(workspacePanel).toBeHidden();
    }

    const transcript = page.getByLabel("Thread transcript");
    const virtualWindow = transcript.getByRole("feed", { name: "120 conversation turns" });
    await expect(virtualWindow).toBeVisible();
    await expect.poll(() => virtualWindow.locator(".response-virtual-item").count()).toBeLessThan(24);
    const minimap = transcript.getByRole("navigation", { name: "Conversation minimap" });
    await expect(minimap).toBeVisible();
    await expect(minimap.getByRole("button")).toHaveCount(12);
    const firstMinimapMarker = minimap.getByRole("button").first();
    await expect(firstMinimapMarker).toHaveAttribute(
      "aria-label",
      "Go to turn 1: Virtualized request 0",
    );
    await expect(firstMinimapMarker).not.toHaveAttribute("title");
    const markerBoundsBeforeHover = await firstMinimapMarker.boundingBox();
    await firstMinimapMarker.hover();
    await expect(firstMinimapMarker).toHaveAttribute(
      "data-emphasized",
      "true",
    );
    const minimapPreview = minimap.locator(".timeline-minimap-preview");
    await expect(minimapPreview).toHaveCount(1);
    await expect(minimapPreview).toHaveText(
      "Turn 1 · Virtualized request 0",
    );
    await expect(minimapPreview).toHaveAttribute("aria-hidden", "true");
    await expect(firstMinimapMarker).not.toHaveAttribute("aria-describedby");
    await expect.poll(() => firstMinimapMarker.evaluate((element) =>
      getComputedStyle(element, "::before").transform)).not.toBe("none");
    expect(await firstMinimapMarker.boundingBox()).toEqual(
      markerBoundsBeforeHover,
    );
    await transcript.hover({ position: { x: 160, y: 160 } });
    await expect(minimapPreview).toHaveCount(0);
    await firstMinimapMarker.focus();
    await expect(minimapPreview).toHaveCount(1);
    await expect(firstMinimapMarker).toHaveAttribute(
      "data-emphasized",
      "true",
    );
    const separation = await page.evaluate(() => {
      const minimapBounds = document.querySelector(".timeline-minimap")?.getBoundingClientRect();
      const visibleTurn = [...document.querySelectorAll<HTMLElement>(".response-turn")]
        .find((turn) => turn.getBoundingClientRect().bottom > 0)
        ?.getBoundingClientRect();
      return minimapBounds && visibleTurn
        ? { minimapRight: minimapBounds.right, turnLeft: visibleTurn.left }
        : null;
    });
    expect(separation).not.toBeNull();
    expect(separation?.minimapRight ?? 0).toBeLessThanOrEqual((separation?.turnLeft ?? 0) + 1);

    await transcript.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    });
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await expect.poll(() => virtualWindow.locator(".response-virtual-item").count()).toBeLessThan(24);
    await page.waitForTimeout(500);
    const expansionProbe = async (summarySelector: string): Promise<{
      anchorId: string;
      sourceId: string;
    } | null> => page.evaluate((selector) => {
      const transcriptElement = document.querySelector<HTMLElement>(".message-scroll");
      if (!transcriptElement) return null;
      const viewport = transcriptElement.getBoundingClientRect();
      const rows = [...document.querySelectorAll<HTMLElement>(".response-virtual-item")];
      const sourceIndex = rows.findIndex((row) => {
        const summary = row.querySelector<HTMLElement>(selector);
        if (!summary) return false;
        const bounds = summary.getBoundingClientRect();
        return bounds.top >= viewport.top + 8 && bounds.bottom <= viewport.bottom - 8;
      });
      const source = sourceIndex >= 0 ? rows[sourceIndex] : undefined;
      const anchor = sourceIndex >= 0 ? rows[sourceIndex + 1] : undefined;
      const anchorTurn = anchor?.querySelector<HTMLElement>("[data-turn-id]");
      const sourceTurn = source?.querySelector<HTMLElement>("[data-turn-id]");
      return anchorTurn?.dataset.turnId && sourceTurn?.dataset.turnId
        ? { anchorId: anchorTurn.dataset.turnId, sourceId: sourceTurn.dataset.turnId }
        : null;
    }, summarySelector);
    const expectExpansionAnchored = async (summarySelector: string): Promise<void> => {
      await transcript.evaluate((element) => {
        element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      });
      await page.waitForTimeout(250);
      let probe = await expansionProbe(summarySelector);
      expect(probe).not.toBeNull();
      if (!probe) return;
      let details = page.locator(`[data-turn-id="${probe.sourceId}"]`).locator(summarySelector).locator("..");
      if (await details.getAttribute("open") !== null) {
        await details.locator("summary").click();
        await page.waitForTimeout(250);
        probe = await expansionProbe(summarySelector);
        expect(probe).not.toBeNull();
        if (!probe) return;
        details = page.locator(`[data-turn-id="${probe.sourceId}"]`).locator(summarySelector).locator("..");
      }
      const before = await page.locator(`[data-turn-id="${probe.anchorId}"]`).evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await details.locator("summary").click();
      await expect.poll(() => page.locator(`[data-turn-id="${probe.anchorId}"]`).evaluate(
        (element, anchorTop) => Math.abs(element.getBoundingClientRect().top - anchorTop),
        before,
      )).toBeLessThanOrEqual(2);
    };
    const expectButtonExpansionAnchored = async (
      selector: string,
      expectedExpandedContent?: string,
    ): Promise<void> => {
      await transcript.evaluate((element) => {
        element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      });
      await page.waitForTimeout(250);
      const probe = await expansionProbe(selector);
      expect(probe).not.toBeNull();
      if (!probe) return;
      const button = page.locator(`[data-turn-id="${probe.sourceId}"]`).locator(selector);
      await button.focus();
      const before = await page.locator(`[data-turn-id="${probe.anchorId}"]`).evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await button.press("Enter");
      await expect(button).toHaveAttribute("aria-expanded", "true");
      if (expectedExpandedContent) {
        await expect(
          page.locator(`[data-turn-id="${probe.sourceId}"]`)
            .getByText(expectedExpandedContent, { exact: true }),
        ).toBeVisible();
      }
      await expect.poll(() => page.locator(`[data-turn-id="${probe.anchorId}"]`).evaluate(
        (element, anchorTop) => Math.abs(element.getBoundingClientRect().top - anchorTop),
        before,
      )).toBeLessThanOrEqual(2);
      await button.press("Enter");
      await expect(button).toHaveAttribute("aria-expanded", "false");
    };
    await expectButtonExpansionAnchored(
      ".turn-run-details-toggle",
      "Execution transcript",
    );
    await expectExpansionAnchored(".turn-changed-files > summary");

    await page.getByRole("button", { name: "Jump to latest" }).click();
    await expect.poll(() => transcript.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(120);
    await transcript.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(page.locator(".response-turn:focus")).toHaveCount(1);
    await page.keyboard.press("Alt+Home");
    await expect(page.locator('[data-turn-jump-target="request"]:focus')).toHaveCount(1);
    await page.keyboard.press("Alt+End");
    await expect(page.locator('[data-turn-jump-target="final"]:focus')).toHaveCount(1);
    await page.keyboard.press("Alt+g");
    await expect(page.locator('[data-turn-jump-target="artifact"]:focus')).toHaveCount(1);

    await transcript.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    });
    await page.waitForTimeout(250);
    const captureReaderAnchor = () => page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".message-scroll")?.getBoundingClientRect();
      if (!viewport) return null;
      const row = [...document.querySelectorAll<HTMLElement>("[data-response-row-id]")]
        .find((element) => element.getBoundingClientRect().bottom > viewport.top + 8);
      return row?.dataset.responseRowId
        ? {
            id: row.dataset.responseRowId,
            offset: row.getBoundingClientRect().top - viewport.top,
          }
        : null;
    });
    const captureReaderAnchorById = (rowId: string) => page.evaluate((id) => {
      const viewport = document.querySelector<HTMLElement>(".message-scroll")
        ?.getBoundingClientRect();
      const row = [...document.querySelectorAll<HTMLElement>("[data-response-row-id]")]
        .find((element) => element.dataset.responseRowId === id);
      return row && viewport
        ? {
            id,
            offset: row.getBoundingClientRect().top - viewport.top,
          }
        : null;
    }, rowId);
    const readerAnchor = await captureReaderAnchor();
    expect(readerAnchor).not.toBeNull();
    await resizeWindow(1180, 820);
    await expect.poll(async () => {
      const current = readerAnchor
        ? await captureReaderAnchorById(readerAnchor.id)
        : null;
      return current && readerAnchor
        ? Math.abs(current.offset - readerAnchor.offset) <= 3
        : false;
    }).toBe(true);
    await page.locator("html").evaluate((element, eventName) => {
      window.dispatchEvent(new Event(eventName));
      element.dataset.interfaceScale = "large";
    }, INTERFACE_SCALE_WILL_CHANGE_EVENT);
    // Large type metrics land on slightly different fractional pixels across
    // Electron renderers. Keep the same row within a bounded half-em rhythm
    // derived from the active scale instead of relying on one platform's
    // subpixel rounding.
    const scaleAnchorTolerance = await page.locator("html").evaluate((element) => {
      const mainFontSize = Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--ui-font-main"),
      );
      return Math.ceil(mainFontSize / 2) + 1;
    });
    await expect.poll(async () => {
      const current = readerAnchor
        ? await captureReaderAnchorById(readerAnchor.id)
        : null;
      return current && readerAnchor
        ? Math.abs(current.offset - readerAnchor.offset)
        : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(scaleAnchorTolerance);
    await page.locator("html").evaluate((element, eventName) => {
      window.dispatchEvent(new Event(eventName));
      element.dataset.interfaceScale = "default";
    }, INTERFACE_SCALE_WILL_CHANGE_EVENT);

    const visualScenarios = [
      { label: "dark-wide-expanded", theme: "dark" as const, colorScheme: "light" as const, width: 1440, height: 920, sidebar: true, tools: true },
      { label: "light-medium-mixed", theme: "light" as const, colorScheme: "dark" as const, width: 1100, height: 760, sidebar: true, tools: false },
      { label: "system-narrow-collapsed", theme: "system" as const, colorScheme: "dark" as const, width: 760, height: 600, sidebar: false, tools: false },
    ];
    for (const scenario of visualScenarios) {
      const settingsStore = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
      settingsStore.updateSettings({ theme: scenario.theme });
      settingsStore.close();
      await page.emulateMedia({ colorScheme: scenario.colorScheme });
      await resizeWindow(scenario.width, scenario.height);
      await page.reload();
      await expect(page.getByRole("heading", { name: "Long transcript fixture", level: 1 })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        scenario.theme === "system" ? scenario.colorScheme : scenario.theme,
      );

      const scenarioNavigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
      if (await scenarioNavigation.isVisible() !== scenario.sidebar) {
        await page.getByRole("button", { name: "Toggle project navigation" }).click();
      }
      if (scenario.sidebar) await expect(scenarioNavigation).toBeVisible();
      else await expect(scenarioNavigation).toBeHidden();

      const scenarioTools = page.locator(".workspace-panel");
      if (await scenarioTools.isVisible() !== scenario.tools) {
        if (scenario.tools) await page.getByRole("button", { name: "Open workspace tools" }).click();
        else await page.getByRole("button", { name: "Close workspace tools" }).first().click();
      }
      if (scenario.tools) await expect(scenarioTools).toBeVisible();
      else await expect(scenarioTools).toBeHidden();

      const scenarioTranscript = page.getByLabel("Thread transcript");
      await scenarioTranscript.evaluate((element) => {
        element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      });
      await page.waitForTimeout(350);
      await expect.poll(() => scenarioTranscript.locator(".response-virtual-item").count()).toBeLessThan(24);
      await expect.poll(() => page.evaluate(() => {
        const transcriptElement = document.querySelector<HTMLElement>(".message-scroll");
        if (!transcriptElement) return false;
        const viewport = transcriptElement.getBoundingClientRect();
        const rows = [...document.querySelectorAll<HTMLElement>(".response-virtual-item")]
          .map((row) => row.getBoundingClientRect())
          .filter((bounds) => bounds.bottom > viewport.top && bounds.top < viewport.bottom)
          .sort((left, right) => left.top - right.top);
        return rows.length > 0 && rows.every((bounds, index) =>
          index === 0 || rows[index - 1]!.bottom <= bounds.top + 1);
      })).toBe(true);
      const geometry = await page.evaluate(() => {
        const transcriptElement = document.querySelector<HTMLElement>(".message-scroll");
        const composer = document.querySelector<HTMLElement>(".composer");
        const frame = document.querySelector<HTMLElement>(".workspace-frame");
        if (!transcriptElement || !composer || !frame) return null;
        const viewport = transcriptElement.getBoundingClientRect();
        const composerBounds = composer.getBoundingClientRect();
        const frameBounds = frame.getBoundingClientRect();
        const rows = [...document.querySelectorAll<HTMLElement>(".response-virtual-item")]
          .map((row) => row.getBoundingClientRect())
          .filter((bounds) => bounds.bottom > viewport.top && bounds.top < viewport.bottom)
          .sort((left, right) => left.top - right.top);
        const minimap = document.querySelector<HTMLElement>(".timeline-minimap")?.getBoundingClientRect() ?? null;
        const visibleTurn = [...document.querySelectorAll<HTMLElement>(".response-turn")]
          .map((turn) => turn.getBoundingClientRect())
          .find((bounds) => bounds.bottom > viewport.top && bounds.top < viewport.bottom) ?? null;
        return {
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          frameInsideViewport: frameBounds.left >= -1
            && frameBounds.top >= -1
            && frameBounds.right <= window.innerWidth + 1
            && frameBounds.bottom <= window.innerHeight + 1,
          transcriptClearOfComposer: viewport.bottom <= composerBounds.top + 1,
          rowsInsideTranscript: rows.every((bounds) =>
            bounds.left >= viewport.left - 1
            && bounds.right <= viewport.right + 1),
          rowsDoNotOverlap: rows.every((bounds, index) =>
            index === 0 || rows[index - 1]!.bottom <= bounds.top + 1),
          minimapClearOfText: !minimap || !visibleTurn || minimap.right <= visibleTurn.left + 1,
          scrollTop: transcriptElement.scrollTop,
          firstRowTop: rows[0]?.top ?? null,
        };
      });
      expect(geometry).not.toBeNull();
      if (geometry) {
        expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.innerWidth + 1);
        expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.innerHeight + 1);
        expect(geometry.frameInsideViewport).toBe(true);
        expect(geometry.transcriptClearOfComposer).toBe(true);
        expect(geometry.rowsInsideTranscript).toBe(true);
        expect(geometry.rowsDoNotOverlap).toBe(true);
        expect(geometry.minimapClearOfText).toBe(true);
        await page.waitForTimeout(160);
        const stableGeometry = await page.evaluate(() => {
          const transcriptElement = document.querySelector<HTMLElement>(".message-scroll");
          const firstRow = [...document.querySelectorAll<HTMLElement>(".response-virtual-item")]
            .find((row) => {
              const bounds = row.getBoundingClientRect();
              const viewport = transcriptElement?.getBoundingClientRect();
              return viewport && bounds.bottom > viewport.top && bounds.top < viewport.bottom;
            });
          return {
            scrollTop: transcriptElement?.scrollTop ?? null,
            firstRowTop: firstRow?.getBoundingClientRect().top ?? null,
          };
        });
        expect(stableGeometry.scrollTop).not.toBeNull();
        expect(Math.abs((stableGeometry.scrollTop ?? 0) - geometry.scrollTop)).toBeLessThanOrEqual(1);
        if (geometry.firstRowTop !== null && stableGeometry.firstRowTop !== null) {
          expect(Math.abs(stableGeometry.firstRowTop - geometry.firstRowTop)).toBeLessThanOrEqual(1);
        }
      }
      const screenshotPath = test.info().outputPath(`long-thread-${scenario.label}.png`);
      await page.screenshot({ animations: "disabled", path: screenshotPath });
      await test.info().attach(`long-thread-${scenario.label}`, {
        path: screenshotPath,
        contentType: "image/png",
      });
    }
    expect(rendererErrors).toEqual([]);
  } finally {
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
    cleanup.updateSettings({ theme: originalTheme });
    cleanup.selectConversation(previousConversationId);
    cleanup.deleteConversation(conversation.id);
    cleanup.deleteConversation(weightedConversation.id);
    cleanup.close();
    await page.emulateMedia({ colorScheme: "no-preference" });
    await page.reload();
    await resizeWindow(1440, 920);
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
