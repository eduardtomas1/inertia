// @inertia-e2e-resource isolated
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";

const FIXED_NOW = Date.parse("2026-09-30T16:20:00.000Z");
const MINUTE = 60_000;

function ago(minutes: number): string {
  return new Date(FIXED_NOW - minutes * MINUTE).toISOString();
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function blurFocus(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function expectLayoutHolds(app: AppFixture): Promise<void> {
  await app.expectNoViewportOverflow();
  await expectComposerEndsAtDock(app.page.getByRole("region", { name: "Message composer" }));
  const nested = await app.page.evaluate(() => [...document.querySelectorAll("button")]
    .filter((button) => button.parentElement?.closest("button")).length);
  expect(nested).toBe(0);
}

async function expectSidebarGeometry(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const left = (selector: string): number | null =>
      document.querySelector(selector)?.getBoundingClientRect().left ?? null;
    return {
      heading: left(".work-thread-section.is-no-project > h2 > span"),
      rowText: left("[data-work-section='no-project'] .activity-thread-title"),
      projectDone: left("[data-work-focus-id='section:done']"),
      noProjectDone: left("[data-work-focus-id='section:no-project-done']"),
      noProjectSnoozed: left("[data-work-focus-id='section:no-project-snoozed']"),
    };
  });
  expect(geometry.heading, JSON.stringify(geometry)).not.toBeNull();
  expect(Math.abs((geometry.heading ?? 0) - (geometry.rowText ?? 0)), JSON.stringify(geometry)).toBeLessThanOrEqual(0.5);
  expect(Math.abs((geometry.projectDone ?? 0) - (geometry.noProjectDone ?? 0)), JSON.stringify(geometry)).toBeLessThanOrEqual(0.5);
  expect(Math.abs((geometry.projectDone ?? 0) - (geometry.noProjectSnoozed ?? 0)), JSON.stringify(geometry)).toBeLessThanOrEqual(0.5);
  const rows = page.locator("[data-work-section^='no-project'] .activity-thread-select");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    await expect(row.locator(".activity-thread-title")).toBeVisible();
    await expect(row).not.toContainText("Chat folder");
    await expect(row).not.toContainText("Local workspace");
  }
}

async function expandSection(page: Page, id: string): Promise<void> {
  const toggle = page.locator(`[data-work-focus-id="section:${id}"]`);
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

interface SeededChats {
  active: string;
}

async function seedSurfaces(testDirectory: string, workspaceDirectory: string, theme: "light" | "dark"): Promise<SeededChats> {
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspaceDirectory);
  const times: Array<[string, string, string | null]> = [];
  let active = "";
  try {
    const scratch = new ScratchWorkspace(store, join(testDirectory, "data"));
    const project = await scratch.ensureProject();
    const [regular, companion] = store.shellSnapshot().conversations;
    if (!regular || !companion) throw new Error("The fixture needs two project chats.");
    store.updateConversation(regular.id, { title: "Release checklist" });
    times.push([regular.id, ago(26), null]);
    store.updateConversation(companion.id, { title: "Review the onboarding copy" });
    times.push([companion.id, ago(70), null]);
    const regularDone = store.createConversation(regular.projectId, "Tidy the changelog", {});
    store.settleConversation(regularDone.id, true);
    times.push([regularDone.id, ago(190), ago(190)]);
    const weekend = await scratch.createConversation(project.id, "Plan a relaxed weekend", {});
    active = weekend.id;
    times.push([weekend.id, ago(4), null]);
    const cafe = await scratch.createConversation(project.id, "Find a quiet café near the station that opens before seven on Sunday mornings", {});
    times.push([cafe.id, ago(48), null]);
    const packing = await scratch.createConversation(project.id, "Draft a packing list", {});
    store.settleConversation(packing.id, true);
    times.push([packing.id, ago(300), ago(300)]);
    const tides = await scratch.createConversation(project.id, "Read about tide tables", {});
    store.updateConversation(tides.id, { snoozedUntil: new Date(Date.now() + 30 * 24 * 60 * MINUTE).toISOString() });
    times.push([tides.id, ago(420), null]);
    store.selectConversation(weekend.id);
    store.updateSettings({ theme });
  } finally {
    store.close();
  }
  const database = new Database(databasePath);
  try {
    const update = database.prepare("UPDATE conversations SET created_at = ?, updated_at = ?, settled_at = COALESCE(?, settled_at) WHERE id = ?");
    for (const [id, at, settledAt] of times) update.run(at, at, settledAt, id);
  } finally {
    database.close();
  }
  return { active };
}

