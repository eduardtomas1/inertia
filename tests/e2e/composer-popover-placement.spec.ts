import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import {
  PROMPT_STASH_CHANGED_EVENT,
  PROMPT_STASH_STORAGE_KEY,
} from "../../src/renderer/src/utils/promptStash";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

const codexAppServerSource = `
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "composer-popover-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [{
      id: "model-a",
      model: "model-a",
      displayName: "Model A",
      description: "Popover placement fixture",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Quick" },
        { reasoningEffort: "high", description: "Careful" },
      ],
      defaultReasoningEffort: "high",
      inputModalities: ["text"],
      serviceTiers: [{
        id: "priority",
        name: "Fast",
        description: "Faster responses",
      }],
      defaultServiceTier: null,
      isDefault: true,
    }], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: {
      rateLimits: null,
      rateLimitsByLimitId: null,
    } });
  }
});
`;

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "composer-popover-placement",
    initialState: "conversation",
    seedSecondProject: true,
    codexAppServerSource,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const selection = providerNativeModelSelection({
        providerId: "codex",
        modelId: "model-a",
        reasoningEffort: "high",
      });
      const continuationIdentity = continuationIdentityForSelection(
        selection,
        null,
        false,
      );
      for (const conversation of store.shellSnapshot().conversations) {
        store.updateConversation(conversation.id, {
          modelSelection: selection,
          continuationIdentity,
        });
      }
      store.close();
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

test.setTimeout(90_000);

async function expectContained(popover: Locator): Promise<{
  internallyScrollable: boolean;
  vertical: string | undefined;
  horizontal: string | undefined;
}> {
  const inspect = () => popover.evaluateAll((elements) => {
    const element = elements.length === 1 ? elements[0] : undefined;
    if (!(element instanceof HTMLElement)) return null;
    const bounds = element.getBoundingClientRect();
    const workspace = element.closest<HTMLElement>(".chat-workspace")
      ?.getBoundingClientRect();
    const pane = element.closest<HTMLElement>(".conversation-split-pane")
      ?.getBoundingClientRect();
    const positioned = element.closest<HTMLElement>(
      '[data-composer-popover-positioned="true"]',
    );
    return {
      bounds: {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
      },
      workspace: workspace ? {
        top: workspace.top,
        right: workspace.right,
        bottom: workspace.bottom,
        left: workspace.left,
      } : null,
      pane: pane ? {
        top: pane.top,
        right: pane.right,
        bottom: pane.bottom,
        left: pane.left,
      } : null,
      insideWorkspace: Boolean(
        workspace
        && bounds.top >= workspace.top + 7
        && bounds.right <= workspace.right - 7
        && bounds.bottom <= workspace.bottom - 7
        && bounds.left >= workspace.left + 7
      ),
      insidePane: Boolean(
        pane
        && bounds.top >= pane.top
        && bounds.right <= pane.right
        && bounds.bottom <= pane.bottom
        && bounds.left >= pane.left
      ),
      insideViewport:
        bounds.top >= 0
        && bounds.right <= window.innerWidth
        && bounds.bottom <= window.innerHeight
        && bounds.left >= 0,
      internallyScrollable:
        getComputedStyle(element).overflowY === "auto"
        && element.scrollHeight > element.clientHeight + 1,
      vertical: positioned?.dataset.popoverVertical,
      horizontal: positioned?.dataset.popoverHorizontal,
    };
  });
  try {
    await expect.poll(inspect, { timeout: 3_000 }).toMatchObject({
      insideWorkspace: true,
      insidePane: true,
      insideViewport: true,
    });
  } catch {
    const finalGeometry = await inspect();
    expect(finalGeometry, JSON.stringify(finalGeometry)).toMatchObject({
      insideWorkspace: true,
      insidePane: true,
      insideViewport: true,
    });
  }
  const geometry = await inspect();
  expect(geometry, JSON.stringify(geometry)).toMatchObject({
    insideWorkspace: true,
    insidePane: true,
    insideViewport: true,
  });
  if (!geometry) throw new Error("The composer popover was not attached.");
  return geometry;
}

async function capture(testInfo: TestInfo, name: string): Promise<void> {
  const output = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    path: output,
    scale: "device",
  });
  await testInfo.attach(name, { path: output, contentType: "image/png" });
  if (process.env.INERTIA_CAPTURE_PR_ASSETS === "1") {
    await page.screenshot({
      animations: "disabled",
      path: join(process.cwd(), "docs", "screenshots", `${name}.png`),
      scale: "device",
    });
  }
}

