import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, loadavg, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { createAppFixture, type AppFixture } from "../e2e/support/app-fixture";
import { rightPanelToggle } from "../e2e/support/workspace-tools";
import {
  armScreenOpen,
  disarmScreenOpen,
  installScreenOpenProbe,
  readScreenOpen,
  summarizeScreenOpen,
  type ScreenOpenSample,
  type ScreenOpenStart,
  type ScreenOpenTarget,
} from "../helpers/screen-open-probe";
import { createScreenOpenProfiler, type ScreenOpenProfiler } from "../helpers/screen-open-profile";
import {
  SCREEN_OPEN_LONG_CHAT,
  SCREEN_OPEN_LONG_TURNS,
  SCREEN_OPEN_SHORT_CHAT,
  SCREEN_OPEN_SHORT_TURNS,
  screenOpenAnswer,
  seedScreenOpenFixture,
} from "../helpers/screen-open-seed";

const RUNS = Number.parseInt(process.env.INERTIA_SCREEN_OPEN_RUNS ?? "5", 10);
const PROFILE = process.env.INERTIA_SCREEN_OPEN_PROFILE === "1";
const ONLY = process.env.INERTIA_SCREEN_OPEN_ONLY?.split(",").filter(Boolean) ?? null;
const GIT_TRACE = process.env.INERTIA_SCREEN_OPEN_GIT_TRACE === "1";
const OUTPUT = resolve(process.env.INERTIA_SCREEN_OPEN_OUTPUT ?? "performance-results/screen-open");
const IDLE_BEFORE_FIRST_OPEN_MS = 2_000;
const HOME_CHAT = "screen-open fixture";
const SETTINGS_SECTIONS = [
  "Chats",
  "Custom agents",
  "Notifications",
  "Keyboard",
  "Projects",
  "Agents",
  "Devices & integrations",
  "Data",
  "Help",
] as const;

interface ScreenStep {
  id: string;
  start: ScreenOpenStart;
  target: ScreenOpenTarget;
  prepare?: (page: Page) => Promise<void>;
  act: (page: Page) => Promise<void>;
  reset: (page: Page) => Promise<void>;
}

interface StepResult {
  id: string;
  cold: ScreenOpenSample | null;
  warm: ScreenOpenSample | null;
  error?: string;
}

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "Project navigation" });
}

function sidebarChat(page: Page, title: string) {
  return sidebar(page).locator(".activity-thread-select").filter({ hasText: title }).first();
}

async function settle(page: Page, minimumMs = 300): Promise<void> {
  await page.waitForTimeout(minimumMs);
  await page.evaluate(() => new Promise<void>((resolveIdle) => {
    requestIdleCallback(() => resolveIdle(), { timeout: 2_000 });
  }));
}

async function selectChat(page: Page, title: string): Promise<void> {
  await sidebarChat(page, title).click();
  await expect(page.locator(".workspace-header").getByRole("button", { name: title, exact: true }))
    .toBeVisible();
}

async function backToWorkspace(page: Page): Promise<void> {
  await page.locator(".sidebar-footer").getByRole("button", { name: "Workspace", exact: true }).click();
  await page.locator(".chat-workspace").first().waitFor();
}

async function closeDialog(page: Page, selector: string): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator(selector)).toHaveCount(0);
}

async function openSettings(page: Page): Promise<void> {
  if (await page.locator(".settings-view").isVisible().catch(() => false)) return;
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-view").waitFor();
}

async function settingsSection(page: Page, label: string): Promise<void> {
  await page.getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator(".settings-view .settings-page-title")).toHaveText(label);
}

function workspaceTools(page: Page) {
  return page.getByRole("complementary", { name: "Workspace tools" });
}

async function ensurePanelLauncher(page: Page): Promise<void> {
  const toggle = rightPanelToggle(page);
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await workspaceTools(page).getByRole("group", { name: "Open a surface" }).waitFor();
}

async function closePanelSurface(page: Page, label: string): Promise<void> {
  await workspaceTools(page).getByRole("button", { name: `Close ${label}`, exact: true }).click();
  await expect(page.getByRole("tab", { name: label, exact: true })).toHaveCount(0);
}

