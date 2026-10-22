// @inertia-e2e-resource isolated
import { expect, test, type Locator } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import type { TodoPriority } from "../../src/shared/todos";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

const FIXED_NOW = Date.parse("2026-10-12T12:00:00.000Z");
const SEEDED_TASKS = 41;
const PRIORITIES: readonly (TodoPriority | null)[] = [null, null, "low", null, "medium", null, "high", null];
const DUE_DATES: readonly (string | null)[] = [null, "2026-10-13", null, "2026-10-20", null, null, "2026-11-02", null];

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "tasks-layout",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      try {
        for (let index = 0; index < SEEDED_TASKS; index += 1) {
          store.todos.create({
            id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            title: `Seeded task ${String(index + 1).padStart(2, "0")}: review the quarterly figures`,
            note: "",
            priority: PRIORITIES[index % PRIORITIES.length]!,
            dueDate: DUE_DATES[index % DUE_DATES.length]!,
            dueTime: null,
            projectId: null,
          });
        }
      } finally {
        store.close();
      }
    },
  });
  const session = await app.page.context().newCDPSession(app.page);
  await session.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
  await app.page.clock.setFixedTime(FIXED_NOW);
});

test.afterAll(async () => {
  await app?.close();
});

function todoExists(id: string): boolean {
  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return database.prepare("SELECT 1 FROM todos WHERE id = ?").get(id) !== undefined;
  } finally {
    database.close();
  }
}

async function openTasks(): Promise<Locator> {
  const destination = app.page.locator(".sidebar .sidebar-tasks-action");
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");
  return app.page.getByRole("main", { name: "Tasks" });
}

async function rowIds(list: Locator): Promise<string[]> {
  return list.locator(".task-row-slot:not(.is-collapsing)").evaluateAll((slots) =>
    slots.map((slot) => slot.getAttribute("data-task-id") ?? ""));
}

function titleOf(view: Locator, id: string): Locator {
  return view.locator(`[data-task-title="${id}"]`);
}

async function expectInViewport(locator: Locator): Promise<void> {
  const box = (await locator.boundingBox())!;
  const height = await app.page.evaluate(() => window.innerHeight);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
}