test("shows project-free chats, the selector and the palette entries in both themes", async () => {
  test.setTimeout(240_000);
  const info = test.info();
  let seeded: SeededChats | null = null;
  const app = await createAppFixture({ name: "scratch-appearance", initialState: "conversation", seedSecondProject: true,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      seeded = await seedSurfaces(testDirectory, workspaceDirectory, "light");
    },
  });
  const { page } = app;
  try {
    expect(seeded).not.toBeNull();
    await page.clock.setFixedTime(FIXED_NOW);
    await page.reload();
    await app.resizeWindow(1440, 920);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("heading", { name: "Plan a relaxed weekend", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No project 4", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Chat checkout context" })).toHaveCount(0);
    await expandSection(page, "done");
    await expandSection(page, "no-project-done");
    await expandSection(page, "no-project-snoozed");
    await expect(page.getByRole("button", { name: "Done 1, No project", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "Snoozed 1, No project", exact: true })).toHaveAttribute("aria-expanded", "true");
    await blurFocus(page);
    await expectSidebarGeometry(page);
    await expectLayoutHolds(app);
    await capture(page, info, "no-project-chat-light-wide");
    await setAppearanceInPlace(app, "dark");
    await capture(page, info, "no-project-chat-dark-wide");

    await app.resizeWindow(1000, 800);
    await expectLayoutHolds(app);
    await capture(page, info, "no-project-chat-dark-narrow");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "no-project-chat-light-narrow");
    await setAppearanceInPlace(app, "dark");
    await app.resizeWindow(760, 600);
    await app.expectNoViewportOverflow();
    await capture(page, info, "no-project-chat-dark-760x600");
    await page.getByRole("button", { name: "Toggle project navigation", exact: true }).click();
    await expect(page.locator(".sidebar.is-open")).toBeVisible();
    await page.locator(".sidebar [data-work-section='no-project']").first().scrollIntoViewIfNeeded();
    await blurFocus(page);
    await capture(page, info, "no-project-sidebar-dark-760x600");
    await page.getByRole("button", { name: "Close navigation", exact: true }).first().click();

    await app.resizeWindow(1440, 920);
    await page.getByRole("button", { name: "Start a new chat", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Project", exact: true })).toHaveText("No project");
    await page.getByRole("textbox", { name: "Message" }).fill("Help me plan a relaxed weekend in a new city.");
    await blurFocus(page);
    await expectLayoutHolds(app);
    await capture(page, info, "no-project-draft-dark-wide");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "no-project-draft-light-wide");

    await page.getByRole("button", { name: "Project", exact: true }).click();
    const noProject = page.getByRole("option", { name: "No project", exact: true });
    await expect(noProject).toHaveAttribute("aria-selected", "true");
    await expect(noProject).toHaveAccessibleDescription("Start in a separate local folder");
    await capture(page, info, "no-project-picker-light-wide");
    await setAppearanceInPlace(app, "dark");
    await capture(page, info, "no-project-picker-dark-wide");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("option", { name: "No project", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Filter work by project", exact: true }).click();
    await expect(page.getByRole("option", { name: "No project", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await app.resizeWindow(1000, 800);
    await blurFocus(page);
    await expectLayoutHolds(app);
    await capture(page, info, "no-project-draft-dark-narrow");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "no-project-draft-light-narrow");

    await app.resizeWindow(1440, 920);
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const chooser = page.getByRole("dialog", { name: "New chat in project" });
    await expect(chooser.getByRole("option", { name: /^No project/u })).toBeVisible();
    await capture(page, info, "no-project-new-chat-chooser-light-wide");
    await setAppearanceInPlace(app, "dark");
    await capture(page, info, "no-project-new-chat-chooser-dark-wide");
    await page.keyboard.press("Escape");
    await expect(chooser).toHaveCount(0);

    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    const palette = page.getByRole("dialog", { name: "Search Inertia" });
    await expect(palette.getByRole("option", { name: /^Start without a project/u })).toBeVisible();
    await expect(palette.locator("[role='option'] strong").first()).toHaveText("New chat");
    await capture(page, info, "no-project-palette-dark-wide");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "no-project-palette-light-wide");
    await page.keyboard.press("Escape");
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

test("offers a project-free chat on the first-run screen", async () => {
  const info = test.info();
  const app = await createAppFixture({ name: "scratch-first-run", initialState: "empty" });
  const { page } = app;
  try {
    await page.clock.setFixedTime(FIXED_NOW);
    await app.resizeWindow(1440, 920);
    const start = page.getByRole("button", { name: "Start without a project", exact: true });
    await expect(start).toBeVisible();
    await app.expectNoViewportOverflow();
    await capture(page, info, "no-project-first-run-light-wide");
    await setAppearanceInPlace(app, "dark");
    await capture(page, info, "no-project-first-run-dark-wide");
    await app.resizeWindow(1000, 800);
    await app.expectNoViewportOverflow();
    await capture(page, info, "no-project-first-run-dark-narrow");
    await app.resizeWindow(1440, 920);
    await start.click();
    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Project", exact: true })).toHaveText("No project");
    await expect(page.locator(".chat-workspace .loading-mark")).toHaveCount(0);
    await blurFocus(page);
    await expectLayoutHolds(app);
    await capture(page, info, "no-project-first-draft-dark-wide");
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
