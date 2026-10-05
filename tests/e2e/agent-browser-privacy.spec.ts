// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { expectClosedShadowActivationBlocked, expectDocumentStartPrivacyGuard, expectFocusNavigationSettlement, expectPasswordAssignmentPrivacyGuard, expectScreenshotPrivacyGuard, expectStructuralCoverage, expectWindowCapturePrivacyGuard } from "./support/agent-browser-security";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";
import { expectSensitiveFieldInteraction } from "./support/agent-browser-sensitive-interaction";

let app!: AppFixture;
let page!: AppFixture["page"];
let conversationId = "";

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "agent-browser-privacy",
    initialState: "conversation",
    windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      try {
        const conversation = store.snapshot().conversations[0];
        if (!conversation) {
          throw new Error("The Agent Browser privacy fixture needs a conversation.");
        }
        conversationId = conversation.id;
      } finally {
        store.close();
      }
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app?.close();
});

test("enforces Agent Browser activation and credential privacy boundaries", async (
  { browserName: _browserName },
  testInfo,
) => {
  await app.resizeWindow(1_440, 920);
  await page.keyboard.press("Escape");

  const workspaceTools = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(workspaceTools, "Browser");
  const workspaceToolsResize = page.getByRole("separator", {
    name: "Resize workspace tools",
  });
  await workspaceToolsResize.press("End");
  await expect(workspaceTools.getByRole("button", { name: /Evidence/u }))
    .toBeVisible();
  await workspaceToolsResize.evaluate((element) => {
    (element as HTMLElement).blur();
  });
  const address = workspaceTools.getByRole("textbox", {
    name: "Preview address",
  });
  const nativePreviewUrl = `${app.previewUrl}primary-project`;
  await address.fill(nativePreviewUrl);
  await workspaceTools.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => app.nativePreviewIsVisible(nativePreviewUrl)).toBe(true);

  await workspaceTools.getByRole("button", { name: "Open browser page" }).click();
  await expect(workspaceTools.locator(".preview-tabs").getByRole("tab"))
    .toHaveCount(2);
  const sourceUrl = `${app.previewUrl}agent-browser-page`;
  await address.fill(sourceUrl);
  await workspaceTools.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => app.electronApp.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().some(
      (contents) => contents.getURL() === url
        && contents.getTitle() === "Agent browser source",
    ),
    sourceUrl,
  )).toBe(true);
  const browserUrl = `${app.previewUrl}agent-browser-type-destination?query=inertia`;
  await expect(app.electronApp.evaluate(
    async (_electron, request) => {
      type Command =
        | { action: "navigate"; url: string }
        | { action: "screenshot" | "snapshot" };
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          conversationId: string,
          command: Command,
        ) => Promise<{ ok: boolean }>;
      };
      const snapshot = await runtime.agentBrowser(request.conversationId, {
        action: "snapshot",
      });
      const navigation = await runtime.agentBrowser(request.conversationId, {
        action: "navigate",
        url: request.url,
      });
      const screenshot = await runtime.agentBrowser(request.conversationId, {
        action: "screenshot",
      });
      return { navigation, screenshot, snapshot };
    },
    { conversationId, url: browserUrl },
  )).resolves.toMatchObject({
    navigation: { ok: true },
    screenshot: { ok: true },
    snapshot: { ok: true },
  });
  await expect.poll(() => app.electronApp.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().some(
      (contents) => contents.getURL() === url
        && contents.getTitle() === "Agent browser type destination",
    ),
    browserUrl,
  )).toBe(true);

  await expectFocusNavigationSettlement(app, conversationId,
    `${app.previewUrl}agent-browser-focus-destination`);
  await expectClosedShadowActivationBlocked(app, conversationId, `${app.previewUrl}agent-browser-closed-disabled-focus`);
  const privacyUrl = `${app.previewUrl}agent-browser-privacy-start`;
  await expectDocumentStartPrivacyGuard(app, conversationId, privacyUrl);
  await expectWindowCapturePrivacyGuard(app, conversationId, `${app.previewUrl}agent-browser-window-capture-privacy`);
  await expectScreenshotPrivacyGuard(app, conversationId,
    `${app.previewUrl}agent-browser-visible-secret-privacy`,
    "sk-visible-browser-screenshot-sentinel-1234567890");
  await expectScreenshotPrivacyGuard(app, conversationId,
    `${app.previewUrl}agent-browser-labeled-secret-privacy`, "hunter2");
  await expectScreenshotPrivacyGuard(app, conversationId,
    `${app.previewUrl}agent-browser-pixel-secret-privacy`,
    "sk-canvas-browser-screenshot-sentinel-1234567890", true);
  await expectPasswordAssignmentPrivacyGuard(app, conversationId,
    `${app.previewUrl}agent-browser-password-assignment-privacy`, workspaceTools);
  for (const [path, secret] of [
    ["agent-browser-nested-privacy-start", "nested-password-sentinel"],
    ["agent-browser-shadow-lifetime-privacy", "removed-shadow-password-sentinel"],
  ]) await expectDocumentStartPrivacyGuard(app, conversationId, `${app.previewUrl}${path}`, secret);
  await expectStructuralCoverage(app, conversationId, `${app.previewUrl}agent-browser-frame-coverage`, {
    notInspected: ["frames"],
    present: "Orders dashboard",
    absent: ["frame-only-sentinel", "frame-password-sentinel"],
  });
  await expectStructuralCoverage(app, conversationId, `${app.previewUrl}agent-browser-shadow-coverage`, {
    notInspected: ["shadow-roots"],
    present: "Component page",
    absent: ["shadow-only-sentinel", "component-value-sentinel"],
  });
  await expectStructuralCoverage(app, conversationId, `${app.previewUrl}agent-browser-declarative-closed-privacy`, {
    notInspected: [],
    absent: ["declarative-closed-shadow-text"],
  });
  for (const [path, visible] of [
    ["agent-browser-declarative-detached-privacy", "detached-declarative-visible-text"],
    ["agent-browser-trusted-types-declarative-detached-privacy", "trusted-types-declarative-visible-text"],
  ]) await expectStructuralCoverage(app, conversationId, `${app.previewUrl}${path}`, {
    notInspected: ["shadow-roots"],
    present: visible,
    absent: ["private"],
  });

  const browserPagesScreenshot = testInfo.outputPath("inertia-browser-pages.png");
  await page.screenshot({ animations: "disabled", path: browserPagesScreenshot });
  await testInfo.attach("inertia-browser-pages", {
    path: browserPagesScreenshot,
    contentType: "image/png",
  });

  expect(app.rendererErrors).toEqual([]);
});

test("keeps React password replacement and same-document MFA usable with hidden values", async () => {
  const workspaceTools = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(workspaceTools, "Browser");
  await expectSensitiveFieldInteraction(app, conversationId, workspaceTools);
});

test("never reports a dialog that echoes text typed into a closed shadow root", async () => {
  const url = `${app.previewUrl}agent-browser-closed-shadow-alert`;
  const evidence = await app.electronApp.evaluate(async ({ webContents }, request) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      agentBrowser: (id: string, command: unknown) => Promise<{ ok: boolean; text?: string }>;
    };
    await runtime.agentBrowser(request.conversationId, { action: "navigate", url: request.url });
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === request.url);
    for (const keyCode of "hunter2") contents?.sendInputEvent({ type: "char", keyCode });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return await runtime.agentBrowser(request.conversationId, { action: "press", key: "Escape" });
  }, { conversationId, url });
  expect(evidence.ok).toBe(true);
  expect(JSON.stringify(evidence)).not.toContain("hunter2");
  expect(JSON.parse(evidence.text ?? "{}")).toMatchObject({
    dialogs: expect.arrayContaining([{ kind: "alert", message: "", answer: "accept" }]),
    dialogsWithheld: true,
  });
});
