// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { waitForStableSample } from "./support/stable-sample";
import { setAppearanceInPlace } from "./support/appearance";
import { capturePageWebSockets, publishCapturedWebSocketEvent } from "./support/browser-websocket-fixture";
import { openTerminalDock, closeWorkspaceTools, ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";
import {
  prepareVisualWorkspaces,
  seedVisualHistory,
  seedVisualLiveTurns,
  VISUAL_FIXED_NOW,
  VISUAL_TITLES,
  visualClaudeAuthSource,
  visualCodexAppServerSource,
  type VisualChat,
  type VisualSeed,
} from "./support/visual-evidence-fixture";

const evidenceDirectory = process.env.INERTIA_VISUAL_EVIDENCE_DIR
  ? resolve(process.env.INERTIA_VISUAL_EVIDENCE_DIR)
  : null;

const selectedSurfaces = new Set((process.env.INERTIA_VISUAL_EVIDENCE_SURFACES ?? "")
  .split(",").map((name) => name.trim()).filter(Boolean));
const WINDOW = { width: 1440, height: 860 } as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
interface Size { width: number; height: number }
const WIDE: Size = { width: 1440, height: 920 };
const EXTRA_SIZES: readonly Size[] = [{ width: 760, height: 600 }, { width: 1920, height: 1200 }];

test.skip(!evidenceDirectory, "Set INERTIA_VISUAL_EVIDENCE_DIR to capture the visual evidence set.");

let app!: AppFixture;
let page!: Page;
let seed!: VisualSeed;
const captured = new Set<string>();

async function setViewport(size: Size): Promise<void> {
  await page.setViewportSize(size);
  await expect.poll(() => page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scale: window.devicePixelRatio,
  }))).toEqual({ ...size, scale: 1 });
}

const TRANSIENT_TEXT = /Checking installation and connection|Saved model availability is not current|Checking Git changes…|Loading diff…|Loading…|Starting a local terminal|Detached HEAD|Searching messages…|Preparing review…|Preparing the complete diff/u;

async function settle(): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await settledSample();
  await page.waitForTimeout(300);
  await settledSample();
}

async function settledSample(): Promise<void> {
  await waitForStableSample(() => page.evaluate(() => new Promise<{
    text: string;
    layout: string;
    moving: string;
    rawModelChip: boolean;
  }>((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const layout = [...document.querySelectorAll<HTMLElement>("body, body *")]
        .filter((element) => element.scrollHeight > element.clientHeight + 1)
        .map((element) => `${element.scrollHeight}:${Math.round(element.scrollTop)}`)
        .concat([...document.querySelectorAll<HTMLElement>("[role='dialog'], [role='menu'], [role='listbox'], [role='alert'], [aria-expanded='true']")]
          .map((element) => {
            const box = element.getBoundingClientRect();
            return `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}`;
          }))
        .join("|");
      const moving = document.getAnimations()
        .filter((animation) => animation.playState === "running"
          && animation.timeline === document.timeline
          && animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => (animation as CSSAnimation).animationName
          ?? (animation as CSSTransition).transitionProperty ?? "animation")
        .join(", ");
      const rawModelChip = [...document.querySelectorAll<HTMLElement>(".selected-model-chip")]
        .some((chip) => /^[a-z0-9][a-z0-9.-]*$/u.test((chip.textContent ?? "").trim()));
      resolveFrame({ text: document.body.innerText, layout, moving, rawModelChip });
    }));
  })), {
    accept: ({ text, moving, rawModelChip }) => moving === "" && !rawModelChip && !TRANSIENT_TEXT.test(text),
    timeout: 30_000,
  });
}