async function closeRightPanel(page: Page): Promise<void> {
  const toggle = rightPanelToggle(page);
  if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(workspaceTools(page)).toBeHidden();
}

function terminalToggle(page: Page) {
  return page.locator("[data-panel-layout-controls]").getByRole("button", { name: /^Toggle terminal/u });
}

const pointer: ScreenOpenStart = { kind: "pointer" };

const steps: ScreenStep[] = [
  {
    id: "chat-switch-short",
    start: pointer,
    target: { selector: ".message-scroll", text: screenOpenAnswer(SCREEN_OPEN_SHORT_CHAT, SCREEN_OPEN_SHORT_TURNS - 1) },
    act: async (page) => await sidebarChat(page, SCREEN_OPEN_SHORT_CHAT).click(),
    reset: async (page) => await selectChat(page, HOME_CHAT),
  },
  {
    id: "chat-switch-long",
    start: pointer,
    target: { selector: ".message-scroll", text: screenOpenAnswer(SCREEN_OPEN_LONG_CHAT, SCREEN_OPEN_LONG_TURNS - 1) },
    act: async (page) => await sidebarChat(page, SCREEN_OPEN_LONG_CHAT).click(),
    reset: async (page) => await selectChat(page, HOME_CHAT),
  },
  {
    id: "home-new-chat",
    start: pointer,
    target: { selector: ".workspace-header", text: "New chat" },
    act: async (page) => await sidebar(page).getByRole("button", { name: "Start a new chat", exact: true }).click(),
    reset: async (page) => await selectChat(page, HOME_CHAT),
  },
  {
    id: "settings",
    start: pointer,
    target: { selector: ".settings-view .settings-content", text: "Appearance", ready: "settled" },
    act: async (page) => await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click(),
    reset: backToWorkspace,
  },
  ...SETTINGS_SECTIONS.map((label): ScreenStep => ({
    id: `settings-${label.toLowerCase().replace(/[^a-z]+/gu, "-")}`,
    start: pointer,
    target: { selector: ".settings-view .settings-content", text: label, ready: label === "Agents" ? "visible" : "settled" },
    prepare: async (page) => {
      await openSettings(page);
      await settingsSection(page, "Appearance");
    },
    act: async (page) => await page.getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: label, exact: true }).click(),
    reset: async (page) => await settingsSection(page, "Appearance"),
  })),
  {
    id: "settings-exit",
    start: pointer,
    target: { selector: ".chat-workspace .message-scroll" },
    prepare: openSettings,
    act: async (page) => await page.locator(".sidebar-footer").getByRole("button", { name: "Workspace", exact: true }).click(),
    reset: async () => undefined,
  },
  {
    id: "usage",
    start: pointer,
    target: { selector: ".usage-view", ready: "settled" },
    act: async (page) => await page.locator(".sidebar-footer").getByRole("button", { name: "Usage", exact: true }).click(),
    reset: backToWorkspace,
  },
  {
    id: "usage-limits-tab",
    start: pointer,
    target: { selector: ".usage-view .usage-canvas", text: "Refresh limits", ready: "settled" },
    prepare: async (page) => {
      await page.locator(".sidebar-footer").getByRole("button", { name: "Usage", exact: true }).click();
      await page.locator(".usage-view:not([aria-busy='true'])").waitFor();
    },
    act: async (page) => await page.getByRole("group", { name: "Usage section" })
      .getByRole("button", { name: "Limits", exact: true }).click(),
    reset: async (page) => {
      await page.getByRole("group", { name: "Usage section" })
        .getByRole("button", { name: "History", exact: true }).click();
      await backToWorkspace(page);
    },
  },
  {
    id: "limits-dialog",
    start: pointer,
    target: { selector: ".limits-dialog", text: "Refresh limits", ready: "settled" },
    prepare: async (page) => {
      await page.locator(".usage-popover-trigger").first().click();
      await page.getByRole("button", { name: "All provider limits", exact: true }).waitFor();
    },
    act: async (page) => await page.getByRole("button", { name: "All provider limits", exact: true }).click(),
    reset: async (page) => await closeDialog(page, ".limits-dialog"),
  },
  {
    id: "tasks",
    start: pointer,
    target: { selector: ".tasks-view", ready: "settled" },
    act: async (page) => await sidebar(page).getByRole("button", { name: "Tasks", exact: true }).click(),
    reset: backToWorkspace,
  },
  {
    id: "command-palette",
    start: { kind: "key", key: "k" },
    target: { selector: '.command-palette[role="dialog"]', ready: "settled" },
    act: async (page) => await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K"),
    reset: async (page) => await closeDialog(page, ".command-palette"),
  },
  {
    id: "daily-work",
    start: pointer,
    target: { selector: ".daily-work-dialog", ready: "settled" },
    act: async (page) => await page.locator(".sidebar-footer").getByRole("button", { name: "Daily work", exact: true }).click(),
    reset: async (page) => await closeDialog(page, ".daily-work-dialog"),
  },
  {
    id: "help",
    start: pointer,
    target: { selector: '.help-guide[role="dialog"]', ready: "settled" },
    act: async (page) => await page.locator(".sidebar-footer").getByRole("button", { name: "Help", exact: true }).click(),
    reset: async (page) => await closeDialog(page, ".help-guide"),
  },
  {
    id: "right-panel",
    start: pointer,
    target: { selector: ".workspace-panel", ready: "settled" },
    act: async (page) => await rightPanelToggle(page).click(),
    reset: closeRightPanel,
  },
  {
    id: "panel-changes",
    start: pointer,
    target: { selector: '.workspace-panel [role="tabpanel"][aria-label="Changes panel"]', text: "sample.ts", ready: "settled" },
    prepare: ensurePanelLauncher,
    act: async (page) => await workspaceTools(page).getByRole("group", { name: "Open a surface" })
      .getByRole("button", { name: /^Changes/u }).click(),
    reset: async (page) => await closePanelSurface(page, "Changes"),
  },
  {
    id: "panel-files",
    start: pointer,
    target: { selector: '.workspace-panel [role="tree"][aria-label="Files"] [role="treeitem"]', ready: "settled" },
    prepare: ensurePanelLauncher,
    act: async (page) => await workspaceTools(page).getByRole("group", { name: "Open a surface" })
      .getByRole("button", { name: /^Files/u }).click(),
    reset: async (page) => {
      await closePanelSurface(page, "Files");
      await closeRightPanel(page);
    },
  },
  {
    id: "terminal",
    start: pointer,
    target: { selector: ".terminal-dock .terminal-panel[data-terminal-id] .xterm-screen" },
    act: async (page) => await terminalToggle(page).click(),
    reset: async (page) => {
      const dock = page.locator(".workspace-chat-column > .terminal-dock");
      await dock.getByRole("button", { name: /^Close Terminal \d+$/u }).first().click();
      await expect(page.locator(".terminal-panel[data-terminal-id]")).toHaveCount(0, { timeout: 15_000 });
      await expect(terminalToggle(page)).toHaveAttribute("aria-pressed", "false");
    },
  },
  {
    id: "model-chooser",
    start: pointer,
    target: { selector: '[role="dialog"][aria-label="Choose model"]', ready: "settled" },
    act: async (page) => await page.getByRole("button", { name: /^Choose model\./u }).first().click(),
    reset: async (page) => await closeDialog(page, '[role="dialog"][aria-label="Choose model"]'),
  },
];

