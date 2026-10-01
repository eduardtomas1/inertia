// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import type { ServerEvent } from "../../src/shared/contracts";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";
import { closeWorkspaceTools } from "./support/workspace-tools";

let app!: AppFixture;
let sourceId = "";
let sourceBranch = "";
test.beforeAll(async () => {
  app = await createAppFixture({
    name: "provider-continuation", initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        sourceId = store.shellSnapshot().activeConversationId!;
        sourceBranch = execFileSync("git", ["branch", "--show-current"], { cwd: workspaceDirectory, encoding: "utf8" }).trim();
        store.updateConversation(sourceId, { title: "Make retries safe", branch: sourceBranch, providerSessionId: "source-codex-session" });
        const turn = store.beginAgentTurn({
          id: randomUUID(), conversationId: sourceId, runId: randomUUID(),
          content: "Keep retries idempotent and preserve the existing cursor format.",
          providerId: "codex", harnessId: "codex-app-server", backendProfileId: "builtin:openai", model: "provider-default", reasoningEffort: "",
          interactionMode: "build", accessMode: "supervised", configurationRevision: 0, association: "authoritative", requestedAt: "2026-09-30T09:00:00.000Z",
        }).turn;
        const answer = store.createMessage(sourceId, "The retry state now persists after each batch. Next, verify restart recovery and add the missing regression test.", "assistant", [], turn.id, "2026-09-30T09:01:00.000Z");
        store.updateAgentTurnLifecycle(turn.id, { status: "completed", completedAt: answer.createdAt, updatedAt: answer.createdAt, terminalAssistantMessageId: answer.id, terminalReason: "provider-completed" });
      } finally { store.close(); }
    },
  });
  // Only discovery readiness is stubbed; creation, context, and checkout checks
  // use the real runtime. No real provider is launched by this draft workflow.
  await app.page.routeWebSocket(/.*/u, (route) => {
    route.connectToServer().onMessage((data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      const snapshot = event.type === "server.welcome" || event.type === "snapshot.updated" ? event.snapshot
        : event.type === "runtime.event" && event.event.type === "snapshot.updated" ? event.event.snapshot : null;
      if (snapshot) snapshot.providers = snapshot.providers.map((provider) => provider.id === "claude"
        ? { ...provider, available: true, installState: "installed", authState: "authenticated", canRun: true } : provider);
      route.send(JSON.stringify(event));
    });
  });
  await app.page.reload();
});
test.afterAll(async () => { await app?.close(); });

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function expectPromptLayoutHolds(page: Page): Promise<void> {
  await app.expectNoViewportOverflow();
  await expectComposerEndsAtDock(page.getByRole("region", { name: "Message composer" }));
  const prompt = page.getByRole("alertdialog", { name: /^Open a new chat for/u });
  const layout = await prompt.evaluate((element) => {
    const buttons = [...element.querySelectorAll<HTMLElement>(":scope > button")].map((button) => button.getBoundingClientRect());
    return {
      overflow: element.scrollWidth - element.clientWidth,
      primaries: element.querySelectorAll(":scope > .primary-button").length,
      rows: new Set(buttons.map(({ top }) => Math.round(top))).size,
      inside: buttons.every(({ left, right }) => left >= element.getBoundingClientRect().left - 1 && right <= element.getBoundingClientRect().right + 1),
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.primaries).toBe(1);
  expect(layout.rows).toBe(1);
  expect(layout.inside).toBe(true);
}

async function expectDialogLayoutHolds(page: Page, dialog: Locator): Promise<void> {
  await app.expectNoViewportOverflow();
  const layout = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const footer = [...element.querySelectorAll<HTMLElement>("footer button")].map((button) => button.getBoundingClientRect());
    return {
      overflow: element.scrollWidth - element.clientWidth,
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight,
      backdrop: element.parentElement?.classList.contains("dialog-backdrop") ?? false,
      footerAligned: footer.length === 2 && Math.abs(footer[0]!.bottom - footer[1]!.bottom) <= 1,
      nested: [...element.querySelectorAll("button")].filter((button) => button.parentElement?.closest("button, label")).length,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.width);
  expect(layout.bottom).toBeLessThanOrEqual(layout.height);
  expect(layout.backdrop).toBe(true);
  expect(layout.footerAligned).toBe(true);
  expect(layout.nested).toBe(0);
}

test("continues a provider-bound chat with selected context, retains drafts, and survives restart", async ({ browserName: _browserName }, testInfo) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await closeWorkspaceTools(page);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Preserve unrelated changes.");
  await page.getByRole("button", { name: /^Choose model\./u }).click();
  const chooser = page.getByRole("dialog", { name: "Choose model" });
  await chooser.getByRole("button", { name: /^Claude, \d+ models?$/u }).click();
  await chooser.getByRole("gridcell").first().click();
  const trigger = page.getByRole("button", { name: "Continue with context…", exact: true });
  await expect(trigger).toBeVisible();
  await setAppearanceInPlace(app, "dark");
  await expectPromptLayoutHolds(page);
  await capture(page, testInfo, "provider-continuation-prompt-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, testInfo, "provider-continuation-prompt-light-wide");
  await app.resizeWindow(1000, 800);
  await expectPromptLayoutHolds(page);
  await capture(page, testInfo, "provider-continuation-prompt-light-narrow");
  await app.resizeWindow(1440, 920);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /^Continue with/u });
  await expect(dialog.getByText("The retry state now persists", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "2 of 2 messages selected" })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Next instruction (optional)" }).fill("Review restart recovery and add the regression test.");
  await expectDialogLayoutHolds(page, dialog);
  await capture(page, testInfo, "provider-continuation-preview");
  await setAppearanceInPlace(app, "dark");
  await capture(page, testInfo, "provider-continuation-preview-dark-wide");
  await app.resizeWindow(1000, 800);
  await expectDialogLayoutHolds(page, dialog);
  await capture(page, testInfo, "provider-continuation-preview-dark-narrow");
  await setAppearanceInPlace(app, "light");
  await capture(page, testInfo, "provider-continuation-preview-light-narrow");
  await setAppearanceInPlace(app, "dark");
  await app.resizeWindow(760, 600);
  await expectDialogLayoutHolds(page, dialog);
  await capture(page, testInfo, "provider-continuation-preview-dark-760x600");
  await setAppearanceInPlace(app, "light");
  await app.resizeWindow(760, 800);
  await expect(dialog.getByRole("button", { name: "Create continuation" })).toBeVisible();
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { fits: element.scrollWidth <= element.clientWidth + 1, left: rect.left, right: rect.right, width: innerWidth, bottom: rect.bottom, height: innerHeight };
  });
  expect(geometry.fits).toBe(true);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  await dialog.getByRole("button", { name: "Create continuation" }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue("Preserve unrelated changes.\n\nReview restart recovery and add the regression test.");
  await expect(page.getByRole("button", { name: /From Make retries safe/u })).toBeVisible();
  await app.resizeWindow(1440, 920);
  const destination = testInfo.outputPath("provider-continuation-draft.png");
  await page.screenshot({ path: destination, animations: "disabled" });
  await testInfo.attach("provider-continuation-draft", { path: destination, contentType: "image/png" });
  const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
  let targetId = "";
  try {
    targetId = store.shellSnapshot().activeConversationId!;
    expect(targetId).not.toBe(sourceId);
    expect(store.conversation(targetId)).toMatchObject({ providerId: "claude", branch: sourceBranch, worktreePath: null, providerSessionId: null, continuationIdentity: null });
    expect(store.hasConversationMessages(targetId)).toBe(false);
    expect(store.hasConversationTurns(targetId)).toBe(false);
    expect(store.contextPackets.list(targetId)).toEqual([expect.objectContaining({ sourceConversationId: sourceId, messageCount: 2, consumedMessageId: null })]);
    expect(store.conversation(sourceId)).toMatchObject({ providerId: "codex", providerSessionId: "source-codex-session" });
  } finally { store.close(); }
  const restarted = await app.restart();
  await expect(restarted.page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Preserve unrelated changes.\n\nReview restart recovery and add the regression test.");
  await expect(restarted.page.getByRole("button", { name: /From Make retries safe/u })).toBeVisible();
  expect(app.rendererErrors).toEqual([]);
});