async function capture(surface: string, theme: Theme, size: Size, options: { keepFocus?: boolean; pointer?: { x: number; y: number } } = {}): Promise<void> {
  const name = `${surface}-${theme}-${size.width}x${size.height}`;
  if (captured.has(name)) throw new Error(`${name} was captured twice.`);
  captured.add(name);
  const pointer = options.pointer ?? { x: Math.min(size.width, WINDOW.width) - 1, y: 0 };
  await page.mouse.move(pointer.x, pointer.y);
  await settle();
  if (!options.keepFocus) {
    await expect.poll(() => page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      return document.activeElement === document.body;
    })).toBe(true);
    await settle();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settledSample();
  }
  await page.screenshot({
    path: join(evidenceDirectory!, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

function heading(title: string): Locator {
  return page.getByRole("heading", { name: title, level: 1 });
}

function finishedTurn(): Locator {
  return page.locator(`[data-turn-id="${seed.turns.finished.id}"]`);
}

function transcript(): Locator {
  return page.getByLabel("Thread transcript", { exact: true });
}

function composerInput(): Locator {
  return page.getByRole("textbox", { name: "Message" });
}

function sidebarRow(chat: VisualChat): Locator {
  return page.getByRole("complementary", { name: "Project navigation", exact: true })
    .getByRole("list", { name: "Work" })
    .getByRole("button", { name: new RegExp(`^${VISUAL_TITLES[chat]}, `, "u") });
}

async function openChat(chat: VisualChat): Promise<void> {
  const title = VISUAL_TITLES[chat];
  if (!await heading(title).isVisible().catch(() => false)) {
    await sidebarRow(chat).click();
    await expect(heading(title)).toBeVisible();
  }
  await expect(composerInput()).toBeVisible();
}

async function scrollTranscript(edge: "top" | "bottom"): Promise<void> {
  await transcript().evaluate((element, target) => {
    element.scrollTop = target === "top" ? 0 : element.scrollHeight;
  }, edge);
  await page.waitForTimeout(200);
  await transcript().evaluate((element, target) => {
    element.scrollTop = target === "top" ? 0 : element.scrollHeight;
  }, edge);
}

async function publishLiveRequests(): Promise<void> {
  await publishCapturedWebSocketEvent(page, { type: "agent.approval.requested", request: seed.approvalRequest });
  await publishCapturedWebSocketEvent(page, { type: "agent.input.requested", request: seed.inputRequest });
}

async function openPanel(name: string): Promise<Locator> {
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, name);
  return panel;
}

async function resetTerminalPrompt(dock: Locator): Promise<void> {
  const rows = dock.locator(".xterm-rows");
  await expect(rows).toContainText(/\S/u, { timeout: 30_000 });
  await expect(rows).not.toContainText("Starting a local terminal", { timeout: 30_000 });
  await dock.locator(".xterm").click();
  const reset = process.platform === "win32" ? ["prompt $$$S", "cls"] : ["PS1='$ '", "clear"];
  for (const command of reset) {
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
  }
  await expect.poll(() => rows.evaluate((element) => (element.textContent ?? "").trim())).toBe("$");
}

/**
 * Composer popovers record the horizontal placement they chose. Main can
 * leave the model chooser at its unanchored CSS position for one measuring
 * pass; a viewport resize makes the app measure again until the popover sits
 * where its own recorded placement says, reopening the popover when a
 * resize alone does not move it.
 */
async function waitForDeclaredPlacement(popover: Locator, trigger: Locator, size: Size): Promise<void> {
  await settle();
  const consistent = async (): Promise<boolean> => {
    const placement = await popover.getAttribute("data-popover-horizontal");
    const box = await popover.boundingBox();
    const anchor = await trigger.boundingBox();
    if (!box || !anchor) return false;
    if (placement === "start") return Math.abs(box.x - anchor.x) <= 1;
    if (placement === "end") return Math.abs(box.x + box.width - anchor.x - anchor.width) <= 1;
    return true;
  };
  for (let attempt = 0; attempt < 8 && !await consistent(); attempt += 1) {
    if (attempt % 2 === 0) {
      await setViewport({ width: size.width, height: size.height - 1 });
      await setViewport(size);
    } else {
      await trigger.click();
      await expect(popover).toHaveCount(0);
      await trigger.click();
      await expect(popover).toBeVisible();
    }
    await settle();
  }
  if (!await consistent()) throw new Error("The popover did not settle where its recorded placement says.");
}

async function settingsSettled(): Promise<void> {
  const content = page.locator(".settings-content");
  await expect(content).toBeVisible();
  await expect(content.locator("[aria-busy='true']")).toHaveCount(0);
  await expect(content).not.toContainText(/Loading .*…/u);
  await content.evaluate((element) => { element.scrollTop = 0; });
}

type SurfaceCapture = (theme: Theme, size: Size) => Promise<void>;

const surfaces: Array<{ name: string; sizes: "wide" | "all"; run: SurfaceCapture }> = [
  {
    name: "welcome",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("welcome");
      await capture("welcome", theme, size);
    },
  },
  {
    name: "sidebar",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("multi");
      const earlier = page.getByRole("button", { name: /^Earlier/u });
      if (await earlier.count() && await earlier.first().getAttribute("aria-expanded") === "false") {
        await earlier.first().click();
      }
      await capture("sidebar", theme, size);
    },
  },
  {
    name: "transcript-running",
    sizes: "all",
    run: async (theme, size) => {
      await openChat("running");
      await scrollTranscript("bottom");
      await capture("transcript-running", theme, size);
    },
  },
  {
    name: "transcript-finished",
    sizes: "all",
    run: async (theme, size) => {
      await openChat("finished");
      await scrollTranscript("bottom");
      await capture("transcript-finished", theme, size);
    },
  },
  {
    name: "transcript-finished-expanded",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      await scrollTranscript("bottom");
      const fold = finishedTurn().locator(".turn-fold-toggle");
      const folded = await fold.count() > 0;
      if (folded) {
        await fold.click();
        await expect(fold).toHaveAttribute("aria-expanded", "true");
        await fold.evaluate((element) => element.scrollIntoView({ block: "start" }));
      }
      await capture("transcript-finished-expanded", theme, size);
      if (folded) {
        await fold.click();
        await expect(fold).toHaveAttribute("aria-expanded", "false");
        await scrollTranscript("bottom");
      }
    },
  },
  {
    name: "transcript-finished-hover",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      await scrollTranscript("bottom");
      const answer = finishedTurn().locator('[data-turn-layer="final-answer"]');
      const box = (await answer.boundingBox())!;
      const bottom = Math.min(box.y + box.height, size.height - 220);
      await capture("transcript-finished-hover", theme, size, {
        pointer: { x: box.x + box.width / 2, y: bottom - 12 },
      });
    },
  },
  {
    name: "transcript-user-hover",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      const request = finishedTurn().getByRole("article", { name: "Your request" });
      await request.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(200);
      const bubble = (await request.boundingBox())!;
      await capture("transcript-user-hover", theme, size, {
        pointer: { x: bubble.x + bubble.width / 2, y: bubble.y + bubble.height / 2 },
      });
    },
  },
  {
    name: "transcript-multi",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("multi");
      await scrollTranscript("top");
      await capture("transcript-multi", theme, size);
    },
  },
  {
    name: "transcript-failed",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("failed");
      await scrollTranscript("bottom");
      await capture("transcript-failed", theme, size);
    },
  },
  {
    name: "transcript-handoff",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("handoff");
      await scrollTranscript("bottom");
      await capture("transcript-handoff", theme, size);
    },
  },
  {
    name: "transcript-approval",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("approval");
      await expect(page.locator('[data-agent-request-state="approval"]')).toBeVisible();
      await scrollTranscript("bottom");
      await capture("transcript-approval", theme, size);
    },
  },
  {
    name: "transcript-question",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("question");
      await expect(page.locator('[data-agent-request-state="question"]')).toBeVisible();
      await scrollTranscript("bottom");
      await capture("transcript-question", theme, size);
    },
  },
  {
    name: "composer",
    sizes: "all",
    run: async (theme, size) => {
      await openChat("finished");
      await scrollTranscript("bottom");
      await capture("composer", theme, size);
    },
  },
  {
    name: "composer-filled",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      await app.electronApp.evaluate(({ dialog }, path) => {
        Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path], bookmarks: [] }));
      }, app.attachmentDocumentPath);
      await page.getByRole("button", { name: "Attach images, documents, or spreadsheets" }).click();
      const attachments = page.getByRole("list", { name: "Attachments" });
      await expect(attachments.getByRole("listitem")).toHaveCount(1);
      await composerInput().fill("Add a short example record to the export format doc, then link it from the README.");
      await scrollTranscript("bottom");
      await capture("composer-filled", theme, size);
      await composerInput().fill("");
      await attachments.getByRole("button", { name: /^Remove/u }).click();
      await expect(attachments).toHaveCount(0);
    },
  },
  {
    name: "composer-queued",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("running");
      await composerInput().fill("When this lands, also check the timeline at 760 wide.");
      await composerInput().press("Tab");
      const queue = page.getByRole("list", { name: "Queued messages" });
      await expect(queue.getByRole("listitem")).toHaveCount(1);
      await scrollTranscript("bottom");
      await capture("composer-queued", theme, size);
      await queue.getByRole("button", { name: "Remove queued message" }).click();
      await expect(queue).toHaveCount(0);
    },
  },
  {
    name: "model-chooser",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      const trigger = page.getByRole("button", { name: /^Choose model\./u });
      const chooser = page.getByRole("dialog", { name: "Choose model" });
      for (let warmUp = 0; warmUp < 3; warmUp += 1) {
        await trigger.click();
        await expect(chooser.getByRole("row").first()).toBeVisible();
        await settle();
        await page.keyboard.press("Escape");
        await expect(chooser).toHaveCount(0);
      }
      await trigger.click();
      await expect(chooser.getByRole("row").first()).toBeVisible();
      await waitForDeclaredPlacement(chooser, page.locator(".model-chooser-anchor .selected-model-chip"), size);
      await capture("model-chooser", theme, size, { keepFocus: true });
      await page.keyboard.press("Escape");
      await expect(chooser).toHaveCount(0);
    },
  },
  {
    name: "command-palette",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      await page.keyboard.press("Control+K");
      const search = page.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
      await expect(search).toBeFocused();
      await search.fill("export");
      await expect(page.getByRole("option").first()).toBeVisible();
      await capture("command-palette", theme, size, { keepFocus: true });
      await page.keyboard.press("Escape");
      await expect(search).toHaveCount(0);
    },
  },
  {
    name: "panel-changes",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      const panel = await openPanel("Changes");
      await panel.getByRole("button", { name: /Button\.tsx/u }).first().click();
      await expect(panel.getByText("Loading diff…")).toHaveCount(0);
      await expect(panel.getByText("data-tone={tone}", { exact: false }).first()).toBeVisible();
      await capture("panel-changes", theme, size);
      await closeWorkspaceTools(page);
    },
  },
  {
    name: "panel-files",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      const panel = await openPanel("Files");
      await expect(panel.getByText("Loading…")).toHaveCount(0);
      await expect(panel.getByText("Checking Git changes…")).toHaveCount(0);
      await panel.getByRole("treeitem", { name: /^sample\.ts/u }).click();
      await expect(panel.getByText("export const ready = true;").first()).toBeVisible();
      await capture("panel-files", theme, size);
      await closeWorkspaceTools(page);
    },
  },
  {
    name: "panel-terminal",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      const dock = await openTerminalDock(page);
      await resetTerminalPrompt(dock);
      await scrollTranscript("bottom");
      await capture("panel-terminal", theme, size);
      await page.locator("[data-panel-layout-controls]").getByRole("button", { name: /^Toggle terminal/u }).click();
      await expect(dock).toBeHidden();
    },
  },
  {
    name: "settings-appearance",
    sizes: "wide",
    run: async (theme, size) => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Appearance", exact: true }).click();
      await settingsSettled();
      await capture("settings-appearance", theme, size);
    },
  },
  {
    name: "settings-chats",
    sizes: "wide",
    run: async (theme, size) => {
      await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Chats", exact: true }).click();
      await settingsSettled();
      await capture("settings-chats", theme, size);
      await page.getByRole("button", { name: "Workspace", exact: true }).click();
      await expect(page.getByRole("main", { name: "Settings" })).toHaveCount(0);
    },
  },
  {
    name: "background-tasks",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("running");
      await openPanel("Background tasks");
      await expect(page.getByRole("region", { name: "Background tasks" })).toBeVisible();
      await capture("background-tasks", theme, size);
      await closeWorkspaceTools(page);
    },
  },
  {
    name: "toast",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("approval");
      const card = page.locator('[data-agent-request-state="approval"]');
      await card.getByRole("button", { name: "Approve once" }).click();
      const toast = page.locator(".status-overlay-stack [role='alert']").first();
      await expect(toast).toBeVisible();
      await capture("toast", theme, size);
      await toast.getByRole("button", { name: /^Dismiss/u }).click();
      await expect(toast).toHaveCount(0);
      await publishLiveRequests();
      await expect(card).toBeVisible();
    },
  },
  {
    name: "dialog-commit",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      await scrollTranscript("bottom");
      await page.getByRole("group", { name: "Git actions" }).getByRole("button", { name: "Commit", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Commit changes" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("main");
      await capture("dialog-commit", theme, size, { keepFocus: true });
      await dialog.getByRole("button", { name: "Close commit dialog" }).click();
      await expect(dialog).toHaveCount(0);
    },
  },
  {
    name: "composer-menu",
    sizes: "wide",
    run: async (theme, size) => {
      await openChat("finished");
      await scrollTranscript("bottom");
      const trigger = page.getByRole("button", { name: /^Choose project access\./u });
      await trigger.click();
      const menu = page.getByRole("menu", { name: "Project access" });
      await expect(menu).toBeVisible();
      await waitForDeclaredPlacement(menu, trigger, size);
      await capture("composer-menu", theme, size, { keepFocus: true });
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    },
  },
];