async function measureStep(
  page: Page,
  step: ScreenStep,
  profiler: ScreenOpenProfiler | null,
  name: string,
): Promise<ScreenOpenSample> {
  await step.prepare?.(page);
  await settle(page);
  await armScreenOpen(page, step.start, step.target);
  try {
    await profiler?.begin();
    await step.act(page);
    const observation = await readScreenOpen(page);
    await profiler?.end(name);
    return summarizeScreenOpen(observation);
  } catch (error) {
    await disarmScreenOpen(page);
    throw error;
  } finally {
    await step.reset(page);
    await settle(page);
  }
}

async function installDetachedPaintWatcher(app: AppFixture, text: string): Promise<void> {
  await app.page.context().addInitScript((expectedText) => {
    const scope = globalThis as typeof globalThis & {
      __detachedPaint?: Promise<number>;
      __detachedMilestones?: Record<string, number>;
    };
    const milestones: Record<string, number> = {};
    scope.__detachedMilestones = milestones;
    const stamp = (name: string): void => {
      milestones[name] ??= performance.now();
    };
    scope.__detachedPaint = new Promise<number>((resolvePaint) => {
      const ready = (): boolean => {
        const shell = document.querySelector(".detached-chat-shell");
        if (!shell) return false;
        stamp("shell");
        if (!shell.querySelector(".detached-chat-loading")) stamp("snapshot");
        if (shell.querySelector(".chat-workspace")) stamp("chatWorkspace");
        if (shell.querySelector(".message-scroll")) stamp("messageScroll");
        return (shell.textContent ?? "").includes(expectedText)
          && shell.querySelector('[aria-busy="true"]') === null;
      };
      const finish = (): void => {
        stamp("content");
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolvePaint(performance.timeOrigin + performance.now());
        }));
      };
      const observe = (): void => {
        if (ready()) {
          finish();
          return;
        }
        const observer = new MutationObserver(() => {
          if (!ready()) return;
          observer.disconnect();
          finish();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      };
      if (document.documentElement) observe();
      else document.addEventListener("DOMContentLoaded", observe, { once: true });
    });
  }, text);
}