test("keeps every composer utility popover inside both split panes", async (
  { browserName: _browserName },
  testInfo,
) => {
  await app.resizeWindow(1_180, 640);
  await page.evaluate(() => window.localStorage.setItem(
    "inertia:layout:conversation-split-percent:v1",
    "50",
  ));
  await page.evaluate(({ storageKey, changedEvent }) => {
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      entries: Array.from({ length: 12 }, (_, index) => ({
        id: `popover-fixture-${index}`,
        content: `Saved scratch prompt ${index + 1}: verify the active pane boundary`,
        createdAt: new Date(Date.UTC(2026, 7, 1, 10, index)).toISOString(),
        route: {
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "model-a",
          reasoningEffort: "high",
          fastMode: false,
        },
      })),
    }));
    window.dispatchEvent(new Event(changedEvent));
  }, {
    storageKey: PROMPT_STASH_STORAGE_KEY,
    changedEvent: PROMPT_STASH_CHANGED_EVENT,
  });
  const secondaryTitle = "composer-popover-placement companion";
  const sidebar = page.getByRole("complementary", {
    name: "Project navigation",
  });
  await sidebar.getByRole("button", {
    name: `Thread actions for ${secondaryTitle}`,
  }).click();
  await sidebar.getByRole("menuitem", {
    name: "Add this chat to split view",
  }).click();

  const primary = page.getByRole("region", {
    name: "Primary chat: Inertia · composer-popover-placement fixture",
  });
  const secondary = page.getByRole("region", {
    name: `Second chat: Companion · ${secondaryTitle}`,
  });
  const separator = page.getByRole("separator", {
    name: "Resize split chats",
  });
  const refreshModels = primary.getByRole("button", {
    name: "Refresh",
    exact: true,
  });
  if (await refreshModels.isVisible()) await refreshModels.click();
  await expect(primary.getByText(
    "Saved model availability is not current",
    { exact: true },
  )).toHaveCount(0, { timeout: 20_000 });

  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.composerUnpositionedVisible = "false";
    const inspect = (): void => {
      for (const element of document.querySelectorAll<HTMLElement>(
        ".composer .popover-anchor > .composer-popover, "
          + ".composer .composer-more-layer",
      )) {
        if (
          element.dataset.composerPopoverPositioned !== "true"
          && getComputedStyle(element).visibility !== "hidden"
        ) {
          root.dataset.composerUnpositionedVisible = "true";
        }
      }
    };
    new MutationObserver(inspect).observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  });
  await primary.getByRole("button", {
    name: /^Scratch prompts/u,
  }).click();
  const menu = primary.getByRole("menu", { name: "Scratch prompts" });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute(
    "data-composer-popover-positioned",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-composer-unpositioned-visible",
    "false",
  );
  await separator.focus();
  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "30");
  const bottomLeft = await expectContained(menu);
  expect(bottomLeft.internallyScrollable).toBe(true);
  await capture(testInfo, "pr-221-popover-bottom-left-scratch");
  await page.keyboard.press("Escape");

  await app.resizeWindow(1_880, 720);
  await separator.focus();
  await separator.press("Enter");
  await expect(separator).toHaveAttribute("aria-valuenow", "50");

  const primaryMore = primary.getByRole("button", {
    name: "More composer options",
  });
  await primaryMore.focus();
  await primaryMore.press("ArrowDown");
  const primaryRoot = primary.getByRole("menu", {
    name: "More composer options",
  });
  const primaryLayer = primary.locator(".composer-more-layer");
  const primaryRootSurface = primary.locator(".composer-more-popover");
  await expect(primaryRoot).toBeVisible();
  await expectContained(primaryRoot);
  await expect(primaryLayer).toHaveAttribute(
    "data-composer-submenu-side",
    /^(left|right)$/u,
  );
  const reasoningItem = primaryRoot.getByRole("menuitem", {
    name: /^Reasoning\b/u,
  });
  await expect(reasoningItem).toBeEnabled();
  await reasoningItem.focus();
  await reasoningItem.press("ArrowRight");
  const reasoningMenu = primary.locator(
    '.composer-more-submenu[aria-label="Reasoning options"]',
  );
  await expect(reasoningMenu).toBeVisible();
  await expect(reasoningMenu.getByRole("menuitemradio").first()).toBeFocused();
  await expectContained(primaryRootSurface);
  await expectContained(reasoningMenu);
  await capture(testInfo, "pr-221-popover-center-left-reasoning");
  await page.keyboard.press("Escape");
  await expect(primaryMore).toBeFocused();

  const secondaryMore = secondary.getByRole("button", {
    name: "More composer options",
  });
  await secondaryMore.focus();
  await secondaryMore.press("ArrowDown");
  const secondaryRoot = secondary.getByRole("menu", {
    name: "More composer options",
  });
  const secondaryLayer = secondary.locator(".composer-more-layer");
  const secondaryRootSurface = secondary.locator(".composer-more-popover");
  await expect(secondaryLayer).toHaveAttribute(
    "data-composer-submenu-side",
    /^(left|right)$/u,
  );
  const speedItem = secondaryRoot.getByRole("menuitem", {
    name: /^Response speed\b/u,
  });
  await expect(speedItem).toBeVisible();
  await speedItem.focus();
  await speedItem.press("ArrowRight");
  const speedMenu = secondary.getByRole("menu", {
    name: "Response speed options",
    exact: true,
  });
  await expect(speedMenu).toBeVisible();
  await expect(speedMenu.getByRole("menuitemradio").first()).toBeFocused();
  await expectContained(secondaryRootSurface);
  await expectContained(speedMenu);
  await app.resizeWindow(1_840, 680);
  await expectContained(secondaryRootSurface);
  await expectContained(speedMenu);
  await capture(testInfo, "pr-221-popover-center-right-response-speed");
  await page.keyboard.press("Escape");
  await expect(secondaryMore).toBeFocused();

  await app.resizeWindow(1_180, 640);
  await separator.focus();
  await separator.press("Enter");
  await secondary.getByRole("button", {
    name: /^Scratch prompts/u,
  }).click();
  const secondaryScratch = secondary.getByRole("menu", {
    name: "Scratch prompts",
  });
  await expect(secondaryScratch).toBeVisible();
  await separator.focus();
  await separator.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "70");
  const bottomRight = await expectContained(secondaryScratch);
  expect(bottomRight.internallyScrollable).toBe(true);
  await capture(testInfo, "pr-221-popover-bottom-right-scratch");
  await page.keyboard.press("Escape");

  await expect(page.locator("html")).toHaveAttribute(
    "data-composer-unpositioned-visible",
    "false",
  );
  expect(app.rendererErrors).toEqual([]);
});