test.beforeAll(async () => {
  const unknown = [...selectedSurfaces].filter((name) => !surfaces.some((surface) => surface.name === name));
  expect(unknown, "Unknown surfaces in INERTIA_VISUAL_EVIDENCE_SURFACES").toEqual([]);
  test.setTimeout(300_000);
  let history!: ReturnType<typeof seedVisualHistory>;
  app = await createAppFixture({
    name: "visual-evidence",
    initialState: "conversation",
    codexAppServerSource: visualCodexAppServerSource,
    claudeAuthSource: visualClaudeAuthSource,
    additionalEnvironment: { PROMPT: "$$$S" },
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const directories = await prepareVisualWorkspaces({ testDirectory, workspaceDirectory });
      history = seedVisualHistory({ testDirectory, workspaceDirectory, ...directories });
    },
  });
  page = app.page;
  const live = seedVisualLiveTurns({
    testDirectory: app.testDirectory,
    workspaceDirectory: app.workspaceDirectory,
    conversations: history.conversations,
  });
  seed = {
    conversations: history.conversations,
    turns: { ...live.turns, finished: history.turns.finished },
    approvalRequest: live.approvalRequest,
    inputRequest: live.inputRequest,
  };
  await app.resizeWindow(WINDOW.width, WINDOW.height);
  await capturePageWebSockets(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.setFixedTime(VISUAL_FIXED_NOW);
  await page.reload();
  await expect(composerInput()).toBeVisible();
  await expect(heading(VISUAL_TITLES.finished)).toBeVisible();
  await publishLiveRequests();
  await closeWorkspaceTools(page);
});

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !page || page.isClosed()) return;
  const path = testInfo.outputPath("visual-evidence-failure.png");
  await page.screenshot({ path }).catch(() => undefined);
  await testInfo.attach("visual-evidence-failure", { path, contentType: "image/png" }).catch(() => undefined);
  const snapshot = await page.locator("body").ariaSnapshot().catch(() => null);
  if (snapshot) await testInfo.attach("visual-evidence-failure-aria", { body: snapshot, contentType: "text/yaml" });
});

test.afterAll(async () => {
  await app?.close();
});

test("captures the visual evidence set", async () => {
  test.setTimeout(1_800_000);
  await mkdir(evidenceDirectory!, { recursive: true });
  for (const theme of THEMES) {
    await setAppearanceInPlace(app, theme);
    for (const surface of surfaces.filter(({ name }) => selectedSurfaces.size === 0 || selectedSurfaces.has(name))) {
      for (const size of surface.sizes === "all" ? [WIDE, ...EXTRA_SIZES] : [WIDE]) {
        await test.step(`${surface.name} ${theme} ${size.width}x${size.height}`, async () => {
          await setViewport(size);
          await surface.run(theme, size);
        });
      }
    }
  }
  await setViewport(WIDE);
  expect(app.rendererErrors).toEqual([]);
});
