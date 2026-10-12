// @inertia-e2e-resource isolated
import { expect, test, type TestInfo } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const FIXED_NOW = Date.parse("2026-10-12T12:00:00.000Z");

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "tasks", initialState: "conversation" });
  await app.page.clock.setFixedTime(FIXED_NOW);
});

test.afterAll(async () => {
  await app.close();
});

async function capture(info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await app.page.mouse.move(0, 0);
  await app.page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("adds, orders, schedules and finishes tasks from the sidebar", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  const destination = page.locator(".sidebar-primary-row").getByRole("button", { name: "Tasks", exact: true });
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");
  const view = page.getByRole("main", { name: "Tasks" });
  await expect(view.getByText("Add anything you need to do", { exact: true })).toBeVisible();
  await expect(page.locator(".workspace-header")).toContainText("Tasks");

  const add = view.getByRole("textbox", { name: "Add a task" });
  await add.fill("Implement remote control");
  await add.press("Enter");
  await expect(add).toHaveValue("");
  await expect(add).toBeFocused();
  await add.fill("Clean the downloads folder");
  await add.press("Enter");
  await expect(view.getByText("2 to do", { exact: true })).toBeVisible();
  const list = view.getByRole("list", { name: "To do" });
  await expect(list.getByRole("checkbox")).toHaveCount(2);
  await expect(list.getByRole("checkbox").first()).toHaveAttribute("aria-label", "Implement remote control");

  await view.getByRole("button", { name: /^Clean the downloads folder/u }).click();
  const detail = view.getByRole("complementary", { name: "Task details" });
  await expect(detail.getByRole("textbox", { name: "Title" })).toHaveValue("Clean the downloads folder");
  await expect(detail.getByRole("group", { name: "Hand it to an agent" })).toBeVisible();

  await detail.getByRole("button", { name: "Priority", exact: true }).click();
  await page.getByRole("menu", { name: "Priority" }).getByRole("menuitemradio", { name: "Urgent", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  await expect(list.getByRole("checkbox").first()).toHaveAttribute("aria-label", "Clean the downloads folder");
  await expect(list.locator(".task-row").first().locator(".task-urgent")).toBeVisible();

  await detail.getByRole("button", { name: "Due date", exact: true }).click();
  await page.getByRole("menu", { name: "Due date" }).getByRole("menuitemradio", { name: "Tomorrow", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Due date: Tomorrow" })).toBeVisible();
  await expect(list.locator(".task-row").first()).toContainText("Tomorrow");

  const note = detail.getByRole("textbox", { name: "Note" });
  await note.fill("Only the CleanShot files");
  await note.press("Tab");
  await detail.getByRole("button", { name: "Close task details" }).click();
  await expect(detail).toBeHidden();
  await view.getByRole("button", { name: /^Clean the downloads folder/u }).click();
  await expect(detail.getByRole("textbox", { name: "Note" })).toHaveValue("Only the CleanShot files");

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    await app.expectNoViewportOverflow();
    await capture(info, `tasks-detail-${theme}-1440x1100`);
  }

  await app.resizeWindow(760, 600);
  await expect(detail).toBeVisible();
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    await app.expectNoViewportOverflow();
    await capture(info, `tasks-detail-${theme}-760x600`);
  }

  await app.resizeWindow(1440, 1100);
  await view.getByRole("checkbox", { name: "Implement remote control" }).click();
  await expect(view.getByText("1 to do", { exact: true })).toBeVisible();
  const done = view.getByRole("button", { name: "Done 1", exact: true });
  await expect(done).toHaveAttribute("aria-expanded", "false");
  await done.click();
  await expect(view.getByRole("list", { name: "Done" }).getByRole("checkbox", { name: "Implement remote control" })).toBeChecked();

  await view.locator(".task-row").first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Clean the downloads folder" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Rename", "Hand to agent…", "Mark as done", "Delete"]);
  await capture(info, "tasks-row-menu-light-1440x1100");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  expect(app.rendererErrors).toEqual([]);
});

test.skip("Start hands the task to an agent", async () => {
  const page = app.page;
  const view = page.getByRole("main", { name: "Tasks" });
  await view.getByRole("button", { name: /^Clean the downloads folder/u }).click();
  const agent = view.getByRole("group", { name: "Hand it to an agent" });
  await agent.getByRole("button", { name: "Start", exact: true }).click();
  await expect(view).toBeHidden();
  await expect(page.locator(".workspace-header")).toContainText("Clean the downloads folder");
});