async function measureDetachedWindow(app: AppFixture, title: string, lastText: string) {
  const page = app.page;
  await selectChat(page, title);
  await settle(page);
  await page.locator(".workspace-header").getByRole("button", { name: title, exact: true }).click();
  const item = page.getByRole("menuitem", { name: "Open chat in new window" });
  await item.waitFor();
  const inputAt = page.evaluate(() => new Promise<number>((resolveInput) => {
    window.addEventListener("pointerdown", (event) => {
      resolveInput(performance.timeOrigin + event.timeStamp);
    }, { capture: true, once: true });
  }));
  const opened = app.electronApp.waitForEvent("window");
  await item.click();
  const popup = await opened;
  const popupTiming = await popup.evaluate(async () => {
    const scope = globalThis as typeof globalThis & {
      __detachedPaint?: Promise<number>;
      __detachedMilestones?: Record<string, number>;
    };
    if (!scope.__detachedPaint) throw new Error("The detached paint watcher is missing.");
    const paintedAt = await scope.__detachedPaint;
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const contentful = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      paintedAt,
      timeOrigin: performance.timeOrigin,
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      loadMs: navigation?.loadEventEnd ?? null,
      firstContentfulPaintMs: contentful?.startTime ?? null,
      milestones: scope.__detachedMilestones ?? {},
    };
  });
  await expect(popup.locator(".detached-chat-shell")).toContainText(lastText);
  const input = await inputAt;
  const round = (value: number | null) => value === null ? null : Number(value.toFixed(1));
  const breakdown = {
    inputToPaintMs: round(popupTiming.paintedAt - input),
    inputToNavigationStartMs: round(popupTiming.timeOrigin - input),
    navigationToDomContentLoadedMs: round(popupTiming.domContentLoadedMs),
    navigationToFirstContentfulPaintMs: round(popupTiming.firstContentfulPaintMs),
    navigationToContentPaintMs: round(popupTiming.paintedAt - popupTiming.timeOrigin),
    navigationMilestonesMs: Object.fromEntries(Object.entries(popupTiming.milestones)
      .map(([name, value]) => [name, round(value)])),
  };
  await Promise.all([
    popup.waitForEvent("close"),
    app.electronApp.evaluate(({ BrowserWindow }, expectedTitle) => {
      const window = BrowserWindow.getAllWindows()
        .find((candidate) => candidate.getTitle().startsWith(expectedTitle));
      if (!window) throw new Error("Detached window is missing");
      window.close();
    }, title),
  ]);
  await page.getByRole("button", { name: "Open chat here" }).click();
  await expect(page.getByRole("textbox", { name: "Message" }).first()).toBeVisible();
  await selectChat(page, HOME_CHAT);
  await settle(page);
  return breakdown;
}

test.describe.configure({ mode: "serial" });

