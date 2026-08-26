import { expect, test } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];
let conversationId = "";

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "browser-lifecycle",
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
          throw new Error("The Browser lifecycle fixture needs a conversation.");
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

test("shares one directly openable Browser across user, agent, and restart lifecycles", async ({
  browserName: _browserName,
}, testInfo) => {
  await app.resizeWindow(1_440, 920);
  await page.keyboard.press("Escape");

  const browserButton = page.getByRole("button", {
    name: "Open Browser",
    exact: true,
  });
  await expect(browserButton).toHaveAttribute("aria-pressed", "false");
  await browserButton.click();
  const workspaceTools = page.getByRole("complementary", {
    name: "Workspace tools",
  });
  await expect(workspaceTools).toBeVisible();
  await expect(workspaceTools.getByRole("tab", { name: "Browser" }))
    .toHaveAttribute("aria-selected", "true");
  await expect(workspaceTools.locator(".preview-tabs").getByRole("tab"))
    .toHaveCount(1);
  await expect(workspaceTools.getByRole("textbox", {
    name: "Preview address",
  })).toHaveValue("");

  const emptyScreenshot = testInfo.outputPath("browser-direct-empty.png");
  await page.screenshot({ animations: "disabled", path: emptyScreenshot });
  await testInfo.attach("browser-direct-empty", {
    path: emptyScreenshot,
    contentType: "image/png",
  });

  await workspaceTools.getByRole("button", {
    name: "Close workspace tools",
  }).click();
  ({ page } = await app.restart());
  await expect(page.getByRole("button", { name: "Open Browser", exact: true }))
    .toHaveAttribute("aria-pressed", "false");

  const agentUrl = `${app.previewUrl}agent-browser-page`;
  const agentFirst = await app.electronApp.evaluate(
    async (_electron, request) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          conversationId: string,
          command: { action: "navigate"; url: string },
        ) => Promise<{ ok: boolean }>;
      };
      return await runtime.agentBrowser(request.conversationId, {
        action: "navigate",
        url: request.url,
      });
    },
    { conversationId, url: agentUrl },
  );
  expect(agentFirst).toMatchObject({ ok: true });

  await page.getByRole("button", { name: "Open Browser", exact: true }).click();
  const sharedTools = page.getByRole("complementary", {
    name: "Workspace tools",
  });
  await expect(sharedTools.getByRole("textbox", {
    name: "Preview address",
  })).toHaveValue(agentUrl);
  await expect(sharedTools.locator(".preview-tabs").getByRole("tab"))
    .toHaveCount(1);
  await expect.poll(() => app.nativePreviewIsVisible(agentUrl)).toBe(true);

  const screenshot = await app.electronApp.evaluate(
    async (_electron, id) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          conversationId: string,
          command: { action: "screenshot" },
        ) => Promise<Record<string, unknown>>;
      };
      return await runtime.agentBrowser(id, { action: "screenshot" });
    },
    conversationId,
  );
  expect(screenshot).toMatchObject({ ok: true });
  expect(screenshot).not.toHaveProperty("image");
  const screenshotEvidence = JSON.parse(String(screenshot.text)) as {
    bitmap: string;
    providerImage: boolean;
  };
  expect(screenshotEvidence).toMatchObject({
    bitmap: "local-only",
    providerImage: false,
  });
  await expect(sharedTools.getByRole("button", { name: /Evidence [1-9]/u }))
    .toBeVisible();

  const sharedScreenshot = testInfo.outputPath("browser-agent-shared.png");
  await page.screenshot({ animations: "disabled", path: sharedScreenshot });
  await testInfo.attach("browser-agent-shared", {
    path: sharedScreenshot,
    contentType: "image/png",
  });

  await sharedTools.getByRole("button", {
    name: "Close workspace tools",
  }).click();
  ({ page } = await app.restart());
  await expect.poll(() => app.electronApp.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().some(
      (contents) => contents.getURL() === url,
    ),
    agentUrl,
  )).toBe(false);
  const restarted = await app.electronApp.evaluate(
    async (_electron, id) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          conversationId: string,
          command: { action: "tabs" },
        ) => Promise<{
          ok: boolean;
          state?: { tabs: Array<{ url: string }> };
        }>;
      };
      return await runtime.agentBrowser(id, { action: "tabs" });
    },
    conversationId,
  );
  expect(restarted).toMatchObject({
    ok: true,
    state: { tabs: [{ url: "" }] },
  });
  expect(app.rendererErrors).toEqual([]);
});
