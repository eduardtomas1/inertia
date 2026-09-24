// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";

import { RuntimeStore } from "../../src/server/database";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";
import { createQuietLedgerFixture } from "./support/quiet-ledger-fixture";
import { revealVirtualizedTimelineTurn } from "./support/markdown-controls";

let app!: AppFixture;

test.beforeEach(async () => {
  app = await createAppFixture({
    name: "activity-lifecycle",
    initialState: "conversation",
    windowDisplay: "primary",
  });
});

test.afterEach(async () => {
  await app.close();
});

for (const startup of ["shown", "hidden"] as const) {
  test(`keeps an edit-heavy completed patch history terminal without historical animation work (${startup} window)`, async ({
    browserName: _browserName,
  }, testInfo) => {
    const fixture = createQuietLedgerFixture({
      testDirectory: app.testDirectory,
      workspaceDirectory: app.workspaceDirectory,
    });
    const store = new RuntimeStore(
      fixture.databasePath,
      app.workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    for (let index = 0; index < 320; index += 1) {
      store.addActivity({
        conversationId: fixture.conversation.id,
        runId: fixture.active.turn.runId,
        turnId: fixture.active.turn.id,
        kind: "tool",
        title: "Patch updated",
        detail: "Diff:\nedit-heavy fixture patch " + index,
        status: "completed",
        createdAt: fixture.activeAt(15 + index / 1_000),
      });
    }
    const durablePatches = store.conversationDetail(fixture.conversation.id)
      ?.activities.filter(({ title }) => title === "Patch updated") ?? [];
    store.close();

    if (startup === "hidden") {
      await app.electronApp.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length !== 1) throw new Error("Expected the sole fixture window.");
        windows[0]!.hide();
      });
    }
    await app.page.reload();
    await expect(app.page.getByRole("heading", {
      name: "Quiet Ledger visual fixture",
      level: 1,
    })).toBeVisible();
    const activeTurn = app.page.locator(
      '[data-turn-id="' + fixture.active.turn.id + '"]',
    );
    await revealVirtualizedTimelineTurn({
      page: app.page,
      target: activeTurn,
      conversationId: fixture.conversation.id,
      turnId: fixture.active.turn.id,
      testInfo,
    });

    const historyButton = activeTurn.getByRole("button", {
      name: "1 command, 1 edit, 320 tool calls",
    });
    await expect(historyButton).toBeVisible();
    await expect(historyButton).toHaveAttribute("aria-expanded", "false");
    const patchRows = activeTurn.locator(".agent-activity", {
      hasText: "Patch updated",
    });
    await expect(patchRows).toHaveCount(5);
    await expect(patchRows.locator(".lucide-wrench")).toHaveCount(5);
    if (startup === "hidden") {
      // A native window that has not painted must not retain entrance work for
      // completed history. Do not fast-forward, cancel or ignore pending work.
      const pending = await patchRows.evaluateAll((rows) => rows.flatMap((row) =>
        row.getAnimations({ subtree: true }).filter((animation) =>
          animation.pending || animation.playState === "running").map((animation) => ({
            type: animation.constructor.name,
            property: animation instanceof CSSTransition ? animation.transitionProperty : null,
            pending: animation.pending,
            currentTime: animation.currentTime,
          }))));
      expect(pending).toEqual([]);
      await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
    }
    await expect.poll(() => patchRows.evaluateAll((rows) => {
      const animations = new Set<Animation>();
      for (const row of rows) {
        for (const animation of row.getAnimations({ subtree: true })) {
          if (animation.playState === "running") animations.add(animation);
        }
      }
      return animations.size;
    })).toBe(0);

    const trace = await patchRows.evaluateAll((rows) => {
      const retainedAnimations = new Set<Animation>();
      const activeAnimations = new Set<Animation>();
      for (const row of rows) {
        for (const animation of row.getAnimations({ subtree: true })) {
          retainedAnimations.add(animation);
          if (animation.playState === "running") {
            activeAnimations.add(animation);
          }
        }
      }
      return {
        mountedPatchRows: rows.length,
        runningPatchRows: rows.filter((row) =>
          row.classList.contains("is-running")).length,
        completedPatchRows: rows.filter((row) =>
          row.classList.contains("is-completed")).length,
        retainedPatchAnimationCount: retainedAnimations.size,
        activePatchAnimationCount: activeAnimations.size,
        documentAnimationCount: document.getAnimations().length,
      };
    });
    const evidence = {
      durablePatchRows: durablePatches.length,
      durableRunningPatchRows: durablePatches.filter(({ status }) =>
        status === "running").length,
      ...trace,
    };
    expect(evidence).toMatchObject({
      durablePatchRows: 320,
      durableRunningPatchRows: 0,
      mountedPatchRows: 5,
      runningPatchRows: 0,
      completedPatchRows: 5,
      activePatchAnimationCount: 0,
    });

    const traceBody = Buffer.from(JSON.stringify(evidence, null, 2));
    await testInfo.attach("edit-heavy-patch-animation-trace", {
      body: traceBody,
      contentType: "application/json",
    });
    const screenshotPath = testInfo.outputPath(
      "edit-heavy-patch-history-terminal.png",
    );
    await activeTurn.screenshot({
      animations: "disabled",
      path: screenshotPath,
    });
    await testInfo.attach("edit-heavy-patch-history-terminal", {
      path: screenshotPath,
      contentType: "image/png",
    });
    expect(app.rendererErrors).toEqual([]);
  });
}