for (let run = 1; run <= (PROFILE ? 1 : RUNS); run += 1) {
  test(`screen opens run ${run}${PROFILE ? " (profiled)" : ""}`, async () => {
    test.setTimeout(600_000);
    const directory = PROFILE ? join(OUTPUT, "profiles") : OUTPUT;
    await mkdir(directory, { recursive: true });
    const loadBefore = loadavg();
    const gitTracePath = join(directory, `run-${run}-git-trace2.jsonl`);
    const gitConfigPath = join(directory, `run-${run}-git-trace2.gitconfig`);
    if (GIT_TRACE) await writeFile(gitConfigPath, `[trace2]\n\teventTarget = ${gitTracePath}\n\teventBrief = false\n`);
    const app = await createAppFixture({
      name: "screen-open",
      initialState: "conversation",
      seedSecondProject: true,
      ...(GIT_TRACE ? { additionalEnvironment: { GIT_CONFIG_GLOBAL: gitConfigPath } } : {}),
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        seedScreenOpenFixture(testDirectory, workspaceDirectory);
      },
    });
    let profiler: ScreenOpenProfiler | null = null;
    try {
      const page = app.page;
      await app.resizeWindow(1440, 900);
      await installScreenOpenProbe(page);
      await installDetachedPaintWatcher(app, screenOpenAnswer(SCREEN_OPEN_SHORT_CHAT, SCREEN_OPEN_SHORT_TURNS - 1));
      if (PROFILE) profiler = await createScreenOpenProfiler(page, directory);
      await selectChat(page, HOME_CHAT);
      await page.waitForTimeout(IDLE_BEFORE_FIRST_OPEN_MS);
      await settle(page);
      const results: StepResult[] = [];
      for (const step of steps) {
        if (ONLY && !ONLY.includes(step.id)) continue;
        const result: StepResult = { id: step.id, cold: null, warm: null };
        try {
          result.cold = await measureStep(page, step, profiler, `${step.id}-cold`);
          result.warm = await measureStep(page, step, profiler, `${step.id}-warm`);
        } catch (error) {
          result.error = error instanceof Error ? error.message.split("\n").slice(0, 6).join("\n") : String(error);
          await page.screenshot({ path: join(directory, `run-${run}-${step.id}-failure.png`) }).catch(() => undefined);
          await page.keyboard.press("Escape").catch(() => undefined);
          if (await page.locator(".settings-view, .usage-view, .tasks-view").count() > 0) {
            await backToWorkspace(page).catch(() => undefined);
          }
          await selectChat(page, HOME_CHAT).catch(() => undefined);
          await settle(page).catch(() => undefined);
        }
        results.push(result);
      }
      let detached: {
        cold: Awaited<ReturnType<typeof measureDetachedWindow>> | null;
        warm: Awaited<ReturnType<typeof measureDetachedWindow>> | null;
        error?: string;
      } = { cold: null, warm: null };
      if (!ONLY || ONLY.includes("detached-window")) {
        try {
          detached = {
            cold: await measureDetachedWindow(app, SCREEN_OPEN_SHORT_CHAT, screenOpenAnswer(SCREEN_OPEN_SHORT_CHAT, SCREEN_OPEN_SHORT_TURNS - 1)),
            warm: await measureDetachedWindow(app, SCREEN_OPEN_SHORT_CHAT, screenOpenAnswer(SCREEN_OPEN_SHORT_CHAT, SCREEN_OPEN_SHORT_TURNS - 1)),
          };
        } catch (error) {
          detached.error = error instanceof Error ? error.message.split("\n").slice(0, 6).join("\n") : String(error);
        }
      }
      const report = {
        run,
        profiled: PROFILE,
        recordedAt: new Date().toISOString(),
        host: {
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model ?? null,
          cpuCount: cpus().length,
          totalMemoryGb: Number((totalmem() / 2 ** 30).toFixed(1)),
          loadBefore,
          loadAfter: loadavg(),
          node: process.version,
        },
        fixture: {
          longChatTurns: SCREEN_OPEN_LONG_TURNS,
          shortChatTurns: SCREEN_OPEN_SHORT_TURNS,
          projects: 2,
        },
        steps: results,
        detachedWindow: detached,
        rendererErrors: app.rendererErrors.slice(0, 20),
      };
      await writeFile(join(directory, `run-${run}.json`), `${JSON.stringify(report, null, 2)}\n`);
      expect(results.filter((result) => result.error), JSON.stringify(results.filter((result) => result.error), null, 2))
        .toEqual([]);
      expect(detached.error ?? null).toBeNull();
    } finally {
      await profiler?.dispose();
      await app.close();
    }
  });
}