test("a narrow window opens a task as a sub-view and Close returns to the list", async ({ browserName: _browserName }) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  const view = await openTasks();
  await app.resizeWindow(700, 700);
  await expect(view.locator(".tasks-heading p")).toHaveText(`${SEEDED_TASKS} to do`);
  const list = view.getByRole("list", { name: "To do" });
  await expect(list.getByRole("checkbox")).toHaveCount(SEEDED_TASKS);
  const ids = await rowIds(list);
  const target = ids[30]!;
  const title = titleOf(view, target);
  const titleText = (await title.locator(".task-title-text").textContent())!;
  await title.scrollIntoViewIfNeeded();
  expect(await view.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await title.click();

  const detail = view.getByRole("complementary", { name: "Task details" });
  const main = view.locator(".tasks-main");
  await expect(detail.getByRole("textbox", { name: "Title" })).toHaveValue(titleText);
  await expect(main).toBeHidden();
  expect(await view.evaluate((element) => element.scrollTop)).toBe(0);
  const viewBox = (await view.boundingBox())!;
  const detailBox = (await detail.boundingBox())!;
  expect(detailBox.y - viewBox.y).toBeGreaterThanOrEqual(0);
  expect(detailBox.y - viewBox.y).toBeLessThanOrEqual(48);
  await expectInViewport(detail.getByRole("textbox", { name: "Title" }));
  await expectInViewport(detail.getByRole("button", { name: "Close task details" }));
  await app.expectNoViewportOverflow();
  await expect(detail.getByRole("button", { name: "Close task details" })).toBeFocused();

  await detail.getByRole("button", { name: "Close task details" }).click();
  await expect(detail).toBeHidden();
  await expect(main).toBeVisible();
  await expect(title).toBeFocused();
  await expectInViewport(title);

  await page.keyboard.press("Enter");
  await expect(detail.getByRole("textbox", { name: "Title" })).toHaveValue(titleText);
  await expect(main).toBeHidden();
  await expect(detail.getByRole("button", { name: "Close task details" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(main).toBeVisible();
  await expect(title).toBeFocused();
  await expectInViewport(title);
  expect(app.rendererErrors).toEqual([]);
});

test("rows answer arrows, Space, Delete and Undo", async ({ browserName: _browserName }) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  await page.locator(".sidebar").getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("main", { name: "Tasks" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+t");
  const view = page.getByRole("main", { name: "Tasks" });
  const open = view.getByRole("list", { name: "To do" });
  const add = view.getByRole("textbox", { name: "Add a task" });
  await expect(add).toBeFocused();
  await open.locator(".task-title").first().focus();
  await page.keyboard.press("ControlOrMeta+t");
  await expect(add).toBeFocused();

  const ids = await rowIds(open);
  const [first, second, third, fourth] = ids;
  await page.keyboard.press("ArrowUp");
  await expect(titleOf(view, ids.at(-1)!)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(titleOf(view, first!)).toBeFocused();
  await expect(open.locator("[data-task-title][tabindex='0']")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(titleOf(view, second!)).toBeFocused();
  await expect(titleOf(view, second!)).toHaveAttribute("tabindex", "0");
  await expect(titleOf(view, first!)).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("ArrowUp");
  await expect(titleOf(view, first!)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(titleOf(view, first!)).toBeFocused();
  await page.keyboard.press("End");
  await expect(titleOf(view, ids.at(-1)!)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(add).toBeFocused();
  await titleOf(view, first!).focus();
  await page.keyboard.press("ArrowDown");
  await expect(titleOf(view, second!)).toBeFocused();

  const secondSlot = open.locator(`[data-task-id="${second}"]`);
  const pressedAt = Date.now();
  await page.keyboard.press("Space");
  await expect(secondSlot.getByRole("checkbox")).toBeChecked();
  await expect(secondSlot).toHaveClass(/\bis-completing\b/u);
  await expect(titleOf(view, third!)).toBeFocused();
  await expect(secondSlot).toHaveCount(0);
  expect(Date.now() - pressedAt).toBeGreaterThanOrEqual(400);
  await expect(view.locator(".tasks-done-toggle")).toHaveText("Done 1");
  await expect(view.locator(".tasks-heading p")).toHaveText(`${SEEDED_TASKS - 1} to do`);
  await view.locator(".tasks-done-toggle").click();
  await expect(view.getByRole("list", { name: "Done" }).locator(`[data-task-id="${second}"]`).getByRole("checkbox")).toBeChecked();
  await view.locator(".tasks-done-toggle").click();

  await titleOf(view, third!).focus();
  const toast = view.getByRole("status").filter({ hasText: "Deleted" });
  const thirdTitle = (await titleOf(view, third!).locator(".task-title-text").textContent())!;
  await page.keyboard.press("Delete");
  await expect(open.locator(`[data-task-id="${third}"]`)).toHaveCount(0);
  await expect(titleOf(view, fourth!)).toBeFocused();
  await expect(toast).toHaveText(new RegExp(`Deleted “${thirdTitle}”`, "u"));
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(open.locator(`[data-task-id="${third}"]`)).toHaveCount(1);
  await expect(titleOf(view, third!)).toBeFocused();
  await expect(toast).toHaveCount(0);
  expect(todoExists(third!)).toBe(true);

  await page.keyboard.press("Backspace");
  await expect(open.locator(`[data-task-id="${third}"]`)).toHaveCount(0);
  await expect(toast).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(open.locator(`[data-task-id="${third}"]`)).toHaveCount(1);
  await expect(titleOf(view, third!)).toBeFocused();
  expect(todoExists(third!)).toBe(true);
  await expect(view.locator(".tasks-heading p")).toHaveText(`${SEEDED_TASKS - 1} to do`);
  expect(app.rendererErrors).toEqual([]);
});
